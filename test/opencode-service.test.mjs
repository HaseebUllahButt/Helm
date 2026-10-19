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
const { loadPty } = await import('../packages/connect/src/pty.js');
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
// Waits for its first line: just after 'spawn' its command line can still read empty.
async function fakeService(path) {
  writeFileSync(path, 'console.log("ready"); setInterval(() => {}, 1000)');
  const child = spawn(process.execPath, [path, 'serve', '--service'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
  await once(child.stdout, 'data');
  return child;
}
const service = await fakeService(join(root, 'opencode2'));
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

test('an idle Helm conversation reopened in O2 becomes the same live monitor', async () => {
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, data TEXT, time_created INTEGER, seq INTEGER)');
  for (const [seq, type, text, at] of [[1, 'user', 'Earlier Helm question', 10], [2, 'assistant', 'Earlier Helm answer', 20], [3, 'user', 'New outside question', 110], [4, 'assistant', 'New outside answer', 120]]) {
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run(String(seq), 'ses_59', type, JSON.stringify({ content: [{ type: 'text', text }] }), at, seq);
  }
  db.close();
  writeFileSync(join(root, 'helm/sessions.json'), JSON.stringify({ sessions: [
    { id: 'returned-o2', engine: 'opencode2', driver: 'opencode2', profileId: 'oc2', engineSessionId: 'ses_59', transcript: dbPath, cwd: '/work/same-folder', title: 'Earlier Helm question', status: 'idle', external: false, externalImported: 2 },
  ] }));
  class Runtime extends EventEmitter { async listLive() { return new Map(); } }
  const drivers = [];
  class Driver extends EventEmitter {
    constructor(opts) { super(); Object.assign(this, opts); this.status = 'idle'; drivers.push(this); }
    async start() {}
    async send(text) { this.sent = text; }
    async kill() { this.killed = true; }
  }
  const sessions = new Sessions(new Runtime(), { makeDriver: (_, opts) => new Driver(opts) });
  sessions.events.append('returned-o2', { type: 'turn.start', turnId: 'managed', text: 'Earlier Helm question', at: 10 });
  sessions.events.append('returned-o2', { type: 'turn.done', turnId: 'managed', status: 'ok', at: 100 });
  await sessions.connect('returned-o2');
  assert.equal(drivers.length, 1);
  active = { ses_59: { type: 'running' } };
  await opencodeServiceSessions({ fresh: true });
  try {
    const managed = sessions.get('returned-o2');
    managed.status = drivers[0].status = 'working';
    sessions.events.append(managed.id, { type: 'turn.start', turnId: 'local-active', text: 'Local work', at: 90 });
    assert.equal((await sessions.list()).find(s => s.id === managed.id).external, false);
    assert.notEqual(drivers[0].killed, true, 'never retire a local turn in progress');
    await assert.rejects(sessions.input(managed.id, 'Do not queue across writers'), /still running/);
    sessions.events.append(managed.id, { type: 'turn.done', turnId: 'local-active', status: 'ok', at: 100 });
    sessions.events.append(managed.id, { type: 'turn.done', turnId: 'refused-queue', status: 'error', undelivered: true, at: 200 });
    managed.status = drivers[0].status = 'idle';
    const rows = await sessions.list();
    const matches = rows.filter(s => s.engineSessionId === 'ses_59');
    assert.equal(matches.length, 1);
    assert.equal(matches[0].id, 'returned-o2');
    assert.equal(matches[0].status, 'working');
    assert.equal(matches[0].external, true);
    assert.equal(matches[0].externalService, true);
    assert.equal(drivers[0].killed, true, 'release only the old idle ACP copy');
    assert.equal(drivers.length, 1, 'monitoring starts no replacement provider');
    await sessions.prepareHistory('returned-o2');
    const events = sessions.events.tail('returned-o2', 0);
    assert.equal(events.filter(e => e.type === 'turn.start' && e.text === 'Earlier Helm question').length, 1);
    assert.equal(events.filter(e => e.type === 'turn.start' && e.text === 'New outside question').length, 1);
    assert.ok(events.some(e => e.type === 'item.delta' && e.text === 'New outside answer'));
    await assert.rejects(sessions.input('returned-o2', 'Do not overlap'), /still running/);
    active = {};
    await opencodeServiceSessions({ fresh: true });
    assert.equal((await sessions.list()).find(s => s.id === 'returned-o2').status, 'done');
    await sessions.input('returned-o2', 'Continue after outside work');
    assert.equal(drivers.length, 2, 'continuing reloads the conversation in a fresh connection');
    assert.equal(drivers[1].engineSessionId, 'ses_59');
    for (const e of sessions.events.tail(managed.id, 0).filter(e => e.type === 'turn.start')) {
      if (sessions.events.turnState(managed.id, e.turnId) === 'open') sessions.events.append(managed.id, { type: 'turn.done', turnId: e.turnId, status: 'ok', at: 100 });
    }
    managed.status = drivers[1].status = 'idle';
    active = { ses_59: { type: 'running' } };
    await assert.rejects(sessions.input(managed.id, 'Detect before the next list'), /still running/);
    assert.equal(managed.external, true, 'a direct send rechecks ownership before the next poll');
    assert.equal(drivers[1].killed, true);
  } finally {
    await sessions.stop();
    writeFileSync(join(root, 'helm/sessions.json'), JSON.stringify({ sessions: [] }));
    active = {};
    await opencodeServiceSessions({ fresh: true });
  }
});

test('an idle O2 terminal exposes its exact tabs without reviving closed folders', async () => {
  const tabsDir = join(root, 'state/opencode/latest/tui');
  mkdirSync(tabsDir, { recursive: true });
  writeFileSync(join(tabsDir, 'tabs.json'), JSON.stringify({
    global: { tabs: [{ sessionID: 'ses_62' }] },
    cwd: { [root]: { tabs: [{ sessionID: 'ses_60' }, { sessionID: 'ses_59' }, { sessionID: 'ses_58' }] }, '/closed-folder': { tabs: [{ sessionID: 'ses_61' }] } },
  }));
  const bin = join(root, 'opencode');
  writeFileSync(bin, 'console.log("READY"); setInterval(() => {}, 1000)');
  const pty = await loadPty();
  const client = pty.spawn(process.execPath, [bin], { cwd: root, env: { ...process.env } });
  await new Promise((resolve) => { const listener = client.onData((s) => { if (s.includes('READY')) { listener.dispose(); resolve(); } }); });
  try {
    const live = await opencodeServiceSessions({ fresh: true });
    assert.equal(live.get('ses_60'), 'idle');
    assert.equal(live.get('ses_62'), 'idle');
    assert.equal(live.has('ses_61'), false);
    active = { ses_60: { type: 'running' } };
    assert.equal((await opencodeServiceSessions({ fresh: true })).get('ses_60'), 'working');
    active = {};
    await opencodeServiceSessions({ fresh: true });
    writeFileSync(join(root, 'helm', 'profiles.json'), JSON.stringify({ profiles: [{ id: 'shell', engine: 'shell' }] }));
    const db = new DatabaseSync(dbPath);
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run('metadata-only', 'ses_58', 'user', JSON.stringify({ content: [{ type: 'text', text: 'Already shown' }] }), 50, 1);
    db.close();
    writeFileSync(join(root, 'helm/sessions.json'), JSON.stringify({ sessions: [59, 58].map(n => ({
      id: `missed-${n}`, engine: 'opencode2', driver: 'opencode2', profileId: 'oc2', engineSessionId: `ses_${n}`,
      transcript: dbPath, cwd: '/work/same-folder', status: 'idle', external: false, updatedAt: 100,
    })) }));
    class Runtime extends EventEmitter { async listLive() { return new Map(); } }
    const sessions = new Sessions(new Runtime());
    try {
      await Promise.race([
        once(sessions, 'discovery'),
        new Promise((_, reject) => setTimeout(() => reject(Error('new outside tabs did not publish discovery')), 6000).unref()),
      ]);
      const liveRow = (await sessions.list()).find((s) => s.engineSessionId === 'ses_60');
      assert.equal(sessions.get('missed-59').external, true, 'a completed outside turn is detected between polls');
      assert.equal(sessions.get('missed-58').external, false, 'late session metadata alone does not retire a provider');
      assert.equal(liveRow?.externalActive, true);
      assert.equal(liveRow.status, 'idle');
      const opened = await sessions.resumeExternal({ engine: 'opencode2', account: 'oc2:opencode', id: 'ses_60' });
      assert.equal(opened.profileId, 'opencode2-service', 'a running service supplies a missing tool entry');
      assert.equal(opened.externalService, true);
      assert.equal(opened.externalActive, true);
      const external = new ExternalSessions({ get: () => opened, emit() {} }, { index: new Map([[opened.id, opened]]), save() {} });
      await external.handoffExternal(opened);
    } finally {
      await sessions.stop();
      writeFileSync(join(root, 'helm/sessions.json'), JSON.stringify({ sessions: [] }));
      writeFileSync(join(root, 'helm', 'profiles.json'), JSON.stringify({ profiles }));
    }
  } finally {
    await new Promise((resolve) => { client.onExit(resolve); client.kill(); });
  }
  assert.equal((await opencodeServiceSessions({ fresh: true })).has('ses_60'), false, 'saved tabs alone do not mean open');
});

test('V2 services installed as opencode and opencode2.exe report live chats', async () => {
  active = { ses_64: { type: 'running' } };
  for (const name of ['opencode', 'opencode2.exe']) {
    const child = await fakeService(join(root, name));
    try {
      writeFileSync(statePath, JSON.stringify({ ...record, pid: child.pid }));
      assert.equal((await opencodeServiceSessions({ fresh: true })).get('ses_64'), 'working', name);
    } finally { child.kill(); await once(child, 'exit'); }
  }
  writeFileSync(statePath, JSON.stringify(record));
});

test('stale pids and nonlocal service records never receive the service password', async () => {
  const before = calls;
  writeFileSync(statePath, JSON.stringify({ ...record, pid: process.pid }));
  assert.equal((await opencodeServiceSessions({ fresh: true })).size, 0);
  writeFileSync(statePath, JSON.stringify({ ...record, url: 'https://example.com' }));
  assert.equal((await opencodeServiceSessions({ fresh: true })).size, 0);
  assert.equal(calls, before);
});
