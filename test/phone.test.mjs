import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// helm phone: the card, each kind of answer, Refuse, a Helm restart, the
// end of a chat and a time limit. A private Helm folder and one driven chat.
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-phone-'));
process.env.HELM_NO_SERVICE = '1';
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({
  version: 1, profiles: [{ id: 'devin', engine: 'devin', cmd: 'devin', source: 'alias' }],
}));

const { Sessions } = await import('../packages/connect/src/sessions.js');
const { EventLog } = await import('../packages/connect/src/events.js');
const { PhoneRequests, findCode } = await import('../packages/connect/src/phone.js');
const { joinHelmAsks } = await import('../packages/connect/src/helm-asks.js');

class StubRuntime extends EventEmitter {
  async read() { return { text: '' }; }
  watch() {}
  async listLive() { return new Map(); }
}
class FakeDriver extends EventEmitter {
  constructor(opts) { super(); Object.assign(this, opts); this.status = 'idle'; this.engineSessionId = 'engine-1'; this.pending = new Map(); this.sent = []; }
  push(type, payload) { if (type === 'status') this.status = payload.status; this.emit('event', { type, ...payload }); }
  async start() {}
  async send(text) { this.sent.push(text); this.push('status', { status: 'working' }); this.push('turn.start', { turnId: `t${this.sent.length}`, text }); }
  async answer() {}
  async interrupt() {}
  async kill() { this.push('status', { status: 'exited' }); }
}

let n = 0;
const newId = () => `phone-test${String(++n).padStart(8, '0')}`;

async function setup(t, { now } = {}) {
  const sessions = new Sessions(new StubRuntime(), {
    events: new EventLog(join(process.env.HELM_DIR, `events-${Math.random().toString(36).slice(2)}`)),
    makeDriver: (engine, opts) => new FakeDriver({ engine, ...opts }),
  });
  const session = await sessions.start({ cwd: '/tmp', profileId: 'devin', title: 'Fix the login' });
  await sessions.input(session.id, 'Work');
  const dir = mkdtempSync(join(process.env.HELM_DIR, 'phone-'));
  const uploads = join(dir, 'uploads');
  const make = () => {
    const phone = new PhoneRequests({ sessions, dir, uploads, envId: () => 'machine-1', ...(now ? { now } : {}) });
    sessions.helmAsks = joinHelmAsks(phone);
    return phone;
  };
  const phone = make();
  t.after(() => { sessions.helmAsks?.stop(); return sessions.stop(); });
  const cards = () => sessions.events.pending(session.id).filter((p) => p.requestId.startsWith('phone-'));
  const ask = (type, extra = {}) => sessions.helmAsks.owners[0].ask({ sessionId: session.id, requestId: extra.requestId ?? newId(), type, ...extra });
  return { sessions, session, phone, make, dir, uploads, cards, ask };
}

test('a question shows a card for its chat, and the answer comes back', async (t) => {
  const { sessions, session, phone, cards, ask } = await setup(t);
  const asked = await ask('ask', { question: 'Which plan?', choices: ['Small', 'Big', 'Small'], why: 'I set up billing' });
  assert.equal(asked.state, 'asking');
  const [card] = cards();
  assert.equal(card.kind, 'tool');
  assert.equal(card.tool, 'phone');
  assert.deepEqual(card.phone, { type: 'ask', question: 'Which plan?', choices: ['Small', 'Big'], chat: 'Fix the login', envId: 'machine-1', until: card.phone.until });
  assert.deepEqual(card.options.map((o) => o.role), ['allow', 'deny']);
  assert.equal(sessions.get(session.id).status, 'blocked');
  assert.deepEqual(phone.list().map((r) => [r.type, r.chat, r.question]), [['ask', 'Fix the login', 'Which plan?']]);

  phone.give({ requestId: asked.requestId, text: 'Big' });
  const done = await phone.wait({ requestId: asked.requestId, wait: 0 });
  assert.deepEqual(done, { requestId: asked.requestId, state: 'answered', answer: { text: 'Big', choice: 2 } });
  assert.equal(cards().length, 0);
  assert.equal(sessions.get(session.id).status, 'working');
  assert.throws(() => phone.give({ requestId: asked.requestId, text: 'Small' }), /no longer open/);
  // Read once: the answer leaves the disk.
  const record = JSON.parse(readFileSync(join(phone.dir, 'requests.json'), 'utf8'))[asked.requestId];
  assert.equal(record.state, 'answered');
  assert.equal('answer' in record, false);
});

test('Refuse from the card or from the waiting box ends the request', async (t) => {
  const { sessions, session, phone, cards, ask } = await setup(t);
  const one = await ask('location', { why: 'Find a shop near you' });
  phone.give({ requestId: one.requestId, refuse: true });
  assert.equal((await phone.wait({ requestId: one.requestId, wait: 0 })).state, 'refused');

  const two = await ask('photo');
  await sessions.answer(session.id, two.requestId, { option: 'deny', message: 'Not now' });
  assert.deepEqual(await phone.wait({ requestId: two.requestId, wait: 0 }), { requestId: two.requestId, state: 'refused', message: 'Not now' });
  // Allow with no data cannot answer a photo.
  const three = await ask('photo');
  await assert.rejects(sessions.answer(session.id, three.requestId, { option: 'allow' }), /on its card/);
  assert.equal(cards().length, 1);
});

test('a location and a code are checked before they go to the agent', async (t) => {
  const { phone, ask } = await setup(t);
  const place = await ask('location');
  assert.throws(() => phone.give({ requestId: place.requestId, latitude: 200, longitude: 1 }), /did not give a location/);
  phone.give({ requestId: place.requestId, latitude: 31.5204, longitude: 74.3587, accuracy: 12.4 });
  assert.deepEqual((await phone.wait({ requestId: place.requestId, wait: 0 })).answer, { latitude: 31.5204, longitude: 74.3587, accuracy: 12 });

  const code = await ask('code', { site: 'GitHub' });
  phone.give({ requestId: code.requestId, code: 'Your GitHub code is 482-913. Do not share it.' });
  assert.deepEqual((await phone.wait({ requestId: code.requestId, wait: 0 })).answer, { code: '482913' });
});

test('findCode takes the code out of a text message', () => {
  assert.equal(findCode('123456'), '123456');
  assert.equal(findCode('G-482913'), 'G-482913');
  assert.equal(findCode('Your verification code is 7731 09. It ends in 10 minutes.'), '773109');
  assert.equal(findCode('Use code AB12CD to sign in'), 'AB12CD');
  assert.equal(findCode('  '), '');
});

test('a photo comes in pieces and is saved with the chat\'s uploads', async (t) => {
  const { session, phone, uploads, ask } = await setup(t);
  const asked = await ask('photo', { why: 'Show the error on the screen' });
  const bytes = Buffer.from('fake jpeg bytes '.repeat(1000));
  const a = bytes.subarray(0, 6000), b = bytes.subarray(6000);
  assert.throws(() => phone.photo({ requestId: asked.requestId, part: 1, data: b.toString('base64'), mime: 'image/jpeg' }), /lost/);
  assert.throws(() => phone.photo({ requestId: asked.requestId, part: 0, data: a.toString('base64'), mime: 'text/plain' }), /JPEG/);
  phone.photo({ requestId: asked.requestId, part: 0, data: a.toString('base64'), mime: 'image/jpeg' });
  const { path } = phone.photo({ requestId: asked.requestId, part: 1, data: b.toString('base64'), last: true });
  assert.ok(path.startsWith(join(uploads, session.id)));
  assert.match(path, /\.jpg$/);
  assert.deepEqual(readFileSync(path), bytes);
  const done = await phone.wait({ requestId: asked.requestId, wait: 0 });
  assert.deepEqual(done.answer, { path, bytes: statSync(path).size });
});

test('a restart shows the same card, and the waiting helm phone gets its answer', async (t) => {
  const { session, phone, make, cards, ask } = await setup(t);
  const asked = await ask('code', { site: 'the bank' });
  phone.stop();
  const again = make();
  assert.equal(cards().length, 1);
  assert.equal((await again.ask({ sessionId: session.id, requestId: asked.requestId, type: 'code', site: 'the bank' })).state, 'asking');
  again.give({ requestId: asked.requestId, code: '555123' });
  // An answer given while helm phone was away waits on disk.
  again.stop();
  const third = make();
  assert.deepEqual((await third.wait({ requestId: asked.requestId, wait: 0 })).answer, { code: '555123' });
});

test('deleting or stopping the chat closes its requests', async (t) => {
  const { sessions, session, phone, ask } = await setup(t);
  const asked = await ask('photo');
  // A Stop counts for requests asked before it: wait for the clock to move on.
  const askedAt = Date.now();
  while (Date.now() <= askedAt) await new Promise((resolve) => setImmediate(resolve));
  await sessions.interrupt(session.id);
  assert.deepEqual(await phone.wait({ requestId: asked.requestId, wait: 0 }), { requestId: asked.requestId, state: 'cancelled', message: 'The owner stopped the chat.' });

  const other = await ask('location');
  await sessions.kill(session.id);
  const w = await phone.wait({ requestId: other.requestId, wait: 0 });
  assert.equal(w.state, 'cancelled');
  assert.equal(w.message, 'The chat ended.');
});

test('the time limit ends a request, and Ctrl+C closes the card', async (t) => {
  let clock = 1_000_000;
  const { phone, cards, ask } = await setup(t, { now: () => clock });
  const asked = await ask('ask', { question: 'Ready?', timeoutMinutes: 1 });
  clock += 61_000;
  assert.equal((await phone.wait({ requestId: asked.requestId, wait: 0 })).state, 'timeout');
  assert.equal(cards().length, 0);
  const two = await ask('photo');
  phone.cancel({ requestId: two.requestId });
  assert.equal((await phone.wait({ requestId: two.requestId, wait: 0 })).state, 'cancelled');
  assert.equal(cards().length, 0);
});

test('a request needs a chat, a known kind and a question', async (t) => {
  const { phone } = await setup(t);
  await assert.rejects(phone.ask({ sessionId: 'nope', requestId: newId(), type: 'photo' }), /Helm chat/);
  await assert.rejects(phone.ask({ sessionId: 'x', requestId: newId(), type: 'sms' }), /one of/);
  await assert.rejects(phone.ask({ sessionId: 'x', requestId: 'bad', type: 'photo' }), /request id/);
  await assert.rejects(phone.dispatch('phone.list', {}, { trusted: false }), /owner's devices/);
});

test('the photo and the code are never kept on disk with the answer queue', () => {
  // The app sends them with phone.give and phone.photo, not session.answer.
  const sheet = readFileSync(new URL('../apps/web/src/session/PhoneSheet.tsx', import.meta.url), 'utf8');
  assert.equal(sheet.includes("'session.answer'"), false);
  assert.ok(existsSync(new URL('../apps/web/src/session/phoneShare.ts', import.meta.url)));
});
