import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

const root = mkdtempSync(join(tmpdir(), 'helm-o2-service-'));
for (const [key, name] of Object.entries({ HOME: 'home', HELM_DIR: 'helm', HELM_DB: 'db.sqlite', HELM_SSH_DIR: 'ssh', HELM_NATIVE_SOCKET: 'native.sock', HELM_TERMINALS_SOCKET: 'terminals.sock', HELM_PROCS_SOCKET: 'procs.sock', XDG_DATA_HOME: 'data', XDG_STATE_HOME: 'state' })) process.env[key] = join(root, name);
process.env.HELM_NO_SERVICE = '1';
for (const dir of ['home', 'helm', 'data/opencode', 'state/opencode']) mkdirSync(join(root, dir), { recursive: true });
const { inventory, inventoryPage } = await import('../packages/connect/src/inventory.js');
const { opencodeServiceSessions } = await import('../packages/connect/src/opencode-service.js');
const { ExternalSessions } = await import('../packages/connect/src/session-external.js');
const { Sessions } = await import('../packages/connect/src/sessions.js');
const profiles = [{ id: 'oc2', engine: 'opencode2', env: {} }];
writeFileSync(join(root, 'helm', 'profiles.json'), JSON.stringify({ profiles }));
const dbPath = join(root, 'data/opencode/opencode.db');
const db = new DatabaseSync(dbPath);
db.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_updated INTEGER, agent TEXT, model TEXT); CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_updated INTEGER, agent TEXT, model TEXT)');
for (let i = 0; i < 65; i++) db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?)').run(`ses_${i}`, `History ${i}`, '/work/same-folder', 100000 - i, 'build', 'model-a');
db.prepare('INSERT INTO session SELECT * FROM session_v2 WHERE id = ?').run('ses_64');
db.close();
let active = { ses_64: { type: 'running' } }, fail = false, calls = 0;
const server = createServer((req, res) => {
  calls++;
  assert.equal(req.url, '/api/session/active');
  assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('opencode:test-password').toString('base64'));
  res.writeHead(fail ? 503 : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: active }));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
// Looks like the service to process discovery, but runs no provider and costs nothing.
const bin = join(root, 'opencode2');
writeFileSync(bin, 'setInterval(() => {}, 1000)');
const service = spawn(process.execPath, [bin, 'serve', '--service'], { cwd: root, stdio: 'ignore' });
await once(service, 'spawn');
const record = { pid: service.pid, url: `http://127.0.0.1:${server.address().port}`, password: 'test-password' };
const statePath = join(root, 'state/opencode/service.json');
writeFileSync(statePath, JSON.stringify(record));
test.after(async () => { service.kill(); await new Promise((r) => server.close(r)); rmSync(root, { recursive: true, force: true }); });

test('V2 service identifies exact live IDs beyond the recent page and leaves idle neighbours inactive', async () => {
  await opencodeServiceSessions({ fresh: true });
  const rows = await inventory(profiles);
  const running = rows.find((r) => r.id === 'ses_64');
  assert.equal(running?.active, true);
  assert.equal(running.status, 'working');
  assert.equal(running.writerPid, null, 'the shared service must never become a takeover target');
  assert.equal(running.serviceActive, true);
  assert.equal(rows.find((r) => r.id === 'ses_0').active, false);
  const both = await inventory([...profiles, { id: 'oc1', engine: 'opencode', env: {} }]);
  assert.equal(both.find((r) => r.id === 'ses_64' && r.engine === 'opencode2')?.active, true, 'a migrated chat running in V2 is still detected with both engines installed');
  const all = await inventory(profiles, { limit: Infinity });
  assert.equal(all.length, 65);
  const first = inventoryPage(all);
  assert.equal(first.recent.length, 41, 'live chats are never hidden behind a page'); assert.equal(first.hasMore, true);
  const expanded = inventoryPage(all, { limit: 80 });
  assert.equal(expanded.recent.length, 65); assert.equal(expanded.hasMore, false);
  const searched = inventoryPage(all, { query: 'history 64' });
  assert.deepEqual(searched.recent.map((s) => s.id), ['ses_64']);
  assert.equal(inventoryPage(all, { visible: (s) => Number(s.id.slice(4)) >= 40 }).recent.length, 25);
});

test('live service chats appear in the ordinary Running list without opening them first', async () => {
  class Runtime extends EventEmitter { async listLive() { return new Map([['outside-terminal', { engine: 'opencode2', cwd: '/work/same-folder', status: 'idle' }]]); } watch() {} }
  const sessions = new Sessions(new Runtime(), { makeDriver: () => { throw Error('detection must not start a provider'); } });
  try {
    const rows = await sessions.list();
    const live = rows.find((s) => s.engineSessionId === 'ses_64');
    assert.equal(live?.externalActive, true, 'a terminal in the same folder cannot hide an exact live service ID');
    assert.equal(live.status, 'working');
    assert.ok(!rows.some((s) => s.engineSessionId === 'ses_63'), 'inactive history stays off Running');
    const old = await sessions.resumeExternal({ engine: 'opencode2', account: 'oc2:opencode', id: 'ses_63' });
    assert.equal(old.engineSessionId, 'ses_63', 'an older page can open its exact original conversation');
  } finally { await sessions.stop(); }
});

test('opening a live V2 monitor cannot kill the service or start a second writer', async () => {
  const s = { id: 'monitor', engine: 'opencode2', profileId: 'oc2', engineSessionId: 'ses_64', cwd: '/work/same-folder', transcript: dbPath, external: true, externalService: true };
  const external = new ExternalSessions({ get: () => s, emit() {} }, { index: new Map([[s.id, s]]), save() {} });
  await assert.rejects(external.takeOver(s.id), /Wait for this OpenCode 2 step/);
  await assert.rejects(external.handoffExternal(s), /still running/);
  process.kill(service.pid, 0);
  fail = true;
  await assert.rejects(external.handoffExternal(s), /not responding/);
  fail = false;
});

test('completed V2 sessions stop being live while saved history stays available', async () => {
  active = {};
  await opencodeServiceSessions({ fresh: true });
  const rows = await inventory(profiles, { limit: Infinity });
  assert.equal(rows.find((s) => s.id === 'ses_64').active, false);
  assert.equal(rows.length, 65);
});

test('stale pids and nonlocal service records never receive the service password', async () => {
  const before = calls;
  writeFileSync(statePath, JSON.stringify({ ...record, pid: process.pid }));
  assert.equal((await opencodeServiceSessions({ fresh: true })).size, 0);
  writeFileSync(statePath, JSON.stringify({ ...record, url: 'https://example.com' }));
  assert.equal((await opencodeServiceSessions({ fresh: true })).size, 0);
  assert.equal(calls, before);
});
