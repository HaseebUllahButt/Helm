import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, appendFileSync, renameSync, openSync, closeSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HELM_DIR ??= mkdtempSync(join(tmpdir(), 'helm-search-env-'));
const { SearchIndex, snippetFor, queryWords, searchable } = await import('../packages/connect/src/search-index.js');
const { EventLog } = await import('../packages/connect/src/events.js');

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

test('search keeps short substring matches and Unicode case folding', () => {
  const { dir, file } = freshDir();
  const index = new SearchIndex({ dir, file });
  const sessions = [chat('aaa111', 'Notes')];
  index.note('aaa111', { seq: 1, at: 1, type: 'turn.start', text: 'Ångström and café' });
  assert.equal(index.search('ng', sessions).length, 1);
  assert.equal(index.search('ångström CAFÉ', sessions).length, 1);
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
  assert.equal(index.search('mango', sessions).length, 0, 'a reset clears all old entries');
  index.note('aaa111', { seq: seq - 1, at: 8, type: 'history.reset' });
  assert.equal(index.search('lemon', sessions)[0].who, 'title', 'reset removes the old message match');
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

test('the first disk read includes older history after a live event was noted', async () => {
  const { dir, file } = freshDir();
  writeFileSync(join(dir, 'aaa111.jsonl'), line({ seq: 1, at: 1, type: 'turn.start', text: 'old marker' }));
  const index = new SearchIndex({ dir, file });
  const sessions = [chat('aaa111', 'Notes')];
  index.note('aaa111', { seq: 2, at: 2, type: 'turn.start', text: 'live marker' });
  await index.update(sessions);
  assert.equal(index.search('old marker', sessions).length, 1);
  assert.equal(index.search('live marker', sessions).length, 1);
});

test('a saved live event is not indexed twice when it later reaches the log', async () => {
  const { dir, file } = freshDir();
  const log = join(dir, 'aaa111.jsonl');
  writeFileSync(log, line({ seq: 1, at: 1, type: 'turn.start', text: 'old marker' }));
  const sessions = [chat('aaa111', 'Notes')];
  let index = new SearchIndex({ dir, file });
  index.note('aaa111', { seq: 2, at: 2, type: 'turn.start', text: 'live marker' });
  await index.update(sessions);
  index.save();
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).chats.aaa111.liveRanges, [[2, 2]]);
  appendFileSync(log, line({ seq: 2, at: 2, type: 'turn.start', text: 'live marker' }));
  index = new SearchIndex({ dir, file });
  await index.update(sessions);
  assert.equal(index.search('marker', sessions)[0].count, 2);
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
  assert.equal(index.bytesRead, 0, 'saved byte offsets avoid rereading the old log');
  assert.equal(index.search('ocean', sessions)[0].id, 'ccc333');

  const appended = line({ seq, at: 99, type: 'turn.start', turnId: 't3', text: 'Also a kiwi tart' });
  appendFileSync(join(dir, 'aaa111.jsonl'), appended);
  assert.equal(await index.update(sessions), 1);
  assert.ok(index.bytesRead >= Buffer.byteLength(appended));
  assert.ok(index.bytesRead <= Buffer.byteLength(appended) + 128, 'one appended event reads only its bytes and short witnesses');
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

test('repeated queries reuse matches and live entries and rewinds invalidate them', () => {
  const { dir, file } = freshDir();
  const index = new SearchIndex({ dir, file });
  const sessions = [chat('aaa111', 'Notes')];
  index.note('aaa111', { seq: 1, at: 1, type: 'turn.start', text: 'A blue whale' });
  assert.equal(index.search('blue', sessions)[0].count, 1);
  assert.equal(index.search('blue', sessions)[0].count, 1);
  index.note('aaa111', { seq: 2, at: 2, type: 'turn.start', text: 'A blue bird' });
  assert.equal(index.search('blue', sessions)[0].count, 2);
  assert.equal(index.search('blue', sessions)[0].snippet, 'A blue bird');
  index.note('aaa111', { seq: 1, at: 3, type: 'history.reset' });
  assert.equal(index.search('blue', sessions).length, 0);
});

test('a torn final line is read when completed, and replacement logs are noticed', async () => {
  const { dir, file } = freshDir();
  const log = join(dir, 'aaa111.jsonl');
  writeFileSync(log, line({ seq: 1, at: 1, type: 'turn.start', text: 'old phrase' }));
  const index = new SearchIndex({ dir, file });
  const sessions = [chat('aaa111', 'Notes')];
  await index.update(sessions);

  const partial = JSON.stringify({ seq: 2, at: 2, type: 'turn.start', text: 'new phrase' });
  appendFileSync(log, partial.slice(0, 20));
  await index.update(sessions);
  assert.equal(index.search('new', sessions).length, 0);
  appendFileSync(log, partial.slice(20) + '\n');
  await index.update(sessions);
  assert.equal(index.search('new', sessions)[0].count, 1);

  writeFileSync(log, line({ seq: 1, at: 3, type: 'history.reset' }) + line({ seq: 2, at: 4, type: 'turn.start', text: 'trimmed log words' }));
  await index.update(sessions);
  assert.equal(index.search('old', sessions).length, 0);
  assert.equal(index.search('trimmed', sessions)[0].snippet, 'trimmed log words');

  const replacement = join(dir, 'replacement.jsonl');
  writeFileSync(replacement, line({ seq: 1, at: 3, type: 'history.reset' }) + line({ seq: 2, at: 4, type: 'turn.start', text: 'fresh phrase' }));
  index.note('aaa111', { seq: 3, at: 5, type: 'item.start', id: 'stale', kind: 'text' });
  index.note('aaa111', { seq: 4, at: 6, type: 'item.delta', id: 'stale', text: 'discarded reply' });
  renameSync(replacement, log);
  await index.update(sessions);
  assert.equal(index.search('old', sessions).length, 0);
  assert.equal(index.search('fresh', sessions)[0].snippet, 'fresh phrase');
  appendFileSync(log, line({ seq: 3, at: 5, type: 'item.delta', id: 'stale', text: ' after replacement' })
    + line({ seq: 4, at: 6, type: 'item.done', id: 'stale' }));
  await index.update(sessions);
  assert.equal(index.search('discarded reply', sessions).length, 0, 'replacement clears unfinished replies');
});

test('an unfinished reply survives a restart and accepts later pieces', async () => {
  const { dir, file } = freshDir();
  const log = join(dir, 'aaa111.jsonl');
  const first = line({ seq: 1, at: 1, type: 'item.start', id: 'reply', kind: 'text' })
    + line({ seq: 2, at: 2, type: 'item.delta', id: 'reply', text: 'split across ' });
  writeFileSync(log, first);
  const sessions = [chat('aaa111', 'Notes')];
  let index = new SearchIndex({ dir, file });
  await index.update(sessions);
  index.save();

  index = new SearchIndex({ dir, file });
  const rest = line({ seq: 3, at: 3, type: 'item.delta', id: 'reply', text: 'a restart' })
    + line({ seq: 4, at: 4, type: 'item.done', id: 'reply' });
  appendFileSync(log, rest);
  await index.update(sessions);
  assert.equal(index.search('across restart', sessions)[0].snippet, 'split across a restart');
});

test('legacy saved indexes rebuild open replies, and saved chat data omits match caches', async () => {
  const { dir, file } = freshDir();
  const log = join(dir, 'aaa111.jsonl');
  const start = line({ seq: 1, at: 1, type: 'item.start', id: 'legacy', kind: 'text' });
  const delta = line({ seq: 2, at: 2, type: 'item.delta', id: 'legacy', text: 'old index reply' });
  writeFileSync(log, start + delta);
  writeFileSync(file, JSON.stringify({ v: 1, chats: { aaa111: { last: 2, size: Buffer.byteLength(start + delta), entries: [] } } }));
  appendFileSync(log, line({ seq: 3, at: 3, type: 'item.delta', id: 'legacy', text: ' resumes' })
    + line({ seq: 4, at: 4, type: 'item.done', id: 'legacy' }));
  const sessions = [chat('aaa111', 'Notes')];
  const index = new SearchIndex({ dir, file });
  await index.update(sessions);
  assert.equal(index.search('reply resumes', sessions).length, 1);
  index.search('reply', sessions);
  index.save();
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal('matchCache' in saved.chats.aaa111, false);
  assert.equal('lower' in saved.chats.aaa111, false);
  assert.equal('lower' in saved.chats.aaa111.entries[0], false);
});

test('same-size and larger in-place rewrites replace stale indexed content', async () => {
  const { dir, file } = freshDir();
  const log = join(dir, 'aaa111.jsonl');
  const first = line({ seq: 1, at: 1, type: 'turn.start', text: 'old phrase' });
  writeFileSync(log, first);
  const index = new SearchIndex({ dir, file });
  const sessions = [chat('aaa111', 'Notes')];
  await index.update(sessions);

  writeFileSync(log, line({ seq: 1, at: 2, type: 'turn.start', text: 'new phrase' }));
  const newer = new Date(Date.now() + 2_000);
  utimesSync(log, newer, newer);
  assert.equal(statSync(log).size, Buffer.byteLength(first));
  await index.update(sessions);
  assert.equal(index.search('old phrase', sessions).length, 0);
  assert.equal(index.search('new phrase', sessions).length, 1);

  const rewritten = line({ seq: 100, at: 3, type: 'history.reset' })
    + line({ seq: 101, at: 4, type: 'turn.start', text: `fresh ${'word '.repeat(30)}` });
  writeFileSync(log, rewritten);
  await index.update(sessions);
  assert.equal(index.search('new phrase', sessions).length, 0);
  assert.equal(index.search('fresh word', sessions).length, 1);
});

test('a valid final JSON event without a newline is indexed', async () => {
  const { dir, file } = freshDir();
  writeFileSync(join(dir, 'aaa111.jsonl'), JSON.stringify({ seq: 1, at: 1, type: 'turn.start', text: 'final line' }));
  const index = new SearchIndex({ dir, file });
  const sessions = [chat('aaa111', 'Notes')];
  await index.update(sessions);
  assert.equal(index.search('final line', sessions).length, 1);
  appendFileSync(join(dir, 'aaa111.jsonl'), '\n');
  await index.update(sessions);
  assert.equal(index.search('final line', sessions).length, 1, 'the following newline completes the same event');
});

test('an EventLog rewind clears discarded words and keeps replayed history', async () => {
  const { dir, file } = freshDir();
  const events = new EventLog(dir);
  events.append('aaa111', { type: 'turn.start', text: 'discard this phrase' });
  const index = new SearchIndex({ dir, file });
  const sessions = [chat('aaa111', 'Notes')];
  await index.update(sessions);
  events.rewind('aaa111', [{ type: 'turn.start', text: 'retained phrase' }]);
  await index.update(sessions);
  assert.equal(index.search('discard this', sessions).length, 0);
  assert.equal(index.search('retained phrase', sessions).length, 1);
});

test('dropping a chat also drops its unfinished reply buffer', async () => {
  const { dir, file } = freshDir();
  const index = new SearchIndex({ dir, file });
  const sessions = [chat('aaa111', 'Notes')];
  index.note('aaa111', { seq: 1, at: 1, type: 'item.start', id: 'open', kind: 'text' });
  index.note('aaa111', { seq: 2, at: 2, type: 'item.delta', id: 'open', text: 'unfinished' });
  await index.update([]);
  index.save();
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(saved.open, {});
});

test('legacy reply recovery counts a new delta once and accepts a done-only continuation', async () => {
  for (const withDelta of [false, true]) {
    const { dir, file } = freshDir(), log = join(dir, 'aaa111.jsonl');
    const first = line({ seq: 1, type: 'item.start', id: 'reply', kind: 'text' })
      + line({ seq: 2, type: 'item.delta', id: 'reply', text: 'Original' });
    const rest = (withDelta ? line({ seq: 3, type: 'item.delta', id: 'reply', text: ' continuation' }) : '')
      + line({ seq: 4, type: 'item.done', id: 'reply' });
    writeFileSync(log, first + rest);
    writeFileSync(file, JSON.stringify({ v: 1, chats: { aaa111: { last: 2, size: Buffer.byteLength(first), entries: [] } } }));
    const index = new SearchIndex({ dir, file });
    const sessions = [chat('aaa111', 'Notes')];
    await index.update(sessions);
    assert.equal(index.search('Original', sessions)[0].snippet, withDelta ? 'Original continuation' : 'Original');
    index.close();
  }
});

test('a first disk read after a live rewind keeps the replayed words', async () => {
  const { dir, file } = freshDir(), events = new EventLog(dir), index = new SearchIndex({ dir, file });
  events.append('aaa111', { type: 'turn.start', text: 'Discarded words' });
  for (const event of events.rewind('aaa111', [{ type: 'turn.start', text: 'Kept words' }])) index.note('aaa111', event);
  const sessions = [chat('aaa111', 'Notes')];
  await index.update(sessions);
  assert.equal(index.search('Discarded', sessions).length, 0);
  assert.equal(index.search('Kept', sessions)[0].count, 1);
  index.close();
});

test('a live delta first seen without its start is recovered from disk', async () => {
  const { dir, file } = freshDir(), index = new SearchIndex({ dir, file });
  const events = [
    { seq: 1, type: 'item.start', id: 'reply', kind: 'text' },
    { seq: 2, type: 'item.delta', id: 'reply', text: 'Recovered answer' },
    { seq: 3, type: 'item.done', id: 'reply' },
  ];
  writeFileSync(join(dir, 'aaa111.jsonl'), events.map(line).join(''));
  index.note('aaa111', events[1]); index.note('aaa111', events[2]);
  const sessions = [chat('aaa111', 'Notes')];
  await index.update(sessions);
  assert.equal(index.search('Recovered answer', sessions)[0].snippet, 'Recovered answer');
  index.close();
});

test('streamed live delivery uses compact ranges and old disk entries do not evict newer live entries', async () => {
  const { dir, file } = freshDir(), index = new SearchIndex({ dir, file });
  const events = Array.from({ length: 500 }, (_, n) => ({ seq: n + 1, type: 'turn.start', text: 'Old entry ' + n }));
  writeFileSync(join(dir, 'aaa111.jsonl'), events.map(line).join(''));
  index.note('aaa111', { seq: 501, type: 'turn.start', text: 'Latest live marker' });
  index.note('aaa111', { seq: 502, type: 'item.start', id: 'stream', kind: 'text' });
  for (let seq = 503; seq < 10000; seq++) index.note('aaa111', { seq, type: 'item.delta', id: 'stream', text: 'x' });
  index.save();
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).chats.aaa111.liveRanges, [[501, 9999]]);
  const sessions = [chat('aaa111', 'Notes')];
  await index.update(sessions);
  assert.equal(index.search('Latest live marker', sessions).length, 1);
  assert.equal(index.search('Old entry', sessions)[0].count, 399);
  index.close();
});

test('upgrading an old index recovers missed history and retains words from trimmed logs', async () => {
  const { dir, file } = freshDir();
  const old = { seq: 1, at: 1, type: 'turn.start', text: 'Missed historical marker' };
  const recent = { seq: 2, at: 2, type: 'turn.start', text: 'Recent live marker' };
  const body = [old, recent].map(line).join('');
  writeFileSync(join(dir, 'aaa111.jsonl'), body);
  writeFileSync(file, JSON.stringify({ v: 1, chats: { aaa111: {
    last: 2, size: Buffer.byteLength(body), entries: [
      { who: 'you', seq: 0, at: 0, text: 'Words from a trimmed log' },
      { who: 'you', seq: 2, at: 2, text: recent.text },
    ],
  } } }));
  const index = new SearchIndex({ dir, file });
  const sessions = [chat('aaa111', 'Notes')];
  await index.update(sessions);
  assert.equal(index.search('Missed historical', sessions).length, 1);
  assert.equal(index.search('Recent live', sessions)[0].count, 1);
  assert.equal(index.search('trimmed log', sessions).length, 1);
  index.close();
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).v, 2);
});
