import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HELM_DIR ??= mkdtempSync(join(tmpdir(), 'helm-search-env-'));
const { SearchIndex, snippetFor, queryWords, searchable } = await import('../packages/connect/src/search-index.js');

const line = (e) => JSON.stringify(e) + '\n';
const chat = (id, title, extra = {}) => ({ id, title, driver: 'claude', engine: 'claude', cwd: '/home/me/proj', updatedAt: 1000, ...extra });

function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), 'helm-search-'));
  return { dir, file: join(dir, 'search-index.json') };
}

/** A log like the daemon writes: the owner's message, its echo, then a reply in pieces. */
function writeLog(dir, id, { you = 'Please make the lemon pie recipe shorter', reply = ['The recipe is now ', 'four steps long.'], seq = 1 } = {}) {
  let s = seq;
  const at = 1_700_000_000_000;
  const lines = [
    { seq: s++, at, type: 'turn.start', turnId: 't1', text: you, local: true },
    { seq: s++, at: at + 1, type: 'turn.start', turnId: 't1', text: you },
    { seq: s++, at: at + 2, type: 'item.start', id: 'i1', turnId: 't1', kind: 'thinking' },
    { seq: s++, at: at + 3, type: 'item.delta', id: 'i1', text: 'thinking about lemons' },
    { seq: s++, at: at + 4, type: 'item.done', id: 'i1' },
    { seq: s++, at: at + 5, type: 'item.start', id: 'i2', turnId: 't1', kind: 'text' },
    ...reply.map((text) => ({ seq: s++, at: at + 6, type: 'item.delta', id: 'i2', text })),
    { seq: s++, at: at + 9, type: 'item.done', id: 'i2' },
    { seq: s++, at: at + 10, type: 'turn.done', turnId: 't1' },
  ];
  writeFileSync(join(dir, `${id}.jsonl`), lines.map(line).join(''));
  return s;
}

test('builds from the logs: the owner\'s words once, the agent\'s reply joined from its pieces', async () => {
  const { dir, file } = freshDir();
  writeLog(dir, 'aaa111');
  const index = new SearchIndex({ dir, file });
  const sessions = [chat('aaa111', 'Lemon pie')];
  await index.update(sessions);

  const you = index.search('lemon pie', sessions);
  assert.equal(you.length, 1);
  assert.equal(you[0].id, 'aaa111');
  // The reply is the newest thing said, but "lemon pie" is only in the owner's message.
  assert.equal(you[0].who, 'you');
  assert.match(you[0].snippet, /lemon pie recipe/);

  // "four steps" was split across two deltas: a raw line scan would miss it.
  const agent = index.search('four steps', sessions);
  assert.equal(agent.length, 1);
  assert.equal(agent[0].who, 'agent');
  assert.equal(agent[0].snippet, 'The recipe is now four steps long.');

  // Thinking is not a reply, and a title-only match says so.
  assert.equal(index.search('thinking about', sessions).length, 0);
  const byTitle = index.search('pie', [chat('aaa111', 'Lemon pie')]);
  assert.equal(byTitle[0].who, 'you', 'the words beat the title when both match');
  const titleOnly = new SearchIndex({ dir: mkdtempSync(join(tmpdir(), 'helm-search-empty-')), file: join(dir, 'other.json') })
    .search('pie', [chat('zzz', 'Apple pie')]);
  assert.equal(titleOnly[0].who, 'title');
  assert.equal(titleOnly[0].snippet, '');
});

test('every word must appear in one thing said; nothing typed finds nothing', async () => {
  const { dir, file } = freshDir();
  writeLog(dir, 'aaa111');
  const index = new SearchIndex({ dir, file });
  const sessions = [chat('aaa111', 'Lemon pie')];
  await index.update(sessions);
  assert.equal(index.search('lemon four', sessions).length, 0, 'words from two different messages do not match');
  assert.equal(index.search('LEMON   Recipe', sessions).length, 1, 'case and spacing do not matter');
  assert.deepEqual(index.search('', sessions), []);
  assert.deepEqual(index.search('   ', sessions), []);
  assert.deepEqual(queryWords(' Two  words '), ['two', 'words']);
});

test('live events keep the index current without reading the log again; a rewind forgets what followed', async () => {
  const { dir, file } = freshDir();
  const seq = writeLog(dir, 'aaa111');
  const index = new SearchIndex({ dir, file });
  const sessions = [chat('aaa111', 'Lemon pie')];
  await index.update(sessions);
  assert.equal(index.search('mango', sessions).length, 0);

  index.note('aaa111', { seq, at: 5, type: 'turn.start', turnId: 't2', text: 'Now add a mango version' });
  assert.equal(index.search('mango', sessions)[0].who, 'you');
  index.note('aaa111', { seq: seq + 1, at: 6, type: 'item.start', id: 'i9', turnId: 't2', kind: 'text' });
  index.note('aaa111', { seq: seq + 2, at: 6, type: 'item.delta', id: 'i9', text: 'Mango ver' });
  index.note('aaa111', { seq: seq + 3, at: 6, type: 'item.delta', id: 'i9', text: 'sion added.' });
  assert.equal(index.search('version added', sessions).length, 0, 'a reply still arriving is not searchable yet');
  index.note('aaa111', { seq: seq + 4, at: 7, type: 'item.done', id: 'i9' });
  assert.equal(index.search('version added', sessions)[0].who, 'agent');

  // The log on disk has not changed: nothing to read, and the live entries stay.
  assert.equal(await index.update(sessions), 0);
  assert.equal(index.search('mango', sessions).length, 1);

  index.note('aaa111', { seq: seq + 5, at: 8, type: 'history.reset' });
  assert.equal(index.search('mango', sessions).length, 1, 'a reset keeps what came before its seq');
  index.note('aaa111', { seq: seq - 1, at: 8, type: 'history.reset' });
  assert.equal(index.search('mango', sessions).length, 0, 'what came after the reset point is gone');
  assert.equal(index.search('lemon', sessions).length, 1);
});

test('a message said while the logs are being read keeps its place, and the first build is shared', async () => {
  const { dir, file } = freshDir();
  writeLog(dir, 'aaa111');
  writeLog(dir, 'ccc333', { you: 'Tell me about the ocean tide', reply: ['Twice a day.'] });
  const index = new SearchIndex({ dir, file });
  const sessions = [chat('aaa111', 'Lemon pie'), chat('ccc333', 'Tides')];
  const first = index.ready(sessions);
  const second = index.ready(sessions);
  index.note('ccc333', { seq: 50, at: 1_700_000_000_999, type: 'turn.start', text: 'And the moon' });
  await Promise.all([first, second]);
  const hits = index.search('the', sessions);
  assert.equal(hits[0].id, 'ccc333');
  assert.equal(hits[0].snippet, 'And the moon', 'the newest thing said comes first even though it was noted mid-read');
  assert.equal(index.search('lemon', sessions).length, 1);
});

test('messages Helm wrote, wake-ups and local copies are not the owner\'s words', () => {
  const { dir, file } = freshDir();
  const index = new SearchIndex({ dir, file });
  const sessions = [chat('bbb222', 'Notes')];
  index.note('bbb222', { seq: 1, at: 1, type: 'turn.start', text: '[Helm: you are running on Laptop, zebra]' });
  index.note('bbb222', { seq: 2, at: 1, type: 'turn.start', text: 'A zebra crossing', wake: true });
  index.note('bbb222', { seq: 3, at: 1, type: 'turn.start', text: 'zebra', local: true });
  index.note('bbb222', { seq: 4, at: 1, type: 'turn.start', text: '/compact zebra' });
  assert.equal(index.search('zebra', sessions).length, 0);
  index.note('bbb222', { seq: 5, at: 1, type: 'turn.start', text: 'Paint the zebra stripes' });
  assert.equal(index.search('zebra', sessions).length, 1);
});

test('saved to disk and read back; a log that grew is read from where it stopped; gone chats are dropped', async () => {
  const { dir, file } = freshDir();
  const seq = writeLog(dir, 'aaa111');
  writeLog(dir, 'ccc333', { you: 'Tell me about the ocean tide', reply: ['Twice a day.'] });
  let index = new SearchIndex({ dir, file });
  const sessions = [chat('aaa111', 'Lemon pie'), chat('ccc333', 'Tides')];
  assert.equal(await index.update(sessions), 2);
  assert.equal(index.save(), true);
  assert.ok(existsSync(file));
  assert.equal(index.save(), false, 'nothing new: nothing written');

  // A restart: the file is the index, no log is read until one grows.
  index = new SearchIndex({ dir, file });
  assert.equal(index.size, 2);
  assert.equal(await index.update(sessions), 0);
  assert.equal(index.search('ocean', sessions)[0].id, 'ccc333');

  appendFileSync(join(dir, 'aaa111.jsonl'), line({ seq, at: 99, type: 'turn.start', turnId: 't3', text: 'Also a kiwi tart' }));
  assert.equal(await index.update(sessions), 1);
  assert.equal(index.search('kiwi', sessions)[0].who, 'you');
  assert.equal(index.search('lemon', sessions).length, 1, 'earlier entries were not read twice');

  // The owner deleted the tides chat: its words go with it.
  await index.update([chat('aaa111', 'Lemon pie')]);
  assert.equal(index.search('ocean', [chat('aaa111', 'Lemon pie'), chat('ccc333', 'Tides')]).length, 0);
  index.save();
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(saved.chats), ['aaa111']);
});

test('newest match first, limited, and only chats worth finding', () => {
  const { dir, file } = freshDir();
  const index = new SearchIndex({ dir, file });
  const sessions = [
    chat('old', 'Old', { updatedAt: 1 }), chat('new', 'New', { updatedAt: 2 }),
    chat('helper', 'Helper', { delegation: { parentId: 'new' } }),
    chat('term', 'zsh', { engine: 'shell', driver: null }),
    chat('brain', 'Helm brain', { brain: true }),
  ];
  index.note('old', { seq: 1, at: 100, type: 'turn.start', text: 'about pelicans' });
  index.note('new', { seq: 1, at: 200, type: 'turn.start', text: 'more pelicans please' });
  index.note('helper', { seq: 1, at: 300, type: 'turn.start', text: 'pelicans in a helper' });
  const hits = index.search('pelicans', sessions);
  assert.deepEqual(hits.map((h) => h.id), ['new', 'old']);
  assert.deepEqual(index.search('pelicans', sessions, { limit: 1 }).map((h) => h.id), ['new']);
  assert.equal(searchable(sessions[2]), false);
  assert.equal(searchable(sessions[3]), false);
  assert.equal(searchable(sessions[4]), false);
});

test('the snippet shows the matching words, with the rest cut around them', () => {
  const long = 'x'.repeat(200) + ' the needle is here ' + 'y'.repeat(200);
  const s = snippetFor(long, ['needle']);
  assert.ok(s.length <= 124, s.length);
  assert.match(s, /needle/);
  assert.ok(s.startsWith('…') && s.endsWith('…'));
  assert.equal(snippetFor('short text', ['short']), 'short text');
});
