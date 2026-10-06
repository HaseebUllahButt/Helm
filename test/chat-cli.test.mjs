import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-managed-chat-'));
process.env.HELM_NO_SERVICE = '1';
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({ version: 1, profiles: [
  { id: 'claude', label: 'Claude', engine: 'claude', cmd: 'claude', source: 'alias' },
  { id: 'codex', label: 'Codex', engine: 'codex', cmd: 'codex', source: 'alias' },
] }));
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
const { M, E } = await import('@helm/protocol');
const { Driver } = await import('../packages/connect/src/drivers/index.js');
const { Sessions } = await import('../packages/connect/src/sessions.js');
const { EventLog } = await import('../packages/connect/src/events.js');
const { ManagedChat, openChat, runChat } = await import('../packages/connect/src/chat-cli.js');
const { HubConnection } = await import('../packages/connect/src/hub-client.js');

class Provider extends Driver {
  constructor(options) { super(options); this.engineSessionId ||= randomUUID(); this.answers = []; this.starts = 0; }
  async start() { this.starts++; await delay(1); }
  async send(text) {
    this.text = text;
    this.push('turn.start', { turnId: randomUUID(), text });
    this.push('status', { status: 'working' });
  }
  ask(request) { this.push('status', { status: 'blocked' }); this.push('permission.request', request); }
  async answer(requestId, decision) {
    if (!this.pending.has(requestId)) throw new Error('no pending request');
    this.answers.push({ requestId, decision });
    this.push('permission.resolved', { requestId, decision: decision.option });
    this.push('status', { status: this.pending.size ? 'blocked' : 'working' });
  }
  async interrupt() { this.interrupted = true; }
  async kill() { this.killed = true; this.push('status', { status: 'exited' }); }
}
function backend() {
  const drivers = [];
  const runtime = new EventEmitter(); runtime.listLive = async () => new Map(); runtime.watch = () => {};
  const sessions = new Sessions(runtime, {
    events: new EventLog(join(process.env.HELM_DIR, randomUUID())),
    makeDriver: (engine, options) => { const driver = new Provider({ engine, ...options }); drivers.push(driver); return driver; },
  });
  class Connection extends EventEmitter {
    constructor() {
      super(); this.calls = [];
      this.broadcast = (payload) => this.emit('event', E.SESSION_EVENT, { id: payload.id, events: [payload.event] });
      sessions.on('event', this.broadcast);
    }
    async rpc(method, p = {}) {
      this.calls.push({ method, params: p });
      switch (method) {
        case M.AGENT_LIST: return { agents: [{ id: 'claude', engine: 'claude', available: true }, { id: 'codex', engine: 'codex', available: true }] };
        case M.SESSION_START: return { session: await sessions.start(p) };
        case M.SESSION_CONNECT: return { session: await sessions.connect(p.id) };
        case M.SESSION_INPUT: return sessions.input(p.id, p.data);
        case M.SESSION_EVENTS: return sessions.history(p.id, p);
        case M.SESSION_WATCH: return sessions.watch(p.id, p.watchId);
        case M.SESSION_UNWATCH: return sessions.unwatch(p.id, p.watchId);
        case M.SESSION_ANSWER: return sessions.answer(p.id, p.requestId, p.decision);
        case M.SESSION_INTERRUPT: return sessions.interrupt(p.id);
        case M.SESSION_KILL: return sessions.kill(p.id);
        default: throw new Error(method);
      }
    }
    close() { this.closed = true; sessions.off('event', this.broadcast); }
  }
  return { sessions, drivers, Connection };
}
const question = (requestId) => ({ requestId, kind: 'question', title: 'Choose', options: [], questions: [
  { id: 'direction', question: 'Which direction?', options: [{ label: 'Left' }, { label: 'Right' }] },
  { id: 'color', question: 'Which color?', options: [{ label: 'Blue' }, { label: 'Green' }] },
] });

for (const engine of ['claude', 'codex']) test(`${engine}: terminal and app answer the same provider; reconnect keeps pending prompts`, async () => {
  const { sessions, drivers, Connection } = backend();
  const terminal = new Connection(), app = new Connection();
  const { session } = await openChat([engine], { rpc: terminal.rpc.bind(terminal), cwd: '/tmp' });
  const provider = drivers[0];
  assert.equal(drivers.length, 1);
  assert.equal(session.engineSessionId, provider.engineSessionId);
  assert.equal(session.shared, true);
  assert.equal((await sessions.list()).find(s => s.id === session.id).alive, true);
  let output = '';
  const chat = new ManagedChat(terminal, session.id, { write: (text) => { output += text; } });
  await terminal.rpc(M.SESSION_WATCH, { id: session.id, watchId: 'terminal' });
  await app.rpc(M.SESSION_WATCH, { id: session.id, watchId: 'phone' });
  await chat.sync();
  await chat.line('First message');
  const requestId = `native-${engine}-approval`;
  provider.ask({ requestId, kind: 'command', title: 'Run this', detail: 'echo test', options: [{ id: 'allow' }, { id: 'deny' }] });
  assert.match(output, /echo test/);
  await app.rpc(M.SESSION_ANSWER, { id: session.id, requestId, decision: { option: 'allow' } });
  await assert.rejects(chat.line(`/allow ${requestId}`), /answered on another device/);
  assert.equal(provider.answers.length, 1);
  assert.equal(provider.answers[0].requestId, requestId);

  provider.ask(question('native-question'));
  await chat.line('/answer 1 2');
  assert.equal(provider.answers.length, 1, 'partial question answers stay local until complete');
  await chat.line('/answer 2 Green');
  assert.deepEqual(provider.answers.at(-1), { requestId: 'native-question', decision: { option: 'allow', answers: { 'Which direction?': 'Right', 'Which color?': 'Green' } } });
  provider.ask({ requestId: 'still-pending', kind: 'command', title: 'Later', options: [{ id: 'allow' }, { id: 'deny' }] });
  chat.close();
  await terminal.rpc(M.SESSION_UNWATCH, { id: session.id, watchId: 'terminal' }); terminal.close();
  assert.equal(sessions.watching(session.id), true, 'the phone keeps its own watch lease');
  assert.equal(provider.killed, undefined);
  assert.equal(sessions.history(session.id).pending[0].requestId, 'still-pending');
  const reconnected = new Connection();
  await openChat(['--attach', session.id], { rpc: reconnected.rpc.bind(reconnected) });
  assert.equal(drivers.length, 1, 'another frontend never creates another provider');
  const nextChat = new ManagedChat(reconnected, session.id, { write: (text) => { output += text; } });
  await nextChat.sync();
  await nextChat.line('/deny');
  assert.equal(provider.answers.at(-1).requestId, 'still-pending');
  assert.equal(provider.answers.at(-1).decision.option, 'deny');
  await nextChat.line('/stop'); assert.equal(provider.interrupted, true);
  nextChat.close(); reconnected.close(); app.close();
  await sessions.kill(session.id);
});

test('concurrent managed joins share a single startup and preserve shared state on disk', async () => {
  const { sessions, drivers, Connection } = backend();
  const session = await sessions.start({ profileId: 'claude', cwd: '/tmp' });
  const provider = drivers[0], starts = provider.starts;
  const a = new Connection(), b = new Connection();
  await Promise.all([a.rpc(M.SESSION_CONNECT, { id: session.id }), b.rpc(M.SESSION_CONNECT, { id: session.id })]);
  assert.equal(drivers.length, 1);
  assert.equal(provider.starts, starts + 1);
  const restored = new Sessions(new EventEmitter(), { makeDriver: () => { throw Error('history must not launch'); } });
  assert.equal(restored.get(session.id).shared, true);
  a.close(); b.close(); await sessions.kill(session.id);
});

test('CLI EOF/detach does not end a provider and releases only its viewer lease', async () => {
  const { sessions, drivers, Connection } = backend();
  const input = new PassThrough(), output = new PassThrough();
  let text = ''; output.on('data', (chunk) => { text += chunk; });
  const connection = new Connection();
  const running = runChat(['codex'], { connection, input, output });
  while (!text.endsWith('> ')) await delay(5);
  input.end('Hello\n/detach\nNever send this\n');
  await running;
  assert.equal(drivers[0].text, 'Hello');
  assert.equal(drivers[0].killed, undefined);
  assert.equal(connection.calls.some(call => call.method === M.SESSION_KILL), false);
  assert.equal(connection.calls.filter(call => call.method === M.SESSION_UNWATCH).length, 1);
  assert.equal(connection.closed, true);
  assert.equal(sessions.watching([...connection.calls].find(call => call.method === M.SESSION_CONNECT).params.id), false);
  await sessions.kill(connection.calls.find(call => call.method === M.SESSION_CONNECT).params.id);
});

test('push/history race and missing sequences recover without displaying duplicate output', async () => {
  const connection = new EventEmitter();
  const events = [
    { seq: 1, type: 'item.start', id: 'text', kind: 'text' },
    { seq: 2, type: 'item.delta', id: 'text', text: 'one' },
  ];
  connection.rpc = async (_method, params) => {
    connection.emit('event', E.SESSION_EVENT, { id: 's', events: [events.at(-1)] });
    return { events: events.filter(event => params.tail || event.seq > params.since), last: events.at(-1).seq, pending: [] };
  };
  let output = '';
  const chat = new ManagedChat(connection, 's', { write: text => { output += text; } });
  await chat.sync();
  assert.equal(output, '\nAgent: one');
  events.push({ seq: 3, type: 'item.delta', id: 'text', text: 'two' }, { seq: 4, type: 'item.delta', id: 'text', text: 'three' });
  connection.emit('event', E.SESSION_EVENT, { id: 's', events: [events[3]] });
  await chat.sync();
  assert.equal(output, '\nAgent: onetwothree');
  chat.close();
});

test('persistent controller RPC carries answers and events; disconnect rejects calls without replay', async () => {
  class Socket extends EventEmitter {
    sent = [];
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.emit('close'); }
  }
  const socket = new Socket();
  const client = new HubConnection(socket, 'machine', 1000);
  socket.emit('message', JSON.stringify({ t: 'welcome' })); await client.ready;
  let push;
  client.on('event', (kind, payload) => { push = { kind, payload }; });
  socket.emit('message', JSON.stringify({ t: 'event', env: 'machine', kind: E.SESSION_EVENT, payload: { id: 'thread', events: [] } }));
  assert.equal(push.payload.id, 'thread');
  const answered = client.rpc(M.SESSION_ANSWER, { id: 'thread', requestId: 'native', decision: { option: 'allow' } });
  assert.equal(socket.sent[0].params.requestId, 'native');
  socket.emit('message', JSON.stringify({ t: 'rpcResult', id: socket.sent[0].id, ok: true, result: { ok: true } }));
  assert.deepEqual(await answered, { ok: true });
  const pending = client.rpc(M.SESSION_INPUT, { id: 'thread', data: 'one message' });
  client.close();
  await assert.rejects(pending, /closed/);
  await assert.rejects(client.rpc(M.SESSION_INPUT, {}), /closed/);
  assert.equal(socket.sent.length, 2, 'mutations are sent once');
});
