import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
