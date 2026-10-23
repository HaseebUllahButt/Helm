import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, renameSync, rmSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncrementalTranscript, messages } from '../packages/connect/src/transcript.js';
import { ExternalSessions } from '../packages/connect/src/session-external.js';
import { EventLog } from '../packages/connect/src/events.js';
import { SessionViewers } from '../packages/connect/src/session-viewers.js';

const root = mkdtempSync(join(tmpdir(), 'helm-incremental-transcripts-'));
test.after(() => rmSync(root, { recursive: true, force: true }));
const encode = record => JSON.stringify(record) + '\n';
const codex = (text, role = 'assistant', id = text) => ({ type: 'response_item', timestamp: '2026-10-23',
  payload: { type: 'message', role, id, content: [{ type: 'output_text', text }] } });
const claude = (content, id = 'a', type = 'assistant', extra = {}) => ({ type, timestamp: '2026-10-23',
  message: { id, content }, ...extra });

for (const engine of ['codex', 'claude']) {
  test(`${engine}: successive appends match full parses and preserve their order`, async () => {
    const path = join(root, `${engine}-appends.jsonl`);
    writeFileSync(path, '');
    const reader = new IncrementalTranscript({ engine, path });
    const records = engine === 'codex' ? [
      codex('# AGENTS.md instructions for /work', 'user'),
      codex('Fix this', 'user'),
      { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":"ls"}' } },
      { type: 'response_item', payload: { type: 'function_call_output', output: 'tool output' } },
      codex('Ready'),
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [
        { type: 'input_text', text: '[Image #1]' }, { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' },
      ] } },
      codex('x'.repeat(9000)),
    ] : [
      claude('Fix this', 'u', 'user'),
      claude([{ type: 'thinking', thinking: 'hidden' }]),
      claude([{ type: 'text', text: 'Checking' }]),
      claude([{ type: 'tool_use', name: 'Bash', input: { command: 'ls', description: 'List files' } }]),
      claude([{ type: 'tool_result', content: 'result' }], 'result', 'user'),
      claude('Outside', 'side', 'assistant', { isSidechain: true }),
      claude('Next turn', 'next', 'user'),
      // A late snapshot changes an earlier reply without moving it.
      claude([{ type: 'text', text: 'Checking files' },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]),
      claude([{ type: 'text', text: 'Finished' }], 'b'),
      claude('x'.repeat(9000), 'long'),
    ];
    for (const record of records) {
      appendFileSync(path, encode(record));
      const actual = await reader.read();
      assert.deepEqual(actual.messages, await messages({ engine, path, all: true }));
    }
    const saved = (await reader.read()).messages;
    saved[0].text = 'Caller changed this';
    assert.deepEqual((await reader.read()).messages, await messages({ engine, path, all: true }));
    assert.equal((await reader.read()).bytesRead, 0);
    assert.deepEqual(await messages({ engine, path, limit: 1 }), saved.slice(-1));
  });

  test(`${engine}: read bytes follow appended data, including partial Unicode lines`, async () => {
    const path = join(root, `${engine}-bytes.jsonl`);
    const record = text => engine === 'codex' ? codex(text) : claude(text, text);
    const initial = Array.from({ length: 4000 }, (_, i) => encode(record(`message ${i}`))).join('');
    writeFileSync(path, initial);
    const reader = new IncrementalTranscript({ engine, path });
    const first = await reader.read();
    assert.ok(first.bytesRead >= Buffer.byteLength(initial));
    assert.ok(first.bytesRead <= Buffer.byteLength(initial) + 512);
    assert.equal((await reader.read()).bytesRead, 0);
    const bytes = Buffer.from(encode(record('Text 🌍 中文')));
    const split = bytes.indexOf(Buffer.from('🌍')) + 2;
    appendFileSync(path, bytes.subarray(0, split));
    const partial = await reader.read();
    assert.deepEqual(partial.messages, first.messages);
    assert.ok(partial.bytesRead <= split + 1024);
    assert.equal((await reader.read()).bytesRead, 0);
    appendFileSync(path, bytes.subarray(split));
    const complete = await reader.read();
    assert.ok(complete.bytesRead <= bytes.length - split + 1024);
    assert.equal(complete.messages.at(-1).text, 'Text 🌍 中文');
    assert.deepEqual(complete.messages, await messages({ engine, path, all: true }));
    assert.equal((await reader.read()).bytesRead, 0);
    // A valid EOF record is visible before its newline, as in a full parse.
    appendFileSync(path, JSON.stringify(record('No newline yet')));
    const eof = await reader.read();
    assert.deepEqual(eof.messages, await messages({ engine, path, all: true }));
    appendFileSync(path, '\nmalformed\n\n');
    assert.deepEqual((await reader.read()).messages, await messages({ engine, path, all: true }));
  });

  test(`${engine}: reset after rewrites, truncation, replacement and restart`, async () => {
    const path = join(root, `${engine}-reset.jsonl`);
    const record = text => engine === 'codex' ? codex(text) : claude(text, text);
    const reader = new IncrementalTranscript({ engine, path });
    writeFileSync(path, encode(record('Before')));
    await reader.read();
    for (const text of ['After!', 'A much longer replacement', '', 'New']) {
      writeFileSync(path, text ? encode(record(text)) : '');
      const actual = await reader.read();
      assert.equal(actual.reset, text !== 'New');
      assert.deepEqual(actual.messages, await messages({ engine, path, all: true }));
    }
    const info = statSync(path);
    const replacement = join(root, `${engine}-replacement.jsonl`);
    writeFileSync(replacement, encode(record('Old')));
    utimesSync(replacement, info.atime, info.mtime);
    renameSync(replacement, path);
    const replaced = await reader.read();
    assert.equal(replaced.reset, true);
    assert.deepEqual(replaced.messages, await messages({ engine, path, all: true }));
    const restarted = new IncrementalTranscript({ engine, path });
    assert.deepEqual((await restarted.read()).messages, replaced.messages);
    appendFileSync(path, encode(record('Restart append')));
    const reads = await Promise.all([restarted.read(), restarted.read()]);
    assert.deepEqual(reads[0].messages, await messages({ engine, path, all: true }));
    assert.deepEqual(reads[1].messages, reads[0].messages);
    assert.equal(reads[1].bytesRead, 0);
  });
}

test('Claude sidechains and records larger than one read match full parses', async () => {
  const path = join(root, 'sidechain.jsonl');
  writeFileSync(path, encode(claude('main', 'm')));
  const reader = new IncrementalTranscript({ engine: 'claude', path, sidechain: true });
  await reader.read();
  appendFileSync(path, encode(claude('字'.repeat(40000), 's', 'assistant', { isSidechain: true })));
  appendFileSync(path, encode(claude([{ type: 'tool_use', name: 'Read', input: { path: '/work' } }], 's', 'assistant', { isSidechain: true })));
  assert.deepEqual((await reader.read()).messages, await messages({ engine: 'claude', path, all: true, sidechain: true }));
});

function importer(engine, path, saved = {}) {
  const session = { id: 'chat', engine, transcript: path, external: true, driver: true,
    externalTextVersion: 1, externalImagesVersion: 1, ...saved };
  let events = [], restarts = 0;
  const eventDir = mkdtempSync(join(root, 'mock-events-'));
  const eventFile = join(eventDir, 'chat.jsonl');
  writeFileSync(eventFile, '');
  const sessions = { get: () => session, emit() {}, events: {
    dir: eventDir,
    restart() { throw new Error('Do not delete local attachment files.'); },
    replace(id, kept) { restarts++; events = kept; writeFileSync(eventFile, kept.map(encode).join('')); },
    last: () => events.at(-1)?.seq ?? 0,
    append(id, event) { const saved = { ...event, seq: (events.at(-1)?.seq ?? 0) + 1 }; events.push(saved); appendFileSync(eventFile, encode(saved)); return saved; },
    tail: () => events,
  } };
  const core = { index: new Map([['chat', session]]), save() {} };
  const external = new ExternalSessions(sessions, core);
  core.external = external;
  return { session, external, sessions, core, events: () => events, restarts: () => restarts };
}

test('viewer reads cannot hide snapshots or replacement from the importer', async () => {
  const path = join(root, 'import.jsonl');
  writeFileSync(path, encode(claude('hello', 'u', 'user')) + encode(claude('Checking')));
  const h = importer('claude', path);
  await h.external.importExternalTranscript(h.session);
  assert.equal(h.session.externalImported, 2);
  appendFileSync(path, encode(claude('Checking files')) + encode(claude('Next', 'u2', 'user')));
  const viewer = new SessionViewers(h.sessions, h.core);
  h.session.driver = false;
  const viewed = await viewer.messages('chat');
  assert.deepEqual(viewed.messages.map(m => m.text), ['hello', 'Checking files', 'Next']);
  viewer.stop();
  h.session.driver = true;
  await h.external.importExternalTranscript(h.session);
  assert.equal(h.session.externalImported, 3);
  assert.equal(h.restarts(), 0);
  assert.equal(h.events().filter(e => e.type === 'item.delta').map(e => e.text).join(''), 'Checking files');
  const before = h.events().length;
  await h.external.importExternalTranscript(h.session);
  assert.equal(h.events().length, before);
  const restarted = importer('claude', path, { ...h.session });
  await restarted.external.importExternalTranscript(restarted.session);
  assert.equal(restarted.restarts(), 0);
  assert.equal(restarted.events().length, 0, 'saved import counts survive a new reader');
  writeFileSync(path, encode(claude('Changed', 'u3', 'user')));
  await h.external.readTranscript(h.session);
  await h.external.importExternalTranscript(h.session);
  assert.equal(h.restarts(), 1);
  assert.equal(h.session.externalImported, 1);
  assert.deepEqual(h.events().filter(e => e.type === 'turn.start').map(e => e.text), ['Changed']);
  const replacedWhileStopped = join(root, 'import-replaced.jsonl');
  writeFileSync(replacedWhileStopped, encode(claude('Other', 'u4', 'user')));
  renameSync(replacedWhileStopped, path);
  const afterReplacement = importer('claude', path, { ...h.session });
  await afterReplacement.external.importExternalTranscript(afterReplacement.session);
  assert.equal(afterReplacement.restarts(), 1);
  assert.deepEqual(afterReplacement.events().filter(e => e.type === 'turn.start').map(e => e.text), ['Other']);
});

test('a busy writer does not block the first import', async () => {
  const path = join(root, 'busy.jsonl');
  writeFileSync(path, Array.from({ length: 10000 }, (_, i) => encode(codex(`message ${i}`))).join(''));
  const reader = new IncrementalTranscript({ engine: 'codex', path });
  let writes = 0;
  const timer = setInterval(() => appendFileSync(path, encode(codex(`appended ${writes++}`))), 1);
  let first;
  try { first = await reader.read(); } finally { clearInterval(timer); }
  assert.ok(writes > 0, 'the writer appends during the read');
  assert.ok(first.messages.length >= 10000 && first.messages.length <= 10000 + writes);
  assert.ok(Number(first.revision.size) <= statSync(path).size);
  const final = await reader.read();
  assert.deepEqual(final.messages, await messages({ engine: 'codex', path, all: true }));
  assert.equal((await reader.read()).bytesRead, 0);
});

test('a new importer extends the saved final item and adds turns written while Helm was stopped', async () => {
  const path = join(root, 'stopped.jsonl');
  writeFileSync(path, encode(claude('Ask', 'u', 'user')) + encode(claude('Part')));
  const before = importer('claude', path);
  await before.external.importExternalTranscript(before.session);
  appendFileSync(path, encode(claude('Part complete')) + encode(claude('Next', 'u2', 'user')));
  const after = importer('claude', path, { ...before.session });
  await after.external.importExternalTranscript(after.session);
  assert.equal(after.restarts(), 0);
  assert.deepEqual(after.events().filter(e => e.type === 'item.delta').map(e => e.text), [' complete']);
  assert.deepEqual(after.events().filter(e => e.type === 'turn.start').map(e => e.text), ['Next']);
  const count = after.events().length;
  await after.external.importExternalTranscript(after.session);
  assert.equal(after.events().length, count);
});

test('replacement drops unfinished bytes, and same-size interior rewrites rebuild parsed messages', async () => {
  const path = join(root, 'interior.jsonl');
  const records = [codex('head'.repeat(100)), codex('old middle'), codex('tail'.repeat(100))];
  writeFileSync(path, records.map(encode).join(''));
  const reader = new IncrementalTranscript({ engine: 'codex', path });
  await reader.read();
  records[1] = codex('new middle');
  writeFileSync(path, records.map(encode).join(''));
  const rewritten = await reader.read();
  assert.equal(rewritten.reset, true);
  assert.deepEqual(rewritten.messages, await messages({ engine: 'codex', path, all: true }));
  appendFileSync(path, Buffer.from('{"unfinished":"🌍').subarray(0, -2));
  await reader.read();
  const replacement = join(root, 'partial-replacement.jsonl');
  writeFileSync(replacement, encode(codex('replacement')));
  renameSync(replacement, path);
  assert.deepEqual((await reader.read()).messages, await messages({ engine: 'codex', path, all: true }));
  appendFileSync(path, encode(codex('after replacement')));
  assert.deepEqual((await reader.read()).messages, await messages({ engine: 'codex', path, all: true }));
});

test('final Claude snapshots extend the same item without replacing events or copying unchanged history', async t => {
  const path = join(root, 'tail-growth.jsonl');
  writeFileSync(path, encode(claude('Ask', 'u', 'user')) + encode(claude('Part')));
  const h = importer('claude', path);
  let saves = 0;
  h.core.save = () => saves++;
  t.mock.method(globalThis, 'structuredClone', () => { throw new Error('Do not copy the whole importer history.'); });
  await h.external.importExternalTranscript(h.session);
  const original = h.events().slice(), itemId = h.session.externalTail.itemId;
  const first = await h.external.readTranscript(h.session);
  const unchanged = await h.external.readTranscript(h.session);
  assert.equal(unchanged.messages, first.messages, 'trusted reads share the current parsed array');
  assert.equal(unchanged.bytesRead, 0);
  const saved = saves;
  await h.external.importExternalTranscript(h.session);
  assert.equal(saves, saved, 'unchanged reads do not save the chat');
  assert.deepEqual(h.events(), original, 'unchanged reads do not write events');
  appendFileSync(path, encode(claude('Part complete')));
  await h.external.importExternalTranscript(h.session);
  assert.equal(h.restarts(), 0);
  assert.equal(h.session.externalTail.itemId, itemId);
  assert.deepEqual(h.events().slice(0, original.length), original);
  assert.deepEqual(h.events().slice(original.length).map(e => [e.type, e.id, e.text]), [['item.delta', itemId, ' complete']]);
  appendFileSync(path, encode(claude([{ type: 'text', text: 'Part complete' },
    { type: 'tool_use', name: 'Read', input: { path: '/work' } }])));
  await h.external.importExternalTranscript(h.session);
  assert.equal(h.restarts(), 0);
  assert.equal(h.events().filter(e => e.kind === 'tool').length, 1);
  const count = h.events().length;
  await h.external.importExternalTranscript(h.session);
  assert.equal(h.events().length, count);
});

test('managed native viewers keep the bounded tail read and never request shared full history', async () => {
  const path = join(root, 'native-tail.jsonl');
  writeFileSync(path, encode(codex('old')) + encode({ ignored: 'x'.repeat((4 << 20) + 1024) }) + encode(codex('new')));
  const h = importer('codex', path, { external: false, driver: false, nativeChat: true });
  h.core.external = { readTranscript() { throw new Error('Keep native reads bounded.'); } };
  const viewer = new SessionViewers(h.sessions, h.core);
  try {
    const result = await viewer.messages('chat');
    assert.deepEqual(result.messages, await messages({ engine: 'codex', path }));
    assert.deepEqual(result.messages.map(m => m.text), ['new']);
  } finally { viewer.stop(); }
});

test('external viewers copy only their requested page before changing image messages', async t => {
  const path = join(root, 'viewer-page.jsonl');
  writeFileSync(path, Array.from({ length: 200 }, (_, i) => encode(codex(`prompt ${i}`, 'user'))).join(''));
  const h = importer('codex', path, { driver: false });
  const parsed = await h.external.readTranscript(h.session);
  const clone = globalThis.structuredClone;
  const sizes = [];
  t.mock.method(globalThis, 'structuredClone', value => { sizes.push(value.length); return clone(value); });
  const viewer = new SessionViewers(h.sessions, h.core);
  try {
    const result = await viewer.messages('chat', { limit: 1 });
    assert.deepEqual(sizes, [1]);
    result.messages[0].text = 'Changed by a caller';
    assert.equal(parsed.messages.at(-1).text, 'prompt 199');
  } finally { viewer.stop(); }
});

test('earlier snapshot changes and file replacement keep local visuals, native images, and attachment files', async () => {
  const path = join(root, 'local-history.jsonl');
  writeFileSync(path, encode(claude('Ask', 'u', 'user')) + encode(claude('First', 'a')) + encode(claude('Second', 'b')));
  const h = importer('claude', path);
  const log = new EventLog(join(root, 'retained-events'));
  h.sessions.events = log;
  await h.external.importExternalTranscript(h.session);
  const picture = log.putAttachment('chat', { filename: 'image.png', mime: 'image/png', data: 'aGVsbG8=' });
  const pageData = Buffer.from('<p>Keep this page</p>').toString('base64');
  const page = log.putAttachment('chat', { filename: 'page.html', mime: 'text/html', data: pageData });
  log.append('chat', { type: 'native.images', prompt: 'Ask', text: 'Ask', attachments: [picture] });
  log.append('chat', { type: 'turn.start', turnId: 'local-visual-page', text: '', local: true });
  log.append('chat', { type: 'item.start', turnId: 'local-visual-page', id: 'visual-page', kind: 'visual', visual: { ref: page.ref, title: 'Keep this page', height: 420 } });
  log.append('chat', { type: 'item.done', turnId: 'local-visual-page', id: 'visual-page', status: 'ok' });
  log.append('chat', { type: 'turn.done', turnId: 'local-visual-page', local: true });
  const assertRetained = () => {
    const events = log.tail('chat', 0);
    assert.equal(events.filter(e => e.type === 'native.images').length, 1);
    assert.equal(events.find(e => e.type === 'native.images').attachments[0].ref, picture.ref);
    assert.equal(events.filter(e => e.kind === 'visual').length, 1);
    assert.equal(log.attachment('chat', picture.ref), 'aGVsbG8=');
    assert.equal(log.attachment('chat', page.ref), pageData);
  };
  appendFileSync(path, encode(claude('First complete', 'a')));
  await h.external.importExternalTranscript(h.session);
  assertRetained();
  assert.equal(log.tail('chat', 0).filter(e => e.type === 'item.delta').map(e => e.text).join(''), 'First completeSecond');
  const replacement = join(root, 'local-history-new.jsonl');
  writeFileSync(replacement, encode(claude('New source', 'new', 'user')));
  renameSync(replacement, path);
  await h.external.importExternalTranscript(h.session);
  assertRetained();
  assert.equal(log.tail('chat', 0).filter(e => e.type === 'turn.start' && e.imported).length, 1);
});

test('EOF records become visible once and their later newline does not replay them', async () => {
  const path = join(root, 'eof.jsonl');
  writeFileSync(path, JSON.stringify(claude('Part')));
  const h = importer('claude', path);
  await h.external.importExternalTranscript(h.session);
  const original = h.events().slice(), itemId = h.session.externalTail.itemId;
  assert.equal(h.session.externalImported, 1);
  appendFileSync(path, '\n' + JSON.stringify(claude('Part complete')));
  await h.external.importExternalTranscript(h.session);
  assert.equal(h.restarts(), 0);
  assert.equal(h.session.externalTail.itemId, itemId);
  assert.deepEqual(h.events().slice(0, original.length), original);
  const grown = h.events().slice();
  appendFileSync(path, '  \r\n');
  await h.external.importExternalTranscript(h.session);
  assert.deepEqual(h.events(), grown);
  assert.deepEqual((await h.external.readTranscript(h.session)).messages, await messages({ engine: 'claude', path, all: true }));
});

test('an invalid suffix removes a previously valid EOF record just as a fresh parse does', async () => {
  const path = join(root, 'eof-invalid.jsonl');
  writeFileSync(path, JSON.stringify(codex('valid')));
  const reader = new IncrementalTranscript({ engine: 'codex', path });
  assert.equal((await reader.read()).messages.length, 1);
  appendFileSync(path, 'invalid\n' + encode(codex('next')));
  const result = await reader.read();
  assert.equal(result.reset, true);
  assert.deepEqual(result.messages, await messages({ engine: 'codex', path, all: true }));
});

test('watch expiry and skip operations release cached readers', async t => {
  const path = join(root, 'release.jsonl');
  writeFileSync(path, encode(claude('Part')));
  const h = importer('claude', path);
  const first = await h.external.readTranscript(h.session);
  await h.external.skipExternalTranscript(h.session);
  const afterSkip = await h.external.readTranscript(h.session);
  assert.notEqual(afterSkip.messages, first.messages);
  let tick;
  t.mock.method(globalThis, 'setInterval', callback => { tick = callback; return { unref() {} }; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const viewer = new SessionViewers(h.sessions, h.core);
  viewer.watchTranscript('chat', path);
  now += 60001;
  await tick();
  assert.notEqual((await h.external.readTranscript(h.session)).messages, afterSkip.messages);
  viewer.stop();
});

const rawHistory = log => readFileSync(join(log.dir, 'chat.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);

test('reader release detects an earlier snapshot and preserves imported-turn cards beyond the memory tail', async () => {
  const path = join(root, 'release-earlier.jsonl');
  writeFileSync(path, encode(claude('Ask', 'u', 'user')) + encode(claude('First', 'a')));
  const h = importer('claude', path);
  const log = new EventLog(join(root, 'release-earlier-events'));
  h.sessions.events = log;
  await h.external.importExternalTranscript(h.session);
  const owner = log.tail('chat', 0).find(e => e.type === 'turn.start').turnId;
  const image = log.putAttachment('chat', { filename: 'image.png', mime: 'image/png', data: 'aGVsbG8=' });
  const pageData = Buffer.from('<p>Owned by an imported turn</p>').toString('base64');
  const page = log.putAttachment('chat', { filename: 'card.html', mime: 'text/html', data: pageData });
  log.append('chat', { type: 'native.images', turnId: owner, prompt: 'Ask', attachments: [image] });
  log.append('chat', { type: 'item.start', turnId: owner, id: 'visual-owned', kind: 'visual', visual: { ref: page.ref, title: 'Keep this card', height: 420 } });
  log.append('chat', { type: 'item.done', turnId: owner, id: 'visual-owned', status: 'ok' });
  const note = 'Keep the full local note. '.repeat(700);
  log.append('chat', { type: 'item.start', turnId: owner, id: 'helm-note', kind: 'text', local: true });
  log.append('chat', { type: 'item.delta', turnId: owner, id: 'helm-note', text: note });
  log.append('chat', { type: 'item.done', turnId: owner, id: 'helm-note', status: 'ok' });
  appendFileSync(path, encode(claude('Second', 'b')));
  await h.external.importExternalTranscript(h.session);
  for (let i = 0; i < 2300; i++) log.append('chat', { type: 'item.delta', turnId: owner,
    id: `imported-padding-${i}`, text: 'padding', sourceId: 'b', sourceIndex: 2 });
  assert.equal(log.tail('chat', 0).some(e => e.type === 'native.images'), false, 'the image record is outside the memory tail');
  h.external.releaseTranscript(h.session);
  appendFileSync(path, encode(claude('First complete', 'a')));
  await h.external.importExternalTranscript(h.session);
  const check = () => {
    const events = rawHistory(log);
    assert.equal(events.filter(e => e.type === 'native.images').length, 1);
    assert.equal(events.find(e => e.type === 'native.images').turnId, owner);
    assert.equal(events.filter(e => e.type === 'turn.start' && e.turnId === owner).length, 1, 'keep one owner anchor');
    assert.equal(events.filter(e => e.id === 'visual-owned' && e.type === 'item.start').length, 1);
    assert.equal(events.find(e => e.id === 'helm-note' && e.type === 'item.delta').text, note);
    assert.equal(log.attachment('chat', image.ref), 'aGVsbG8=');
    assert.equal(log.attachment('chat', page.ref), pageData);
    return events;
  };
  const events = check();
  const first = events.findIndex(e => e.type === 'item.delta' && e.text === 'First complete');
  const card = events.findIndex(e => e.id === 'visual-owned' && e.type === 'item.start');
  const second = events.findIndex(e => e.type === 'item.delta' && e.text === 'Second');
  assert.ok(first >= 0 && first < card && card < second, 'keep the visual between the two replies');
  const replacement = join(root, 'release-earlier-new.jsonl');
  writeFileSync(replacement, encode(claude('Other source', 'other', 'user')));
  renameSync(replacement, path);
  await h.external.importExternalTranscript(h.session);
  check();
});

test('legacy imported logs keep a visual between turns without duplicating owner prompts', async () => {
  const path = join(root, 'legacy-card-order.jsonl');
  writeFileSync(path, encode(claude('First question', 'u1', 'user')) + encode(claude('First answer', 'a1')));
  const h = importer('claude', path);
  const log = new EventLog(join(root, 'legacy-card-events'));
  h.sessions.events = log;
  await h.external.importExternalTranscript(h.session);
  const owner = log.tail('chat', 0).find(e => e.type === 'turn.start').turnId;
  log.append('chat', { type: 'native.images', turnId: owner, prompt: 'First question', attachments: [] });
  log.append('chat', { type: 'item.start', turnId: owner, id: 'visual-legacy', kind: 'visual', visual: { title: 'Between turns', ref: 'legacy', height: 420 } });
  log.append('chat', { type: 'item.done', turnId: owner, id: 'visual-legacy', status: 'ok' });
  appendFileSync(path, encode(claude('Second question', 'u2', 'user')) + encode(claude('Second answer', 'a2')));
  await h.external.importExternalTranscript(h.session);
  log.replace('chat', rawHistory(log).map(({ sourceId, sourceIndex, ...event }) => event));
  h.external.releaseTranscript(h.session);
  appendFileSync(path, encode(claude('First answer complete', 'a1')));
  await h.external.importExternalTranscript(h.session);
  const events = rawHistory(log);
  assert.equal(events.filter(e => e.type === 'turn.start' && e.text === 'First question').length, 1);
  assert.equal(events.filter(e => e.type === 'turn.start' && e.text === 'Second question').length, 1);
  assert.equal(events.find(e => e.type === 'turn.start' && e.text === 'First question').turnId, owner);
  assert.equal(events.find(e => e.type === 'native.images').turnId, owner);
  const first = events.findIndex(e => e.type === 'item.delta' && e.text === 'First answer complete');
  const card = events.findIndex(e => e.id === 'visual-legacy' && e.type === 'item.start');
  const second = events.findIndex(e => e.type === 'turn.start' && e.text === 'Second question');
  assert.ok(first >= 0 && first < card && card < second);
});

test('saved digests cover the retained imported window with a base index', async () => {
  const path = join(root, 'digest-window.jsonl');
  writeFileSync(path, Array.from({ length: 5000 }, (_, i) => encode(claude(`question ${i}`, `u${i}`, 'user'))).join(''));
  const h = importer('claude', path);
  await h.external.importExternalTranscript(h.session);
  assert.ok(h.session.externalTranscriptDigestBase > 0);
  assert.ok(h.session.externalTranscriptDigests.length < 2000);
  assert.equal(h.session.externalTranscriptDigestBase + h.session.externalTranscriptDigests.length, 5000);
  const saved = h.session.externalTranscriptDigests;
  await h.external.importExternalTranscript(h.session);
  assert.equal(h.session.externalTranscriptDigests, saved, 'unchanged polls do not copy or rebuild the saved window');
});

for (const legacy of [false, true]) test(`rebuild keeps one provider tool parent for local visuals (${legacy ? 'legacy' : 'current'} log)`, async () => {
  const path = join(root, `tool-parent-${legacy}.jsonl`);
  writeFileSync(path, encode(claude('Ask', 'u', 'user')) + encode(claude([
    { type: 'text', text: 'First' }, { type: 'tool_use', name: 'Read', input: { path: '/work' } },
  ], 'a')));
  const h = importer('claude', path);
  const log = new EventLog(join(root, `tool-parent-events-${legacy}`));
  h.sessions.events = log;
  await h.external.importExternalTranscript(h.session);
  const tool = log.tail('chat', 0).find(e => e.type === 'item.start' && e.kind === 'tool');
  log.append('chat', { type: 'item.start', turnId: tool.turnId, parentId: tool.id, id: 'visual-child',
    kind: 'visual', visual: { title: 'Tool result', ref: 'card', height: 420 } });
  log.append('chat', { type: 'item.done', turnId: tool.turnId, parentId: tool.id, id: 'visual-child', status: 'ok' });
  appendFileSync(path, encode(claude('Second', 'b')));
  await h.external.importExternalTranscript(h.session);
  if (legacy) log.replace('chat', rawHistory(log).map(({ sourceId, sourceIndex, ...event }) => event));
  h.external.releaseTranscript(h.session);
  appendFileSync(path, encode(claude('First complete', 'a')));
  await h.external.importExternalTranscript(h.session);
  const events = rawHistory(log);
  const tools = events.filter(e => e.type === 'item.start' && e.kind === 'tool');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].id, tool.id);
  assert.equal(events.find(e => e.type === 'item.start' && e.id === 'visual-child').parentId, tool.id);
  const parent = events.indexOf(tools[0]);
  const child = events.findIndex(e => e.type === 'item.start' && e.id === 'visual-child');
  const second = events.findIndex(e => e.type === 'item.delta' && e.text === 'Second');
  assert.ok(parent < child && child < second);
});

test('one saved prefix digest detects older changes outside the saved window after reader release', async () => {
  const path = join(root, 'prefix-digest.jsonl');
  writeFileSync(path, Array.from({ length: 3000 }, (_, i) => encode(claude(`question ${i}`, `u${i}`, 'user'))).join(''));
  const h = importer('claude', path);
  await h.external.importExternalTranscript(h.session);
  const prefix = h.session.externalTranscriptPrefixDigest;
  assert.equal(prefix.length, 64);
  assert.ok(h.session.externalTranscriptDigestBase > 0);
  const window = h.session.externalTranscriptDigests;
  await h.external.importExternalTranscript(h.session);
  assert.equal(h.session.externalTranscriptDigests, window);
  assert.equal(h.session.externalTranscriptPrefixDigest, prefix);
  h.external.releaseTranscript(h.session);
  appendFileSync(path, encode(claude('question 0 complete', 'u0', 'user')));
  const result = await h.external.readTranscript(h.session);
  assert.equal(result.changedFrom, 0);
  await h.external.importExternalTranscript(h.session);
  assert.equal(h.restarts(), 1);
  assert.notEqual(h.session.externalTranscriptPrefixDigest, prefix);
  assert.ok(h.session.externalTranscriptDigests.length < 2000);
});
