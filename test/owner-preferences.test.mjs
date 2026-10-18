import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-owner-'));
process.env.HELM_NO_SERVICE = '1';
process.env.HELM_SSH_DIR = join(process.env.HELM_DIR, 'ssh');
process.env.HELM_DB = join(process.env.HELM_DIR, 'hub.sqlite');
process.env.HELM_PROCS_SOCKET = join(process.env.HELM_DIR, 'procs.sock');
process.env.HELM_TERMINALS_SOCKET = join(process.env.HELM_DIR, 'terminals.sock');
process.env.HELM_NATIVE_SOCKET = join(process.env.HELM_DIR, 'native.sock');
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({ version: 1, profiles: [
  { id: 'claude-main', label: 'Claude', engine: 'claude', cmd: process.execPath, source: 'custom' },
] }));

const owner = await import('../packages/protocol/owner.js');
const { SEED, OWNER_FILE, loadOwner, editOwner, mergeOwner, checkOwner, ownerHash, newerOwner } = owner;
const keeperMod = await import('../packages/connect/src/owner-keeper.js');
const { OwnerKeeper, ownerWords, ownerText, keeperTask, parseKeeperReply, keeperMachine, pickKeeperAgent, askHidden, KEEP_EVERY_MS } = keeperMod;
const { helmBrief, ownerNote, cheapModel } = await import('../packages/connect/src/delegation.js');
const { Sessions } = await import('../packages/connect/src/sessions.js');
const { M } = await import('@helm/protocol');

const reset = () => rmSync(OWNER_FILE, { force: true });
const otherFile = () => join(mkdtempSync(join(process.env.HELM_DIR, 'machine-')), 'owner.json');

test('every machine starts from the same seed, and every chat is told it', () => {
  reset();
  assert.equal(loadOwner(), SEED);
  assert.ok(SEED.lines.some((l) => /Plain English/.test(l)));
  assert.equal(ownerHash(loadOwner(otherFile())), ownerHash(loadOwner()), 'two fresh machines agree');
  const brief = helmBrief({});
  assert.match(brief, /\[Helm owner: What the owner wants from every agent:\n- Plain English/);
  assert.match(helmBrief({ self: 'a', machines: { a: { id: 'a', name: 'why' }, b: { id: 'b', name: 'vm' } } }), /\[Helm owner:/);
});

test('an empty list adds no note', () => {
  reset();
  editOwner({ lines: [] });
  assert.equal(ownerNote(), '');
  assert.doesNotMatch(helmBrief({}), /Helm owner/);
  reset();
});

test('an edit moves the stamp forward, cleans lines, and a save with no edit changes nothing', () => {
  reset();
  const first = editOwner({ lines: '- Short replies\n\n  short replies \n* Ask before deleting' }, { where: 'why', why: 'Edited in the app', now: 5 });
  assert.equal(first.changed, true);
  assert.deepEqual(first.record.lines, ['Short replies', 'Ask before deleting']);
  assert.ok(first.record.updatedAt > SEED.updatedAt, 'a slow clock still beats the seed');
  assert.equal(first.record.by, 'owner');
  const again = editOwner({ lines: ['Short replies', 'Ask before deleting'] });
  assert.equal(again.changed, false);
  assert.equal(again.record.updatedAt, first.record.updatedAt);
  assert.throws(() => editOwner({ lines: Array.from({ length: 21 }, (_, i) => `line ${i}`) }), /20 lines/);
  const off = editOwner({ keeper: false }, { why: 'Keeper turned off' });
  assert.equal(off.record.keeper, false);
  assert.deepEqual(off.record.lines, ['Short replies', 'Ask before deleting']);
  reset();
});

test('records are checked and kept exactly, never repaired', () => {
  const good = { ...SEED, lines: ['One'], updatedAt: 10, future: { kept: true } };
  assert.equal(checkOwner(good), good, 'an unknown field from a newer Helm passes untouched');
  for (const bad of [null, [], { ...good, lines: 'One' }, { ...good, lines: ['two\nlines'] }, { ...good, keeper: 'yes' },
    { ...good, by: 'someone' }, { ...good, updatedAt: Date.now() + 2 * 86400_000 }, { ...good, lines: [''] },
    { ...good, padding: 'x'.repeat(20_000) }, { ...good, learned: { at: 1, added: 'x' } }]) {
    assert.equal(checkOwner(bad), null, JSON.stringify(bad)?.slice(0, 80));
  }
  assert.equal(ownerHash({ a: 1, b: [1, { c: 2, d: 3 }] }), ownerHash({ b: [1, { d: 3, c: 2 }], a: 1 }));
});

test('the newer record wins whole; equal stamps settle the same way on both sides', () => {
  const a = otherFile(), b = otherFile();
  const older = { ...SEED, lines: ['Older'], updatedAt: SEED.updatedAt + 1, by: 'owner' };
  const newer = { ...SEED, lines: ['Newer'], updatedAt: SEED.updatedAt + 2, by: 'owner' };
  assert.equal(mergeOwner(older, { file: a }), true);
  assert.equal(mergeOwner(newer, { file: a }), true);
  assert.equal(mergeOwner(older, { file: a }), false, 'an older record never comes back');
  assert.deepEqual(loadOwner(a).lines, ['Newer']);
  assert.equal(mergeOwner(newer, { file: a }), false, 'the same record is not news');
  assert.equal(mergeOwner({ ...newer, lines: 'bad' }, { file: a }), false);
  const x = { ...newer, lines: ['X'] }, y = { ...newer, lines: ['Y'] };
  const c = otherFile();
  mergeOwner(x, { file: c }); mergeOwner(y, { file: c });
  mergeOwner(y, { file: b }); mergeOwner(x, { file: b });
  assert.equal(ownerHash(loadOwner(c)), ownerHash(loadOwner(b)), 'a tie cannot leave two machines disagreeing');
  assert.equal(newerOwner(x, y), newerOwner(y, x));
});

/** Write a chat's event log the way EventLog does. */
function chatLog(dir, id, events) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

test('only the owner\'s own new words are read: no helpers, Helm notes, agent messages or old turns', () => {
  const dir = mkdtempSync(join(process.env.HELM_DIR, 'events-'));
  chatLog(dir, 'chat1', [
    { seq: 1, at: 100, type: 'turn.start', turnId: 't1', text: 'old message before the last run' },
    { seq: 2, at: 300, type: 'turn.start', turnId: 't2', text: '<helm_instructions>\n[Helm: notes]\n</helm_instructions>\n\n<user_request>\nStop using jargon, please\n</user_request>' },
    { seq: 3, at: 301, type: 'item.delta', id: 'x', text: 'the agent said "turn.start"' },
    { seq: 4, at: 302, type: 'turn.start', turnId: 't3', text: '[Helm agent message abc]\nFrom another chat' },
    { seq: 5, at: 303, type: 'turn.start', turnId: 'local-1', text: '/compact', local: true },
    { seq: 6, at: 304, type: 'turn.start', turnId: 'wake-1', text: 'background task done', wake: true },
    { seq: 7, at: 305, type: 'turn.start', turnId: 't4', text: 'ok' },
    { seq: 8, at: 306, type: 'turn.start', turnId: 'turn-9', text: '<helm_instructions>\nx\n</helm_instructions>\n\n<user_request>\nStop using jargon, please\n</user_request>', inputId: 't2' },
  ]);
  chatLog(dir, 'helper', [{ seq: 1, at: 300, type: 'turn.start', text: 'A task an agent wrote' }]);
  chatLog(dir, 'stale', [{ seq: 1, at: 300, type: 'turn.start', text: 'Never read: chat not touched since' }]);
  const sessions = [
    { id: 'chat1', driver: 'claude', title: 'Helm', updatedAt: 400 },
    { id: 'helper', driver: 'claude', delegation: { parentId: 'chat1' }, updatedAt: 400 },
    { id: 'stale', driver: 'claude', updatedAt: 150 },
    { id: 'pane:1', updatedAt: 400 },
  ];
  const { chats } = ownerWords(sessions, { dir, since: 200 });
  assert.deepEqual(chats, [{ id: 'chat1', title: 'Helm', last: 8, texts: ['Stop using jargon, please'] }], 'the CLI\'s echo is not a second message');
  assert.deepEqual(ownerWords(sessions, { dir, since: 200, read: { chat1: 8 } }).chats, [], 'read once, never again');
  assert.equal(ownerText('/model haiku'), null);
});

test('the reply is used only as a list: no change, junk and secrets change nothing', () => {
  const current = ['Plain English'];
  assert.equal(parseKeeperReply('NO CHANGE', current), null);
  assert.equal(parseKeeperReply('I think the list is fine.', current), null, 'no list lines, no change');
  assert.equal(parseKeeperReply('- Plain English', current), null, 'same list');
  assert.deepEqual(parseKeeperReply('Here it is:\n- Plain English\n- Ask before pushing\n- token: sk-abcdefghijklmnop\n- Use key ghp_1234567890abcdef', current),
    ['Plain English', 'Ask before pushing']);
  const many = Array.from({ length: 30 }, (_, i) => `- Rule ${i}`).join('\n');
  assert.equal(parseKeeperReply(many, current).length, 12, 'capped at about 12 lines');
  const task = keeperTask(['Plain English'], [{ title: 'Helm', texts: ['Stop using jargon'] }]);
  assert.match(task, /- Plain English/);
  assert.match(task, /\[Helm\] Stop using jargon/);
  assert.match(task, /NO CHANGE/);
  assert.match(task, /Do not use any tools/);
});

test('one machine keeps it: the home machine, else the oldest', () => {
  const net = { self: 'b', revoked: { d: 1 }, machines: {
    a: { id: 'a', name: 'laptop', addedAt: 1 }, b: { id: 'b', name: 'vm', kind: 'vm', addedAt: 5 },
    d: { id: 'd', name: 'gone', kind: 'vm', addedAt: 0 } } };
  assert.equal(keeperMachine(net).id, 'b');
  assert.equal(keeperMachine({ machines: { a: net.machines.a, c: { id: 'c', addedAt: 3 } } }).id, 'a');
  assert.equal(keeperMachine({}), null);
  const pick = pickKeeperAgent([{ id: 'codex', engine: 'codex', available: true, cheapModel: 'gpt-mini' },
    { id: 'claude', engine: 'claude', available: true, cheapModel: 'haiku' }, { id: 'off', engine: 'claude', available: false, cheapModel: 'haiku' }]);
  assert.deepEqual(pick, { profileId: 'claude', model: 'haiku', mode: 'default', engine: 'claude' });
  assert.equal(pickKeeperAgent([{ id: 'codex', engine: 'codex', available: true, cheapModel: 'gpt-mini' }]).mode, 'readonly');
  assert.equal(pickKeeperAgent([{ id: 'x', engine: 'claude', available: true, cheapModel: null }]), null);
  assert.equal(cheapModel('devin', ['gemini-4-argon-medium', 'claude-opus-5']), null, 'gemini is not a mini');
  assert.equal(cheapModel('devin', ['claude-opus-5', 'gpt-5-mini']), 'gpt-5-mini');
});

function keeperRig({ words, now = { t: 1_000_000_000 }, reply = '- Plain English: short replies.\n- Ask before pushing to GitHub.' } = {}) {
  const asked = [], changed = [], calls = [];
  const net = { self: 'home', machines: { home: { id: 'home', name: 'vm', kind: 'vm', addedAt: 1 }, lap: { id: 'lap', name: 'laptop', addedAt: 2 } } };
  const file = join(mkdtempSync(join(process.env.HELM_DIR, 'keeper-')), 'state.json');
  const keeper = new OwnerKeeper({
    self: () => 'home', name: () => 'vm', network: () => net, file, now: () => now.t,
    words: async (p) => { calls.push(['home', p]); return words.home(p); },
    rpc: async (env, method, p) => { assert.equal(method, M.OWNER_WORDS); calls.push([env, p]); return words[env](p); },
    agents: async () => [{ id: 'claude-main', engine: 'claude', available: true, cheapModel: 'haiku' }],
    ask: async (p) => { asked.push(p); return reply; },
    changed: (r) => changed.push(r),
  });
  return { keeper, asked, changed, calls, now, file };
}

test('the keeper changes nothing, and calls no model, when nobody wrote anything new', async () => {
  reset();
  const { keeper, asked, changed } = keeperRig({ words: { home: () => ({ chats: [] }), lap: () => ({ chats: [{ id: 'c', last: 3, texts: [] }] }) } });
  assert.equal(await keeper.run(), 'nothing new');
  assert.equal(asked.length, 0);
  assert.equal(changed.length, 0);
  assert.equal(existsSync(OWNER_FILE), false, 'the list was not even written');
  assert.equal(keeper.status().result, 'nothing new');
});

test('the keeper learns from new chats on every machine, once, and says what it changed', async () => {
  reset();
  let lapTexts = ['Never push to GitHub without asking me'];
  const { keeper, asked, changed, calls, now } = keeperRig({ words: {
    home: (p) => ({ chats: p.read.c1 >= 4 ? [] : [{ id: 'c1', title: 'Helm', last: 4, texts: ['Ask me before you push'] }] }),
    lap: (p) => ({ chats: p.read.c9 >= 8 ? [] : [{ id: 'c9', title: 'Site', last: 8, texts: lapTexts }] }),
  } });
  assert.equal(await keeper.run(), 'changed');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].model, 'haiku');
  assert.match(asked[0].task, /Ask me before you push/);
  assert.match(asked[0].task, /Never push to GitHub without asking me/);
  const record = loadOwner();
  assert.equal(record.by, 'keeper');
  assert.equal(record.where, 'vm');
  assert.equal(record.why, 'Learned from 2 new chats');
  assert.deepEqual(record.learned.added, ['Plain English: short replies.', 'Ask before pushing to GitHub.']);
  assert.equal(record.learned.removed.length, 3);
  assert.equal(changed.length, 1, 'the new list goes out to the other machines');
  assert.ok(record.lines.every((l) => !/learned|chat|\d{4}-/i.test(l)), 'no metadata in the list');

  // Next day: the same chats are not read again.
  now.t += KEEP_EVERY_MS + 1;
  calls.length = 0;
  assert.equal(await keeper.maybeRun(), 'nothing new');
  assert.equal(asked.length, 1);
  assert.deepEqual(calls.find(([env]) => env === 'lap')[1].read, { c9: 8 });

  // Not more than about once a day.
  assert.equal(await keeper.maybeRun(), null);
  // Turned off: the timer does nothing.
  now.t += KEEP_EVERY_MS + 1;
  editOwner({ keeper: false });
  assert.equal(await keeper.maybeRun(), null);
  assert.equal(keeper.status().on, false);
  reset();
});

test('an unreachable machine is read next time; a failed model leaves the index for a retry', async () => {
  reset();
  const { keeper, file } = keeperRig({ words: {
    home: () => ({ chats: [{ id: 'c1', title: 'Helm', last: 4, texts: ['Always answer in plain English'] }] }),
    lap: () => { throw new Error('offline'); },
  }, reply: 'NO CHANGE' });
  assert.equal(await keeper.run(), 'no change');
  const state = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(state.read.home, { c1: 4 });
  assert.equal(state.read.lap, undefined, 'the laptop\'s chats wait for it');
  assert.equal(existsSync(OWNER_FILE), false);

  const failing = keeperRig({ words: { home: () => ({ chats: [{ id: 'c1', title: 'Helm', last: 4, texts: ['Plain English always'] }] }), lap: () => ({ chats: [] }) } });
  failing.keeper.ask = async () => { throw new Error('the model took too long'); };
  assert.equal(await failing.keeper.run(), 'failed: the model took too long');
  assert.equal(JSON.parse(readFileSync(failing.file, 'utf8')).read.home, undefined);
});

test('the keeper runs only on its own machine', () => {
  const { keeper } = keeperRig({ words: {} });
  keeper.self = () => 'lap';
  assert.throws(() => keeper.runNow(), /another machine/);
  assert.equal(keeper.status().here, false);
  assert.equal(keeper.status().name, 'vm');
});

class FakeDriver extends EventEmitter {
  constructor(opts) { super(); Object.assign(this, opts); this.engineSessionId = randomUUID(); this.status = 'idle'; }
  async start() {}
  push(type, extra = {}) { if (type === 'status') this.status = extra.status; this.emit('event', { type, ...extra }); }
  async send(text) {
    this.sent = text;
    this.push('status', { status: 'working' });
    this.push('turn.start', { turnId: this.engineSessionId, text });
    this.push('item.start', { id: 'reply', kind: 'text', turnId: this.engineSessionId });
    this.push('item.delta', { id: 'reply', text: '- Plain English\n- Ask before pushing' });
    this.push('item.done', { id: 'reply', status: 'ok' });
    this.push('turn.done', { turnId: this.engineSessionId, status: 'ok' });
    this.push('status', { status: 'idle' });
  }
  async kill() { this.push('status', { status: 'exited' }); }
}

test('the keeper\'s helper never shows in the chat list, gets no Helm brief, and is gone after', async (t) => {
  const runtime = new EventEmitter();
  runtime.listLive = async () => new Map();
  const drivers = [];
  const sessions = new Sessions(runtime, { makeDriver: (_engine, opts) => { const d = new FakeDriver(opts); drivers.push(d); return d; } });
  sessions.delegationBrief = () => '[Helm: brief]';
  t.after(() => sessions.stop());
  const seen = [];
  let listedWhileRunning = null;
  const realResult = sessions.delegationResult.bind(sessions);
  sessions.delegationResult = (id, o) => {
    seen.push(id);
    if (!listedWhileRunning) listedWhileRunning = sessions.list({ includeDelegations: true });
    return realResult(id, o);
  };
  const cwd = join(process.env.HELM_DIR, 'keeper-run');
  const reply = await askHidden(sessions, { profileId: 'claude-main', model: undefined, mode: 'default', task: 'Update the list', cwd, pollMs: 5 });
  assert.match(reply, /- Ask before pushing/);
  assert.deepEqual(await listedWhileRunning, [], 'not listed, even with helpers included');
  assert.equal(drivers[0].instructions ?? null, null, 'no brief: everything it needs is in the task');
  assert.equal(drivers[0].sent, 'Update the list');
  assert.throws(() => sessions.get(seen[0]), 'deleted once it answered');
  const { session: normal } = await sessions.delegate({ cwd, profileId: 'claude-main', task: 'A normal helper' });
  assert.equal(drivers[1].instructions, '[Helm: brief]', 'a normal helper still gets it');
  assert.equal((await sessions.list()).some((s) => s.id === normal.id), true, 'and a normal helper with no chat is listed');
  await sessions.kill(normal.id);
});
