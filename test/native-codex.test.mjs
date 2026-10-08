import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'helm-native-codex-'));
process.env.HELM_DIR = join(root, 'helm');
mkdirSync(process.env.HELM_DIR);
const home = join(root, 'codex');
mkdirSync(join(home, 'app-server-control'), { recursive: true });
const socket = join(home, 'app-server-control/app-server-control.sock');
const threadId = '01a11111-0000-7000-8000-000000000001';
const path = join(home, 'native.jsonl');
writeFileSync(path, [
  { type: 'session_meta', payload: { id: threadId, cwd: root } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue this native thread' }] } },
].map(JSON.stringify).join('\n') + '\n');
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({ version: 1, profiles: [
  { id: 'native-codex', engine: 'codex', label: 'Codex', cmd: 'codex', args: [], env: { CODEX_HOME: home }, source: 'custom' },
] }));
const { Sessions } = await import('../packages/connect/src/sessions.js');
const { CodexDriver } = await import('../packages/connect/src/drivers/codex.js');
class Runtime extends EventEmitter { async listLive() { return new Map(); } }
class OfflineHost extends EventEmitter { async ensure() { return false; } has() { return false; } hasProc() { return false; } nativeSessions() { return []; } detach() {} }
const createSessions = () => new Sessions(new Runtime(), { terminals: new OfflineHost(), nativeHost: new OfflineHost(), procHost: new OfflineHost() });
const http = createServer();
const wsServer = new WebSocketServer({ server: http });
const seen = [];
const answers = [];
let approved = false;
let nativeId = threadId;
let emptyThread = false;
let loaded = true;
let approveFirstTurn = false;
let activeTurn = null;
let failResumes = 0;
let extraTurns = [];
let listFails = false;
let readFails = false;
const status = () => approved ? { type: 'idle' } : { type: 'active', activeFlags: ['waitingOnApproval'] };
const thread = () => ({ id: nativeId, path: emptyThread ? join(home, 'not-created-yet.jsonl') : path, cwd: root, name: 'Native terminal task', canAcceptDirectInput: true, createdAt: 1, updatedAt: 2, status: activeTurn ? {type:'active',activeFlags:[]} : status(), turns: [...extraTurns, ...(activeTurn ? [{id:activeTurn,status:'inProgress',items:[]}] : [])] });
const broadcast = (method, params) => { for (const c of wsServer.clients) c.send(JSON.stringify({ method, params })); };
wsServer.on('connection', (ws) => ws.on('message', (raw) => {
  const m = JSON.parse(String(raw)); seen.push(m);
  if (!m.method) {
    answers.push(m); approved = true;
    broadcast('serverRequest/resolved', { threadId, requestId: 'same-native-request' });
    broadcast('thread/status/changed', { threadId, status: status() });
    return;
  }
  if (m.id == null) return;
  let result = {};
  switch (m.method) {
    case 'thread/loaded/list':
      if (listFails) { ws.send(JSON.stringify({ id: m.id, error: { message: 'daemon busy' } })); return; }
      result = { data: loaded ? [nativeId] : [] }; break;
    case 'thread/read':
      if (readFails && m.params.threadId === nativeId) { ws.send(JSON.stringify({ id: m.id, error: { message: 'read timed out' } })); return; }
      result = { thread: thread() }; break;
    case 'thread/start': result = { thread: thread(), model: m.params.model, approvalPolicy: m.params.approvalPolicy, sandbox: m.params.sandbox }; break;
    case 'thread/resume':
      if (failResumes > 0 && m.params.threadId === nativeId) { failResumes -= 1; ws.send(JSON.stringify({ id: m.id, error: { message: 'thread busy, try again' } })); return; }
      result = { thread: thread(), model: 'native-model', approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' } }; break;
    case 'turn/start':
      emptyThread = false;
      if (approveFirstTurn) approved = false;
      result = { turn: { id: 'native-next-turn' } }; break;
  }
  ws.send(JSON.stringify({ id: m.id, result }));
  if (m.method === 'thread/resume' && !approved) ws.send(JSON.stringify({ id: 'same-native-request', method: 'item/commandExecution/requestApproval', params: {
    threadId: nativeId, turnId: 'native-running-turn', itemId: 'native-command', command: 'printf SAFE', availableDecisions: ['accept', 'cancel'],
  } }));
}));
await new Promise((resolve) => http.listen(socket, resolve));

test('ordinary Codex daemon sessions join the same live request without spawning, changing policy or taking a second writer', async () => {
  const first = createSessions();
  const rows = await first.list();
  assert.equal(rows.length, 1);
  const s = rows[0];
  assert.equal(s.nativeCodex, true); assert.equal(s.shared, true); assert.equal(s.engineSessionId, threadId);
  assert.equal(s.nativeSocket, undefined, 'machine-local transport stays private');
  const resume = seen.find((m) => m.method === 'thread/resume');
  assert.deepEqual(resume.params, { threadId, excludeTurns: true }, 'attach preserves the terminal-selected configuration');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(first.history(s.id).pending[0].requestId, 'same-native-request');
  await first.stop();
  assert.equal(answers.length, 0, 'restart neither denies nor interrupts a live native request');
  const second = createSessions();
  const rejoined = await second.list();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(rejoined[0].id, s.id);
  assert.equal(second.history(s.id).pending[0].requestId, 'same-native-request');
  await second.answer(s.id, 'same-native-request', { option: 'allow' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(answers[0], { jsonrpc: '2.0', id: 'same-native-request', result: { decision: 'accept' } });
  await second.input(s.id, 'Continue from phone');
  const send = seen.find((m) => m.method === 'turn/start');
  assert.equal(send.params.threadId, threadId);
  assert.equal(send.params.approvalPolicy, undefined);
  assert.equal(send.params.sandboxPolicy, undefined);
  await second.stop();
});

test('an approval answered in the native terminal resolves the matching Helm sheet', () => {
  const d = new CodexDriver({ cmd: 'codex', cwd: root, engineSessionId: threadId, nativeSocket: socket });
  d.onServerRequest({ id: 'native-local-answer', method: 'item/commandExecution/requestApproval', params: { threadId, command: 'printf SAFE' } });
  assert.equal(d.pending.size, 1);
  d.onNotification('serverRequest/resolved', { threadId, requestId: 'native-local-answer' });
  assert.equal(d.pending.size, 0);
});

test('a new terminal is controllable before its first rollout and subscribes when that rollout appears', async () => {
  nativeId = '01a11111-0000-7000-8000-000000000002';
  emptyThread = true;
  const before = seen.length;
  const sessions = createSessions();
  const rows = await sessions.list();
  const s = rows.find(s => s.engineSessionId === nativeId);
  assert.equal(s.alive, true);
  assert.equal(s.status, 'idle');
  assert.equal(seen.slice(before).some(m => m.method === 'thread/resume'), false);
  await sessions.input(s.id, 'Start from phone');
  assert.equal(seen.slice(before).find(m => m.method === 'turn/start').params.threadId, nativeId);
  emptyThread = false;
  await sessions.list();
  assert.ok(seen.slice(before).some(m => m.method === 'thread/resume' && m.params.threadId === nativeId));
  await sessions.stop();
});

test('the first prompt subscribes immediately and replays an approval before the next discovery poll', async () => {
  nativeId = '01a11111-0000-7000-8000-000000000003';
  emptyThread = true; approved = true; approveFirstTurn = true;
  const sessions = createSessions();
  const s = (await sessions.list()).find(s => s.engineSessionId === nativeId);
  await sessions.input(s.id, 'Ask before running');
  await new Promise(r => setTimeout(r, 30));
  assert.equal(sessions.history(s.id).pending[0].requestId, 'same-native-request');
  approveFirstTurn = false; approved = true;
  await sessions.stop();
});

test('a transient native disconnect preserves approvals and reconnects without an exit error', async () => {
  const d = new CodexDriver({cmd:'codex',env:{CODEX_HOME:home},cwd:root,engineSessionId:nativeId,transcript:path,nativeSocket:socket});
  const events = []; d.on('event', e => events.push(e));
  await d.start();
  d.onServerRequest({id:'still-pending',method:'item/commandExecution/requestApproval',params:{threadId:nativeId,command:'printf SAFE'}});
  for (const client of wsServer.clients) client.terminate();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(d.nativeConnected, false);
  assert.equal(d.pending.size, 1);
  assert.equal(events.some(e => e.type === 'error' || e.type === 'permission.resolved'), false);
  await d.start();
  assert.equal(d.nativeConnected, true);
  await d.kill();
});

test('busy native input uses the active terminal turn and unloaded native threads become offline', async () => {
  nativeId = '01a11111-0000-7000-8000-000000000004';
  activeTurn = 'terminal-active-turn';
  const sessions = createSessions();
  const s = (await sessions.list()).find(s => s.engineSessionId === nativeId);
  const before = seen.length;
  await sessions.input(s.id, 'Follow the normal CLI behavior');
  const steer = seen.slice(before).find(m => m.method === 'turn/steer');
  assert.equal(steer.params.expectedTurnId, activeTurn);
  loaded = false;
  const missing = (await sessions.list()).find(row => row.id === s.id);
  assert.equal(missing.alive, false);
  assert.equal(missing.status, 'idle');
  loaded = true; activeTurn = null;
  await sessions.stop();
});

test('Helm-created Codex sessions use the existing daemon while preserving the explicit model and permissions', async () => {
  nativeId = '01a11111-0000-7000-8000-000000000005';
  const sessions = createSessions();
  const before = seen.length;
  const s = await sessions.start({cwd:root,profileId:'native-codex',model:'chosen-native-model',mode:'ask'});
  const start = seen.slice(before).find(m => m.method === 'thread/start');
  assert.equal(start.params.model, 'chosen-native-model');
  assert.equal(start.params.approvalPolicy, 'on-request');
  assert.equal(s.engineSessionId, nativeId);
  assert.equal(s.nativeManaged, true);
  await sessions.stop();
});

test('an older idle Helm thread resumed in a terminal joins the daemon with the same Helm identity', async () => {
  nativeId = '01a11111-0000-7000-8000-000000000006';
  const index = join(process.env.HELM_DIR,'sessions.json');
  const saved = JSON.parse(readFileSync(index,'utf8'));
  saved.sessions.push({id:'older-helm-conversation',engine:'codex',driver:'codex',profileId:'native-codex',engineSessionId:nativeId,cwd:root,status:'idle',mode:'full',createdAt:1,updatedAt:1});
  writeFileSync(index,JSON.stringify(saved));
  const sessions = createSessions();
  const rows = (await sessions.list()).filter(s=>s.engineSessionId===nativeId);
  assert.equal(rows.length,1);
  assert.equal(rows[0].id,'older-helm-conversation');
  assert.equal(rows[0].nativeCodex,true);
  assert.equal(rows[0].alive,true);
  assert.equal(rows[0].mode,undefined,'the resumed terminal owns its permission settings');
  await sessions.stop();
});

test('native work survives Helm restart without a false interruption or duplicate writer', async (t) => {
  nativeId = '01a11111-0000-7000-8000-000000000007';
  approved = true;
  activeTurn = 'native-surviving-turn';
  t.after(() => { activeTurn = null; });
  const first = createSessions();
  const s = (await first.list()).find((session) => session.engineSessionId === nativeId);
  first.events.append(s.id, { type: 'turn.start', turnId: activeTurn, text: 'Live terminal work' });
  await first.stop();
  const second = createSessions();
  t.after(() => second.stop());
  await second.resume();
  const live = (await second.list()).find((session) => session.id === s.id);
  assert.equal(live.status, 'working');
  assert.equal(live.recovery, undefined);
  assert.equal(second.history(s.id).events.some((event) => event.type === 'turn.done'
    && event.turnId === activeTurn), false, 'Helm cannot interrupt a turn owned by the terminal daemon');
});

test('a persisted native busy row whose thread is unloaded settles even before a driver attaches', async (t) => {
  loaded = false;
  t.after(() => { loaded = true; });
  const saved = JSON.parse(readFileSync(join(process.env.HELM_DIR, 'sessions.json'), 'utf8'));
  const row = saved.sessions.find((session) => session.engineSessionId === nativeId);
  row.status = 'working';
  writeFileSync(join(process.env.HELM_DIR, 'sessions.json'), JSON.stringify(saved));
  const sessions = createSessions();
  t.after(() => sessions.stop());
  await sessions.resume();
  assert.equal(sessions.get(row.id).status, 'idle');
  assert.equal(sessions.history(row.id).events.filter((event) => event.type === 'status').at(-1).status, 'idle');
});

test('the periodic native check never overwrites what the live thread just reported', async (t) => {
  nativeId = '01a11111-0000-7000-8000-000000000008';
  approved = true; activeTurn = null;
  const sessions = createSessions();
  t.after(() => sessions.stop());
  const s = (await sessions.list()).find((row) => row.engineSessionId === nativeId);
  assert.equal(s.status, 'idle');
  const changes = [];
  sessions.on('session', (row) => { if (row.id === s.id) changes.push(row.status); });
  // The terminal starts a turn; the daemon's thread read lags behind it.
  broadcast('turn/started', { threadId: nativeId, turn: { id: 'terminal-turn' } });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sessions.get(s.id).status, 'working');
  assert.equal((await sessions.list()).find((row) => row.id === s.id).status, 'working', 'a stale snapshot does not mark live work idle');
  broadcast('thread/status/changed', { threadId: nativeId, status: { type: 'idle' } });
  broadcast('turn/completed', { threadId: nativeId, turn: { id: 'terminal-turn', status: 'completed' } });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sessions.get(s.id).status, 'idle');
  assert.deepEqual([...new Set(changes)], ['working', 'idle'], 'every real change reaches the app');
});

test('a native thread closed in its terminal drops questions nobody can answer, once', async (t) => {
  nativeId = '01a11111-0000-7000-8000-000000000009';
  approved = false; activeTurn = null;
  t.after(() => { approved = true; loaded = true; });
  const sessions = createSessions();
  t.after(() => sessions.stop());
  const s = (await sessions.list()).find((row) => row.engineSessionId === nativeId);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sessions.history(s.id).pending.length, 1);
  loaded = false;
  const row = (await sessions.list()).find((r) => r.id === s.id);
  assert.equal(row.alive, false);
  assert.equal(row.status, 'idle');
  assert.deepEqual(sessions.history(s.id).pending, [], 'the closed terminal cannot answer its old question');
  const repeats = [];
  sessions.on('session', (r) => { if (r.id === s.id) repeats.push(r); });
  await sessions.list(); await sessions.list();
  assert.equal(repeats.length, 0, 'an unchanged offline thread is not re-announced on every check');
});

test('a live native thread that fails one reconnect after restart is not treated as stopped', async (t) => {
  nativeId = '01a11111-0000-7000-8000-000000000010';
  approved = true; activeTurn = 'terminal-busy-turn';
  t.after(() => { activeTurn = null; failResumes = 0; });
  const first = createSessions();
  const s = (await first.list()).find((row) => row.engineSessionId === nativeId);
  first.events.append(s.id, { type: 'turn.start', turnId: activeTurn, text: 'Terminal work' });
  await first.input(s.id, 'After that, update the docs', { delivery: 'queue' });
  await first.stop();
  failResumes = 1;
  const before = seen.length;
  const second = createSessions();
  t.after(() => second.stop());
  t.after(() => second.kill(s.id));
  await second.resume();
  await new Promise((r) => setTimeout(r, 30));
  const events = second.history(s.id).events;
  assert.equal(events.some((e) => e.type === 'turn.done' && e.turnId === activeTurn), false, 'the terminal turn is not marked stopped');
  assert.notEqual(second.get(s.id).recovery?.kind, 'restart');
  assert.equal(seen.slice(before).some((m) => m.method === 'turn/start'), false, 'no second writer joins the busy thread');
  assert.equal(second.get(s.id).status, 'working');
});

test('a native thread that could not be reattached at restart recovers on the next check', async (t) => {
  nativeId = '01a11111-0000-7000-8000-000000000011';
  approved = true; activeTurn = null;
  t.after(() => { failResumes = 0; });
  const first = createSessions();
  const s = (await first.list()).find((row) => row.engineSessionId === nativeId);
  await first.input(s.id, 'Queued while the terminal works', { delivery: 'queue' });
  await first.stop();
  failResumes = 2; // the restart's own check and its reattach both fail
  const second = createSessions();
  t.after(() => second.stop());
  t.after(() => second.kill(s.id));
  await second.resume();
  assert.equal(second.get(s.id).recovery?.kind, 'error');
  assert.equal(second.get(s.id).queuePaused, true, 'nothing is replayed while the thread cannot be checked');
  await second.list();
  assert.equal(second.get(s.id).recovery, undefined, 'the warning clears once the thread is reachable');
  assert.equal(second.get(s.id).queuePaused, false);
});

test('a native turn that finished while Helm was down closes from the thread, with no restart warning', async (t) => {
  nativeId = '01a11111-0000-7000-8000-000000000012';
  approved = true; activeTurn = null;
  t.after(() => { extraTurns = []; });
  const first = createSessions();
  const s = (await first.list()).find((row) => row.engineSessionId === nativeId);
  first.events.append(s.id, { type: 'turn.start', turnId: 'finished-while-away', text: 'Terminal work' });
  await first.stop();
  extraTurns = [{ id: 'finished-while-away', status: 'completed', items: [] }];
  const second = createSessions();
  t.after(() => second.stop());
  t.after(() => second.kill(s.id));
  await second.resume();
  const done = second.history(s.id).events.filter((e) => e.type === 'turn.done' && e.turnId === 'finished-while-away');
  assert.deepEqual(done.map((e) => [e.status, e.error]), [['ok', undefined]]);
  assert.equal(second.get(s.id).status, 'idle');
  assert.equal(second.get(s.id).recovery, undefined);
});

test('a native thread closed in its terminal while Helm was down settles from its rollout, then sends what was queued', async (t) => {
  nativeId = '01a11111-0000-7000-8000-000000000013';
  approved = true; activeTurn = 'closed-while-away';
  t.after(() => { activeTurn = null; loaded = true; });
  const first = createSessions();
  const s = (await first.list()).find((row) => row.engineSessionId === nativeId);
  first.events.append(s.id, { type: 'turn.start', turnId: activeTurn, text: 'Terminal work' });
  await first.input(s.id, 'Afterwards, summarise', { delivery: 'queue' });
  await first.stop();
  appendFileSync(path, [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: activeTurn } },
    { type: 'event_msg', payload: { type: 'turn_aborted', turn_id: activeTurn, reason: 'interrupted' } },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n');
  activeTurn = null; loaded = false;
  const before = seen.length;
  const second = createSessions();
  t.after(() => second.stop());
  t.after(() => second.kill(s.id));
  await second.resume();
  await new Promise((r) => setTimeout(r, 50));
  const done = second.history(s.id).events.filter((e) => e.type === 'turn.done' && e.turnId === 'closed-while-away');
  assert.deepEqual(done.map((e) => [e.status, e.error]), [['interrupted', undefined]], 'closed as Codex recorded it');
  assert.equal(second.get(s.id).recovery, undefined, 'no "Helm restarted" warning for a terminal-owned turn');
  assert.ok(seen.slice(before).some((m) => m.method === 'turn/start' && m.params.input[0].text === 'Afterwards, summarise'));
});

test('a native daemon that does not answer leaves its threads unknown and holds their queue', async (t) => {
  nativeId = '01a11111-0000-7000-8000-000000000014';
  approved = true; activeTurn = 'maybe-still-running';
  t.after(() => { activeTurn = null; listFails = false; });
  const first = createSessions();
  const s = (await first.list()).find((row) => row.engineSessionId === nativeId);
  first.events.append(s.id, { type: 'turn.start', turnId: activeTurn, text: 'Terminal work' });
  await first.input(s.id, 'Then the docs', { delivery: 'queue' });
  await first.stop();
  listFails = true;
  const before = seen.length;
  const second = createSessions();
  t.after(() => second.stop());
  t.after(() => second.kill(s.id));
  await second.resume();
  const session = second.get(s.id);
  assert.equal(session.status, 'working', 'liveness is not guessed');
  assert.equal(session.queuePaused, true);
  assert.equal(session.recovery?.kind, 'error');
  assert.equal(second.history(s.id).events.some((e) => e.type === 'turn.done' && e.turnId === activeTurn), false);
  assert.equal(seen.slice(before).some((m) => m.method === 'turn/start' || m.method === 'thread/resume'), false, 'no competing writer');
  listFails = false;
  await second.list();
  assert.equal(second.get(s.id).recovery, undefined, 'the daemon answering clears the hold');
  assert.equal(second.get(s.id).queuePaused, false);
  assert.equal(second.get(s.id).status, 'working', 'the turn really is still running');
  assert.equal(seen.slice(before).some((m) => m.method === 'turn/start'), false, 'the queue still waits for it');
});

test('a native thread that cannot be read is unknown, not closed: its turn and question stay', async (t) => {
  nativeId = '01a11111-0000-7000-8000-000000000015';
  approved = false; activeTurn = null;
  t.after(() => { approved = true; readFails = false; });
  const sessions = createSessions();
  t.after(() => sessions.stop());
  t.after(() => sessions.kill(s.id));
  const s = (await sessions.list()).find((row) => row.engineSessionId === nativeId);
  await new Promise((r) => setTimeout(r, 30));
  sessions.events.append(s.id, { type: 'turn.start', turnId: 'asking-turn', text: 'Terminal work' });
  assert.equal(sessions.history(s.id).pending.length, 1);
  readFails = true;
  await sessions.list();
  assert.equal(sessions.history(s.id).pending.length, 1, 'the question is still answerable');
  assert.equal(sessions.history(s.id).events.some((e) => e.type === 'turn.done' && e.turnId === 'asking-turn'), false);
  assert.equal(sessions.get(s.id).status, 'blocked');
});

test.after(async () => {
  for (const c of wsServer.clients) c.terminate();
  await new Promise((resolve) => wsServer.close(resolve));
  await new Promise((resolve) => http.close(resolve));
  rmSync(root, { recursive: true, force: true });
});
