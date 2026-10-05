import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = mkdtempSync(join(tmpdir(), 'helm-active-inventory-'));
const data = join(root, 'data');
const cwd = join(root, 'project');
const bin = join(root, 'opencode');
mkdirSync(join(data, 'opencode'), { recursive: true });
mkdirSync(cwd, { recursive: true });
writeFileSync(bin, `#!/usr/bin/env node
console.log('ready');
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`);
chmodSync(bin, 0o755);

const db = new DatabaseSync(join(data, 'opencode', 'opencode.db'));
db.exec(`CREATE TABLE session (
  id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_updated INTEGER,
  agent TEXT, model TEXT
)`);
db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run('old', 'Old', cwd, 1, null, null);
db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run('live', 'Live', cwd, 2, null, null);
db.close();

process.env.XDG_DATA_HOME = data;
test.after(() => rmSync(root, { recursive: true, force: true }));

test('the interactive OpenCode process marks only the newest session in its directory active', async () => {
  const child = spawn(bin, [], { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  await once(child.stdout, 'data');
  try {
    const { inventory } = await import('../packages/connect/src/inventory.js');
    const rows = await inventory([{ id: 'opencode', engine: 'opencode', env: {} }]);
    assert.equal(rows.find((x) => x.id === 'live')?.active, true);
    assert.equal(rows.find((x) => x.id === 'live')?.writerPid, child.pid);
    assert.equal(rows.find((x) => x.id === 'old')?.active, false);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
});

/** The kernel start time of a process, as Claude records it. */
const procStart = (pid) => {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
};

test('a Claude session typed at a keyboard is live through its sessions/<pid>.json record', async (t) => {
  if (process.platform !== 'linux') return t.skip('reads /proc');
  const home = mkdtempSync(join(tmpdir(), 'helm-claude-live-'));
  const project = join(home, 'projects', '-work-app');
  mkdirSync(project, { recursive: true });
  mkdirSync(join(home, 'sessions'), { recursive: true });
  const id = (n) => `33333333-3333-4333-8333-33333333333${n}`;
  for (const n of [1, 2, 3]) {
    writeFileSync(join(project, `${id(n)}.jsonl`),
      JSON.stringify({ type: 'user', cwd: '/work/app', message: { role: 'user', content: `thread ${n}` } }) + '\n');
  }
  // Claude appends and closes: nothing holds the transcript open.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const record = (n, extra) => writeFileSync(join(home, 'sessions', `${extra.pid}.json`), JSON.stringify({
      sessionId: id(n), cwd: '/work/app', kind: 'interactive', entrypoint: 'cli', ...extra,
    }));
    record(1, { pid: child.pid, procStart: procStart(child.pid) });
    // A record left by a crash whose pid has since been reused by something else.
    record(2, { pid: process.pid, procStart: '1' });
    const { inventory } = await import('../packages/connect/src/inventory.js');
    const rows = await inventory([{ id: 'claudex', engine: 'claude', env: { CLAUDE_CONFIG_DIR: home } }]);
    const by = (n) => rows.find((r) => r.id === id(n));
    assert.equal(by(1).active, true);
    assert.equal(by(1).writerPid, child.pid);
    assert.equal(by(2).active, false, 'a recycled pid is not the session');
    assert.equal(by(3).active, false);
  } finally {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
  const { inventory } = await import('../packages/connect/src/inventory.js');
  const after = await inventory([{ id: 'claudex', engine: 'claude', env: { CLAUDE_CONFIG_DIR: home } }]);
  assert.equal(after.find((r) => r.id === id(1)).active, false, 'gone once the process is');
});
