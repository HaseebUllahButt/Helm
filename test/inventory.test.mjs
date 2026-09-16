import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Inventory reads real stores under HELM_DIR/XDG_DATA_HOME; point both at
// scratch before the modules that resolve them load.
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-inv-'));
const XDG = mkdtempSync(join(tmpdir(), 'helm-xdg-'));
process.env.XDG_DATA_HOME = XDG;

const SECONDS = Math.floor(Date.now() / 1000);

function devinStore(accountDir, { hiddenColumn = true } = {}) {
  const dir = join(XDG, accountDir, 'cli');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'sessions.db'));
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, title TEXT, working_directory TEXT, model TEXT,
    created_at INTEGER, last_activity_at INTEGER${hiddenColumn ? ', hidden INTEGER' : ''})`);
  return db;
}

test('devin inventory: sqlite store, seconds become ms, hidden stays out', async () => {
  const db = devinStore('devin');
  const ins = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)');
  ins.run('slug-one', 'Fix the grey bar', '/tmp/proj-a', 'devin-1', SECONDS - 500, SECONDS - 50, 0);
  ins.run('slug-two', 'Second thread', '/tmp/proj-b', 'devin-1', SECONDS - 400, SECONDS - 10, 1);
  db.close();

  const { inventory } = await import('../packages/connect/src/inventory.js');
  const rows = await inventory([{ id: 'devin', engine: 'devin', env: {} }]);
  const found = rows.filter((r) => r.engine === 'devin');

  assert.deepEqual(found.map((r) => r.id), ['slug-one']);
  assert.equal(found[0].title, 'Fix the grey bar');
  assert.equal(found[0].cwd, '/tmp/proj-a');
  assert.equal(found[0].updatedAt, (SECONDS - 50) * 1000, 'devin stores seconds; the app speaks ms');
  assert.equal(found[0].model, 'devin-1');
  // Newest-first ordering came from the query, not the table.
});

test('a devin store old enough to lack `hidden` is still read', async () => {
  const db = devinStore('devin-legacy', { hiddenColumn: false });
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(
    'old-one', 'Ancient thread', '/tmp/proj-c', 'devin-1', SECONDS - 900, SECONDS - 800);
  db.close();

  const { inventory } = await import('../packages/connect/src/inventory.js');
  const rows = await inventory([{ id: 'devin', engine: 'devin', env: {} }]);
  assert.ok(rows.some((r) => r.id === 'old-one'), 'a missing column must not skip the store');
});

test('two devin profiles do not double-count the shared store', async () => {
  const { inventory } = await import('../packages/connect/src/inventory.js');
  const rows = await inventory([
    { id: 'devin', engine: 'devin', env: {} },
    { id: 'devin-work', engine: 'devin', env: { XDG_CONFIG_HOME: '~/.config-work' } },
  ]);
  const ids = rows.filter((r) => r.engine === 'devin').map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'same sqlite rows, one profile each - no dupes');
});

test('a profiles file fresh from join answers; an old one is stale', async () => {
  const { saveProfiles, profilesStale, currentProfiles } =
    await import('../packages/connect/src/profiles.js');

  saveProfiles([{ id: 'kept', engine: 'codex', cmd: 'codex', source: 'custom' }]);
  assert.equal(profilesStale(), false);
  // A fresh file is trusted: currentProfiles must not rediscover over it.
  assert.deepEqual((await currentProfiles()).map((p) => p.id), ['kept']);

  const file = join(process.env.HELM_DIR, 'profiles.json');
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(file, old, old);
  assert.equal(profilesStale(), true);
});
