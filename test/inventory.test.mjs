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

test('opencode inventory: the model is a JSON object, not a name', async () => {
  const { inventory } = await import('../packages/connect/src/inventory.js');
  const dir = join(XDG, 'opencode-test');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'opencode.db'));
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_updated INTEGER,
    agent TEXT, model TEXT)`);
  const ins = db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)');
  // What opencode really writes, and what the row filled up with before.
  ins.run('oc-1', 'A thread', '/tmp/oc', Date.now(), 'build',
    '{"id":"muse-spark-1.2","providerID":"opencode","variant":"xhigh"}');
  // A plain name, in case a version ever writes one, and a broken value.
  ins.run('oc-2', 'Another', '/tmp/oc', Date.now() - 1000, 'build', 'plain-model-name');
  ins.run('oc-3', 'Third', '/tmp/oc', Date.now() - 2000, 'build', '{not json');
  db.close();

  const found = await inventory([
    { id: 'oc', engine: 'opencode', env: { XDG_CONFIG_HOME: '~/.config' } },
  ]);
  const by = (id) => found.find((s) => s.id === id);
  assert.equal(by('oc-1').model, 'muse-spark-1.2', 'the name out of the object');
  assert.equal(by('oc-2').model, 'plain-model-name', 'a plain name is left alone');
  assert.equal(by('oc-3').model, null, 'nonsense becomes nothing, not JSON on screen');
});

test('OpenCode 2 inventory reads only native v2 sessions', async () => {
  const { inventory } = await import('../packages/connect/src/inventory.js');
  const dir = join(XDG, 'opencode-v2-test');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'opencode.db'));
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_updated INTEGER,
      agent TEXT, model TEXT);
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_updated INTEGER,
      agent TEXT, model TEXT);
  `);
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run(
    'v1-shared', 'V1 thread', '/tmp/v1', Date.now() - 1000, 'build', 'old-model');
  db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?)').run(
    'v1-shared', 'V1 thread', '/tmp/v1', Date.now() - 1000, 'build', 'old-model');
  db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?)').run(
    'v2-only', 'V2 thread', '/tmp/v2', Date.now(), 'build', '{"id":"new-model"}');
  db.close();

  const found = await inventory([
    { id: 'oc2', engine: 'opencode2', env: { XDG_CONFIG_HOME: '~/.config' } },
  ]);
  const rows = found.filter((r) => r.engine === 'opencode2');
  assert.ok(rows.some((r) => r.id === 'v2-only' && r.model === 'new-model'));
  assert.ok(!rows.some((r) => r.id === 'v1-shared'), 'the V1 backfill is not listed twice');
});
