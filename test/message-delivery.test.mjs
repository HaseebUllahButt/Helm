import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { messageDelivery } from '../packages/protocol/message-delivery.js';

// When a message typed while an agent works reaches its CLI: at that CLI's
// own handover point, as its own ticket, and never lost or matched to the
// wrong waiting message on the way.
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-message-delivery-'));
process.env.HELM_NO_SERVICE = '1';
// The owner's own OpenCode 2 service lives here; never ask it about test chats.
process.env.XDG_STATE_HOME = join(process.env.HELM_DIR, 'state');
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({ version: 1, profiles:
  ['codex', 'claude', 'opencode', 'devin', 'opencode2', 'pi'].map((engine) => ({ id: engine, engine, cmd: engine, env: {}, source: 'alias' })),
}));
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
const { Sessions } = await import('../packages/connect/src/sessions.js');
const { EventLog } = await import('../packages/connect/src/events.js');
const { OpencodeDriver, Opencode2Driver } = await import('../packages/connect/src/drivers/opencode.js');
const { DevinDriver } = await import('../packages/connect/src/drivers/devin.js');
const { ClaudeDriver } = await import('../packages/connect/src/drivers/claude.js');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

class Runtime extends EventEmitter {
  async listLive() { return new Map(); }
  async read() { return { text: '' }; }
  watch() {}
}
class FakeDriver extends EventEmitter {
  constructor(opts) { super(); Object.assign(this, opts); this.engineSessionId = `engine-${Math.random().toString(36).slice(2)}`; this.status = 'idle'; this.pending = new Map(); this.sent = []; this.steered = []; this.turns = 0; }
  push(type, data) {
    if (type === 'status') this.status = data.status;
    if (type === 'permission.request') this.pending.set(data.requestId, data);
    if (type === 'permission.resolved') this.pending.delete(data.requestId);
    this.emit('event', { type, ...data });
  }
  async start() {}
  async send(text) {
    this.sent.push(text);
    this.turnId = `native-${++this.turns}`;
    this.push('turn.start', { turnId: this.turnId, text });
    this.push('status', { status: 'working' });
    await this.onSend?.(text);
  }
  async sendWithAttachments(text, images) { this.images = images; await this.send(text); }
  acceptsImages() { return true; }
  async steer(text, images = [], options = {}) {
    this.steered.push({ text, images, ...options });
    await this.onSteer?.(text, images, options);
  }
  finish(status = 'ok') {
    for (const requestId of this.pending.keys()) this.push('permission.resolved', { requestId, decision: 'cancelled' });
    this.push('turn.done', { turnId: this.turnId, status });
    this.push('status', { status: 'idle' });
  }
  async interrupt() { this.interrupts = (this.interrupts ?? 0) + 1; if (this.onInterrupt) return this.onInterrupt(); this.finish('interrupted'); }
  async kill() { this.push('status', { status: 'exited' }); }
  async answer(requestId) { this.push('permission.resolved', { requestId, decision: 'allow' }); this.push('status', { status: 'working' }); }
  async setMode() {}
  async setModel() {}
  async setEffort() {}
}
async function setup(t, engine) {
  const drivers = new Map();
  const sessions = new Sessions(new Runtime(), {
    events: new EventLog(join(process.env.HELM_DIR, `events-${Math.random().toString(36).slice(2)}`)),
    makeDriver: (name, opts) => { const driver = new FakeDriver({ engine: name, ...opts }); drivers.set(opts.env.HELM_SESSION_ID, driver); return driver; },
  });
  t.after(() => sessions.stop());
  const session = await sessions.start({ cwd: tmpdir(), profileId: engine });
  const driver = drivers.get(session.id);
  const events = () => sessions.history(session.id).events;
  const ticket = (text) => events().findLast((event) => event.type === 'turn.start' && event.text === text)?.turnId;
  await sessions.input(session.id, 'Original task');
  return { sessions, session, driver, drivers, events, ticket };
}

test('each CLI has one handover point and unknown names cannot borrow one', () => {
  assert.deepEqual(messageDelivery('codex'), { timing: 'tool', pending: 'After next tool call' });
  assert.equal(messageDelivery('claude').timing, 'tool');
  assert.equal(messageDelivery('opencode').timing, 'loop');
  for (const engine of ['devin', 'opencode2', 'pi', 'constructor', '__proto__', 'hasOwnProperty', undefined, null]) {
    assert.equal(messageDelivery(engine).timing, 'turn');
    assert.equal(messageDelivery(engine).pending, 'After current response');
  }
});

test('Codex takes images at a tool boundary, not while merely writing; thread context waits for the reply', async (t) => {
  const { sessions, session, driver, drivers } = await setup(t, 'codex');
  const reference = await sessions.start({ cwd: tmpdir(), profileId: 'codex' });
  await sessions.input(reference.id, 'Architecture notes');
  drivers.get(reference.id).finish();
  await sessions.input(session.id, 'Check this too', { attachments: [{ filename: 'image.png', mime: 'image/png', data: 'iVBORw0KGgo=' }] });
  await sessions.input(session.id, 'With context', { references: [reference.id] });
  await tick();
  assert.equal(driver.steered.length, 0);
  driver.push('item.start', { id: 'command', kind: 'command', turnId: driver.turnId });
  await tick();
  assert.equal(driver.steered.length, 1);
  assert.equal(driver.steered[0].text, 'Check this too');
  assert.equal(driver.steered[0].images[0].data, 'iVBORw0KGgo=');
  driver.finish(); await tick();
  assert.match(driver.sent.at(-1), /^With context\n\n/);
});

test('explicit held messages and slash commands are barriers to automatic mid-turn input', async (t) => {
  const { sessions, session, driver, ticket } = await setup(t, 'codex');
  driver.push('item.start', { id: 'command', kind: 'command', turnId: driver.turnId });
  await sessions.input(session.id, 'Held first', { delivery: 'queue' });
  await sessions.input(session.id, 'Automatic second');
  await tick();
  assert.equal(driver.steered.length, 0);
  sessions.dequeue(session.id, ticket('Held first'));
  await tick();
  assert.equal(driver.steered[0]?.text, 'Automatic second');
  await sessions.input(session.id, '/compact checkpoint');
  await sessions.input(session.id, 'After compaction');
  await tick();
  assert.equal(driver.steered.length, 1);
});

test('OpenCode takes a message inside its running loop; other CLIs keep it for the reply\'s end', async (t) => {
  for (const engine of ['opencode', 'devin', 'opencode2', 'pi']) {
    await t.test(engine, async (t) => {
      const { sessions, session, driver } = await setup(t, engine);
      await sessions.input(session.id, 'Follow-up');
      await tick();
      assert.equal(driver.steered.length, engine === 'opencode' ? 1 : 0);
      if (engine === 'opencode') assert.equal(driver.steered[0].inputId, sessions.history(session.id).events.findLast((e) => e.text === 'Follow-up').turnId);
      else { driver.finish(); await tick(); assert.equal(driver.sent.at(-1), 'Follow-up'); }
    });
  }
});

test('a turn the queue starts on OpenCode takes the messages behind it into its loop', async (t) => {
  const { sessions, session, driver } = await setup(t, 'opencode');
  await sessions.input(session.id, 'Held', { delivery: 'queue' });
  await sessions.input(session.id, 'Behind it');
  await tick();
  assert.equal(driver.steered.length, 0, 'the held message is a barrier');
  driver.finish(); await tick(); await tick();
  assert.equal(driver.sent.at(-1), 'Held');
  assert.equal(driver.steered[0]?.text, 'Behind it');
});

test('early reads and ticket ids cannot strand or swap identical waiting messages', async (t) => {
  const { sessions, session, driver, events } = await setup(t, 'codex');
  driver.push('item.start', { id: 'tool', kind: 'tool', turnId: driver.turnId });
  driver.onSteer = (text, images, { inputId }) => driver.push('input.consumed', { text, inputId });
  await sessions.input(session.id, 'Early echo');
  await tick();
  assert.equal(events().filter((event) => event.type === 'turn.accept').length, 1);
  assert.ok(!events().some((event) => event.type === 'turn.deliver'), 'read before the call returned: nothing left to mark sent');
  driver.onSteer = undefined;
  await sessions.input(session.id, 'Same text');
  await sessions.input(session.id, 'Same text');
  await tick();
  // Neither an unknown text nor an unknown id is pinned on someone else's message.
  driver.push('input.consumed', { text: 'Unknown message' });
  driver.push('input.consumed', { text: 'Same text', inputId: 'unknown-id' });
  assert.equal(events().filter((event) => event.type === 'turn.accept').length, 1);
  const identical = driver.steered.filter((item) => item.text === 'Same text');
  driver.push('input.consumed', { text: 'Same text', inputId: identical[1].inputId });
  driver.push('input.consumed', { text: 'Same text', inputId: identical[0].inputId });
  assert.deepEqual(events().filter((event) => event.type === 'turn.accept').slice(1).map((event) => event.turnId), [identical[1].inputId, identical[0].inputId]);
});

test('a message being handed over cannot be withdrawn, and one the CLI refuses goes back to wait', async (t) => {
  const { sessions, session, driver, ticket } = await setup(t, 'codex');
  const held = deferred();
  driver.onSteer = () => held.promise;
  driver.push('item.start', { id: 'tool', kind: 'tool', turnId: driver.turnId });
  await sessions.input(session.id, 'Reserved');
  await tick();
  assert.equal(sessions.dequeue(session.id, ticket('Reserved')).found, false);
  held.reject(new Error('turn no longer accepts steering'));
  await tick();
  // Refused once, it is not offered again mid-turn: the reply's end takes it.
  driver.push('item.start', { id: 'tool-2', kind: 'tool', turnId: driver.turnId });
  await tick();
  assert.equal(driver.steered.length, 1);
  assert.equal(sessions.dequeue(session.id, ticket('Reserved')).found, true);
});

test('a refused message keeps its place ahead of messages added while the CLI was asked', async (t) => {
  const { sessions, session, driver } = await setup(t, 'codex');
  const held = deferred();
  driver.onSteer = () => held.promise;
  driver.push('item.start', { id: 'tool', kind: 'tool', turnId: driver.turnId });
  await sessions.input(session.id, 'Original follow-up');
  await tick();
  await sessions.input(session.id, 'Later follow-up', { delivery: 'queue' });
  held.reject(new Error('Steer refused'));
  await tick();
  driver.finish(); await tick();
  assert.equal(driver.sent.at(-1), 'Original follow-up');
  driver.finish(); await tick();
  assert.equal(driver.sent.at(-1), 'Later follow-up');
});

test('Codex waits for the next tool step after an awaited handover', async (t) => {
  const { sessions, session, driver } = await setup(t, 'codex');
  const held = deferred();
  driver.onSteer = () => driver.steered.length === 1 ? held.promise : undefined;
  driver.push('item.start', { id: 'tool', kind: 'tool', turnId: driver.turnId });
  await sessions.input(session.id, 'At this boundary');
  await tick();
  await sessions.input(session.id, 'At the next boundary');
  driver.push('item.done', { id: 'tool', status: 'ok' });
  held.resolve(); await tick();
  assert.equal(driver.steered.length, 1);
  driver.push('item.start', { id: 'next-tool', kind: 'tool', turnId: driver.turnId });
  await tick();
  assert.equal(driver.steered.at(-1).text, 'At the next boundary');
});

test('a refused mid-turn message fails as its own bubble, leaving the others alone', async (t) => {
  const { sessions, session, driver, events } = await setup(t, 'opencode');
  await sessions.input(session.id, 'First injection');
  await sessions.input(session.id, 'Second injection');
  await tick();
  const [first, second] = driver.steered;
  driver.push('input.failed', { inputId: first.inputId, text: first.text, error: 'Provider refused input' });
  const failed = events().find((event) => event.type === 'turn.done' && event.turnId === first.inputId);
  assert.equal(failed?.status, 'error');
  assert.equal(failed?.error, 'Provider refused input');
  assert.ok(!events().some((event) => ['turn.done', 'turn.accept'].includes(event.type) && event.turnId === second.inputId));
  driver.push('input.consumed', { inputId: second.inputId, text: second.text });
  assert.equal(events().filter((event) => event.type === 'turn.accept' && event.turnId === second.inputId).length, 1);
  assert.equal(driver.status, 'working');
});

test('Send now on a CLI without steering cuts only the current reply and keeps the rest of the queue', async (t) => {
  const { sessions, session, driver, ticket, drivers } = await setup(t, 'devin');
  driver.steer = undefined;
  const child = await sessions.start({ cwd: tmpdir(), profileId: 'pi' });
  await sessions.input(child.id, 'Unrelated work');
  driver.push('status', { status: 'blocked' });
  await sessions.input(session.id, 'Held first', { delivery: 'queue' });
  await sessions.input(session.id, 'Send this now', { delivery: 'queue' });
  await sessions.input(session.id, 'Held last', { delivery: 'queue' });
  const id = ticket('Send this now');
  assert.deepEqual(await sessions.sendNow(session.id, id), { ok: true, found: true, sent: true });
  assert.equal(driver.sent.at(-1), 'Send this now');
  assert.equal(driver.interrupts, 1);
  assert.equal(session.stoppedAt, undefined);
  assert.equal(session.stopGeneration, undefined);
  assert.equal(session.recovery, undefined, 'a reply cut short to make room is not a stopped task');
  assert.equal(drivers.get(child.id).interrupts, undefined);
  assert.deepEqual(await sessions.sendNow(session.id, id), { ok: true, found: false, sent: false });
  driver.finish(); await tick();
  assert.equal(driver.sent.at(-1), 'Held first');
  driver.finish(); await tick();
  assert.equal(driver.sent.at(-1), 'Held last');
});

test('Send now names the chosen one of two identical waiting messages', async (t) => {
  const { sessions, session, driver, ticket, events } = await setup(t, 'devin');
  driver.steer = undefined;
  await sessions.input(session.id, 'Identical prompt', { delivery: 'queue' });
  const first = ticket('Identical prompt');
  await sessions.input(session.id, 'Identical prompt', { delivery: 'queue' });
  const second = ticket('Identical prompt');
  await sessions.sendNow(session.id, second);
  const echo = events().findLast((event) => event.type === 'turn.start' && !event.queued);
  assert.equal(echo.inputId, second);
  assert.equal(sessions.dequeue(session.id, first).found, true);
});

test('a Send now whose cancel is refused leaves the message waiting', async (t) => {
  const { sessions, session, driver, ticket } = await setup(t, 'devin');
  driver.steer = undefined;
  driver.onInterrupt = () => { throw new Error('cancel refused'); };
  await sessions.input(session.id, 'Retain this', { delivery: 'queue' });
  await assert.rejects(sessions.sendNow(session.id, ticket('Retain this')), /cancel refused/);
  assert.equal(sessions.dequeue(session.id, ticket('Retain this')).found, true);
  driver.onInterrupt = undefined;
});

test('a Send now whose cancel never settles gives up, keeps the message and stops listening', async (t) => {
  const { sessions, session, driver, ticket } = await setup(t, 'devin');
  driver.steer = undefined;
  driver.onInterrupt = async () => {};
  await sessions.input(session.id, 'Timed out', { delivery: 'queue' });
  const listeners = driver.listenerCount('event');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sending = sessions.sendNow(session.id, ticket('Timed out'));
  const rejected = assert.rejects(sending, /still waiting/);
  await tick();
  t.mock.timers.tick(15_000);
  await rejected;
  t.mock.timers.reset();
  assert.equal(driver.listenerCount('event'), listeners);
  assert.equal(driver.sent.length, 1);
  assert.equal(sessions.dequeue(session.id, ticket('Timed out')).found, true);
  driver.onInterrupt = undefined;
});

test('Stop during a Send now wins: the reserved message is not sent or brought back', async (t) => {
  const { sessions, session, driver, ticket, events } = await setup(t, 'devin');
  driver.steer = undefined;
  const interrupted = deferred();
  driver.onInterrupt = () => driver.interrupts === 1 ? interrupted.promise : driver.finish('interrupted');
  await sessions.input(session.id, 'Stopped request', { delivery: 'queue' });
  const id = ticket('Stopped request');
  const sending = sessions.sendNow(session.id, id);
  const rejected = assert.rejects(sending, /thread was stopped/);
  await tick();
  assert.equal(sessions.dequeue(session.id, id).found, false, 'reserved while its reply is cancelled');
  await sessions.interrupt(session.id);
  interrupted.resolve();
  await rejected;
  assert.equal(driver.sent.length, 1);
  assert.equal(sessions.dequeue(session.id, id).found, false);
  assert.ok(events().some((event) => event.type === 'turn.remove' && event.turnId === id));
  driver.onInterrupt = undefined;
});

test('a delegated task without steering is not cut short by Send now', async (t) => {
  const { sessions, session, driver, ticket } = await setup(t, 'devin');
  driver.steer = undefined;
  session.delegation = { parentId: 'parent', status: 'working' };
  await sessions.input(session.id, 'For the task', { delivery: 'queue' });
  await assert.rejects(sessions.sendNow(session.id, ticket('For the task')), /current reply ends/);
  assert.equal(driver.interrupts, undefined);
  driver.finish(); await tick();
  assert.equal(driver.sent.at(-1), 'For the task');
});

test('an echo names the ticket it answers so a long log keeps both', () => {
  const log = new EventLog(join(process.env.HELM_DIR, 'events-identical-retention'));
  const id = 'retained';
  log.append(id, { type: 'turn.start', turnId: 'local-first', text: 'Identical', queued: true, delivery: 'queue' });
  log.append(id, { type: 'turn.start', turnId: 'local-second', text: 'Identical', queued: true });
  log.append(id, { type: 'turn.start', turnId: 'native', text: 'Identical', inputId: 'local-second' });
  log.append(id, { type: 'item.start', id: 'reply', turnId: 'native', kind: 'text' });
  for (let i = 0; i < 2400; i++) log.append(id, { type: 'item.delta', id: 'reply', text: '.' });
  const retained = new EventLog(log.dir).tail(id, 0);
  assert.ok(retained.some((event) => event.type === 'turn.start' && event.turnId === 'local-first' && event.delivery === 'queue'),
    'the identical held ticket is still waiting, not taken by the other one\'s echo');
  assert.ok(retained.some((event) => event.type === 'turn.start' && event.turnId === 'local-second'));
  assert.equal(retained.find((event) => event.type === 'turn.start' && event.turnId === 'native').inputId, 'local-second');
});

test('the app adopts the named message for an echo and shows a refused one as failed', async () => {
  const { apply, emptyLog } = await import('../apps/web/src/session/types.ts');
  const state = emptyLog();
  let seq = 0;
  const ev = (event) => apply(state, { seq: ++seq, at: seq, ...event });
  ev({ type: 'turn.start', turnId: 'host', text: 'Original' });
  ev({ type: 'turn.start', turnId: 'local-a', text: 'Same', queued: true, delivery: 'queue' });
  ev({ type: 'turn.start', turnId: 'local-b', text: 'Same', queued: true });
  assert.equal(state.turns.find((turn) => turn.id === 'local-a').delivery, 'queue');
  // Text alone would hand this echo to the older identical message.
  ev({ type: 'turn.start', turnId: 'native-b', text: 'Same', inputId: 'local-b' });
  assert.deepEqual(state.turns.map((turn) => turn.id), ['host', 'local-a', 'native-b']);
  assert.equal(state.turns.find((turn) => turn.id === 'local-a').queued, true);
  // Refused after it was handed over: out of the queue, into the chat, failed.
  ev({ type: 'turn.deliver', turnId: 'local-a' });
  ev({ type: 'turn.done', turnId: 'local-a', status: 'error', error: 'Provider refused input' });
  const refused = state.turns.find((turn) => turn.id === 'local-a');
  assert.equal(refused.queued, false);
  assert.equal(refused.done.error, 'Provider refused input');
});

test("the app adopts a waiting command for Claude's echo of it as a skill", async () => {
  const { apply, emptyLog } = await import('../apps/web/src/session/types.ts');
  const state = emptyLog();
  let seq = 0;
  const ev = (event) => apply(state, { seq: ++seq, at: seq, ...event });
  ev({ type: 'turn.start', turnId: 'host', text: 'Original' });
  ev({ type: 'turn.start', turnId: 'local-a', text: '/rpc-action-items for today', queued: true });
  // A skill run as a command opens with <command-message>, a built-in one with <command-name>.
  ev({ type: 'turn.start', turnId: 'native-a', text: '<command-message>rpc-action-items</command-message>\n<command-name>/rpc-action-items</command-name>\n<command-args>for today</command-args>' });
  assert.deepEqual(state.turns.map((turn) => [turn.id, !!turn.queued]), [['host', false], ['native-a', false]]);
});

test('a waiting row whose message went out unmatched can still be removed once the agent is idle', async (t) => {
  const { sessions, session, driver, events, ticket } = await setup(t, 'devin');
  await sessions.input(session.id, '/rpc-action-items for today');
  const turnId = ticket('/rpc-action-items for today');
  // The CLI echoes it in words Helm does not match to the message.
  const send = driver.send.bind(driver);
  driver.send = async () => send('<command-message>something else</command-message>');
  driver.finish();
  await tick();
  assert.equal(events().some((event) => event.type === 'turn.remove'), false);
  assert.deepEqual(sessions.dequeue(session.id, turnId), { ok: true, found: false }, 'while it runs, the echo may still come');
  driver.finish();
  await tick();
  assert.deepEqual(sessions.dequeue(session.id, turnId), { ok: true, found: false, removed: true });
  assert.equal(events().at(-1).type, 'turn.remove');
  assert.equal(events().at(-1).turnId, turnId);
});

async function acpFixture(t) {
  const writes = [];
  let receive, exit;
  const pipe = {
    onData: (fn) => { receive = fn; }, onExit: (fn) => { exit = fn; }, detach() {},
    end: () => exit({ code: 0 }), kill: () => exit({ code: 0 }),
    write: (line) => {
      const message = JSON.parse(line); writes.push(message);
      if (message.method === 'initialize') queueMicrotask(() => receive(JSON.stringify({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } }) + '\n'));
      else if (message.method === 'session/new') queueMicrotask(() => receive(JSON.stringify({ id: message.id, result: { sessionId: 'test-session', configOptions: [] } }) + '\n'));
      else if (message.method === 'session/set_config_option') queueMicrotask(() => receive(JSON.stringify({ id: message.id, result: { configOptions: [] } }) + '\n'));
    },
  };
  const driver = new OpencodeDriver({ cmd: process.execPath, env: {}, cwd: tmpdir(), mode: 'ask', procId: `test-${Math.random()}`, procHost: { hasProc: () => false, openProc: async () => {}, procPipe: () => pipe } });
  const events = [];
  driver.on('event', (event) => events.push(event));
  t.after(() => driver.kill());
  await driver.send('Original');
  return { driver, events, writes, exit: (code) => exit({ code }), reply: (id, result) => receive(JSON.stringify({ id, ...result }) + '\n') };
}

for (const primaryFirst of [true, false]) test(`OpenCode keeps one run open across a second prompt (run answers first: ${primaryFirst})`, async (t) => {
  const { driver, events, writes, reply } = await acpFixture(t);
  const original = events.find((event) => event.type === 'turn.start').turnId;
  await driver.steer('Follow-up', [{ mime: 'image/png', data: 'aW1hZ2U=' }], { inputId: 'ticket' });
  const prompts = writes.filter((message) => message.method === 'session/prompt');
  assert.deepEqual(prompts[1].params.prompt, [{ type: 'text', text: 'Follow-up' }, { type: 'text', text: '[Image #1]' }, { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }]);
  assert.equal(events.filter((event) => event.type === 'turn.start').length, 1);
  reply(prompts[primaryFirst ? 0 : 1].id, { result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } } });
  await tick();
  assert.equal(driver.status, 'working');
  reply(prompts[primaryFirst ? 1 : 0].id, { result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } } });
  await tick();
  assert.equal(driver.status, 'idle');
  assert.equal(events.filter((event) => event.type === 'turn.done').length, 1);
  assert.equal(events.find((event) => event.type === 'turn.done').turnId, original);
  assert.equal(events.find((event) => event.type === 'input.consumed').inputId, 'ticket');
});

test('a cancelled OpenCode run does not wait on its second prompt, and fails it by name', async (t) => {
  const { driver, events, writes, reply } = await acpFixture(t);
  await driver.steer('Follow-up', [], { inputId: 'ticket' });
  const prompts = writes.filter((message) => message.method === 'session/prompt');
  await driver.interrupt();
  reply(prompts[0].id, { result: { stopReason: 'cancelled' } });
  await tick();
  assert.equal(driver.status, 'idle');
  assert.equal(events.find((event) => event.type === 'input.failed')?.inputId, 'ticket');
  reply(prompts[1].id, { result: { stopReason: 'cancelled' } });
  await tick();
  assert.equal(events.filter((event) => event.type === 'input.failed').length, 1, 'said once');
  assert.equal(events.filter((event) => event.type === 'turn.done').length, 1);
});

test('OpenCode exiting mid-run fails the message sent into it, once', async (t) => {
  const { driver, events, exit } = await acpFixture(t);
  await driver.steer('Follow-up', [], { inputId: 'ticket' });
  exit(1);
  await tick();
  assert.deepEqual(events.filter((event) => event.type === 'input.failed').map((event) => event.inputId), ['ticket']);
  assert.equal(events.filter((event) => event.type === 'turn.done').length, 1);
});

test('only OpenCode 1 takes a second prompt into a running loop', () => {
  const opts = { cmd: process.execPath, env: {}, cwd: tmpdir() };
  assert.equal(typeof new OpencodeDriver(opts).steer, 'function');
  assert.equal(typeof new Opencode2Driver(opts).steer, 'undefined');
  assert.equal(typeof new DevinDriver(opts).steer, 'undefined');
});

test('Claude matches each read to its own message and ignores replays that are not ours', async (t) => {
  const writes = [], events = [];
  let receive, exit, immediate = true;
  const replay = (message, parent = null) => receive(JSON.stringify({ ...message, isReplay: true, parent_tool_use_id: parent }) + '\n');
  const pipe = {
    onData: (fn) => { receive = fn; }, onExit: (fn) => { exit = fn; }, detach() {},
    end: () => exit({ code: 0 }), kill: () => exit({ code: 0 }),
    write: (line) => { const message = JSON.parse(line); writes.push(message); if (message.type === 'user' && immediate) replay(message); },
  };
  const driver = new ClaudeDriver({ cmd: process.execPath, env: {}, cwd: tmpdir(), procId: 'claude-pipe', procHost: { hasProc: () => true, procPipe: () => pipe }, openTurn: () => 'original' });
  driver.on('event', (event) => events.push(event));
  t.after(() => driver.suspend());
  await driver.start();
  await driver.steer('Early', [], { inputId: 'early' });
  assert.equal(events.find((event) => event.type === 'input.consumed').inputId, 'early');
  immediate = false;
  await driver.steer('Identical', [], { inputId: 'first' });
  await driver.steer('Identical', [], { inputId: 'second' });
  const messages = writes.filter((message) => message.type === 'user');
  replay({ ...messages[1], uuid: 'unknown' });
  replay(messages[2], 'subagent');
  assert.equal(events.filter((event) => event.type === 'input.consumed').length, 1);
  replay(messages[2]); replay(messages[1]);
  assert.deepEqual(events.filter((event) => event.type === 'input.consumed').map((event) => event.inputId), ['early', 'second', 'first']);
  await driver.steer('Never read', [], { inputId: 'lost' });
  exit({ code: 1 });
  assert.deepEqual(events.filter((event) => event.type === 'input.failed').map((event) => event.inputId), ['lost']);
});

test('how full the context is lands on the chat, reaches clients, and stays out of the transcript', async (t) => {
  const { sessions, session, driver, events } = await setup(t, 'claude');
  const updates = [];
  sessions.on('session', (s) => updates.push(s.context));
  driver.push('context', { used: 148_500, window: 383_000 });
  driver.push('context', { used: 148_500, window: 383_000 });
  driver.push('context', { used: 0, window: 383_000 });
  assert.equal(sessions.get(session.id).context.used, 148_500);
  assert.equal(sessions.get(session.id).context.window, 383_000);
  assert.equal(updates.filter(Boolean).length, 1, 'a repeat of the same figure says nothing new');
  assert.ok(!events().some((event) => event.type === 'context'));
  driver.finish(); await tick();
  assert.equal(sessions.get(session.id).context.used, 148_500);
});
