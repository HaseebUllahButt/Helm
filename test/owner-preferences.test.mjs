import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-owner-'));
process.env.HELM_NO_SERVICE = '1';
process.env.HELM_SSH_DIR = join(process.env.HELM_DIR, 'ssh');
process.env.HELM_DB = join(process.env.HELM_DIR, 'hub.sqlite');
process.env.HELM_PROCS_SOCKET = join(process.env.HELM_DIR, 'procs.sock');
process.env.HELM_TERMINALS_SOCKET = join(process.env.HELM_DIR, 'terminals.sock');
process.env.HELM_NATIVE_SOCKET = join(process.env.HELM_DIR, 'native.sock');
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));

const { SEED, OWNER_FILE, loadOwner, editOwner, mergeOwner, checkOwner, ownerHash, newerOwner } = await import('../packages/protocol/owner.js');
const { OwnerKeeper, ownerWords, ownerText, parseKeeperReply } = await import('../packages/connect/src/owner-keeper.js');
const { M } = await import('@helm/protocol');

const reset = () => rmSync(OWNER_FILE, { force: true });
const otherFile = () => join(mkdtempSync(join(process.env.HELM_DIR, 'machine-')), 'owner.json');

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
});

function keeperRig({ words, reply = '- Plain English: short replies.' }) {
  const net = { self: 'home', machines: { home: { id: 'home', name: 'vm', kind: 'vm', addedAt: 1 }, lap: { id: 'lap', name: 'laptop', addedAt: 2 } } };
  const file = join(mkdtempSync(join(process.env.HELM_DIR, 'keeper-')), 'state.json');
  const keeper = new OwnerKeeper({
    self: () => 'home', name: () => 'vm', network: () => net, file, now: () => 1_000_000_000,
    words: async (p) => words.home(p),
    rpc: async (env, method, p) => { assert.equal(method, M.OWNER_WORDS); return words[env](p); },
    agents: async () => [{ id: 'claude-main', engine: 'claude', available: true, cheapModel: 'haiku' }],
    ask: async () => reply,
    changed: () => {},
  });
  return { keeper, file };
}

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
