import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

test('a pi left open in a folder does not bring back the old conversations there', async (t) => {
  if (process.platform !== 'linux') return t.skip('reads /proc');
  const home = mkdtempSync(join(tmpdir(), 'helm-pi-live-'));
  const folder = join(home, 'project');
  const logs = join(home, 'sessions', '--project--');
  mkdirSync(folder, { recursive: true });
  mkdirSync(logs, { recursive: true });
  const id = (n) => `4444444${n}-4444-4444-8444-44444444444${n}`;
  const log = (n, mtime) => {
    const path = join(logs, `2026-01-0${n}_${id(n)}.jsonl`);
    writeFileSync(path, [
      { type: 'session', id: id(n), cwd: folder },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: `thread ${n}` }] } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    if (mtime) utimesSync(path, mtime / 1000, mtime / 1000);
    return path;
  };
  const day = 24 * 3600_000;
  log(1, Date.now() - 3 * day);
  log(2, Date.now() - 2 * day);
  const pi = join(home, 'pi');
  writeFileSync(pi, `#!/usr/bin/env node
console.log('ready');
setInterval(() => {}, 1000);
`);
  chmodSync(pi, 0o755);
  const { inventory, piProcessOwns } = await import('../packages/connect/src/inventory.js');
  const scan = () => inventory([{ id: 'pi', engine: 'pi', env: { PI_CODING_AGENT_DIR: home } }]);
  const run = async (args, body) => {
    const child = spawn(pi, args, { cwd: folder, stdio: ['ignore', 'pipe', 'inherit'] });
    await once(child.stdout, 'data');
    try { await body(child); } finally { child.kill('SIGKILL'); await once(child, 'exit'); }
  };
  try {
    // A fresh prompt: nothing written yet, so nothing is live.
    await run([], async (child) => {
      const rows = await scan();
      assert.equal(rows.filter((r) => r.active).length, 0);
      assert.equal(piProcessOwns(logs + `/2026-01-01_${id(1)}.jsonl`, child.pid, id(1), 'pi', folder), false);
      // Its first message starts a log of its own, which is the live one.
      log(3);
      const after = await scan();
      assert.deepEqual(after.filter((r) => r.active).map((r) => r.id), [id(3)]);
    });
    // Opened on an older conversation by name: that one, before it writes.
    await run(['--session', id(1)], async (child) => {
      const rows = await scan();
      assert.deepEqual(rows.filter((r) => r.active).map((r) => r.id), [id(1)]);
      assert.equal(rows.find((r) => r.id === id(1)).writerPid, child.pid);
      assert.equal(piProcessOwns(rows.find((r) => r.id === id(1)).transcript, child.pid, id(1), 'pi', folder), true);
      await run(['--session-id=' + id(2)], async (second) => {
        const both = await scan();
        assert.deepEqual(both.filter((r) => r.active).map((r) => r.id).sort(), [id(1), id(2)]);
        assert.equal(both.find((r) => r.id === id(2)).writerPid, second.pid);
      });
    });
    await run(['--session', `../sessions/--project--/2026-01-01_${id(1)}.jsonl`], async () => {
      assert.deepEqual((await scan()).filter((r) => r.active).map((r) => r.id), [id(1)]);
    });
    for (const args of [['--no-session'], ['--session-id', id(1).slice(0, 8)]]) {
      await run(args, async () => assert.equal((await scan()).filter((r) => r.active).length, 0));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
