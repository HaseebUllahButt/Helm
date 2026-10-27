import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildLogReader } from '../scripts/build-log-reader.mjs';
import { body, claudeLines, codexLines, oddLines, random, readAll } from '../scripts/bench-transcript.mjs';

let available;
before(async () => { ({ available } = await buildLogReader({ log: () => {} })); });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'helm-rust-transcript-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Generated records with damaged and unusual lines spread between them. */
function mixed(engine, seed, count, big) {
  const rand = random(seed);
  const lines = (engine === 'codex' ? codexLines : claudeLines)(rand, count, { big });
  for (const odd of oddLines(engine)) lines.splice(Math.floor(rand() * lines.length), 0, odd);
  return lines;
}

async function compare(files, incremental = []) {
  const js = await readAll(files, { reader: 'javascript', incremental });
  const rust = await readAll(files, { reader: 'rust', incremental });
  assert.equal(js.reader, 'javascript');
  assert.equal(rust.reader, 'rust');
  assert.equal(rust.files.length, files.length + incremental.length);
  assert.deepEqual(rust.files, js.files);
  return rust.files;
}

test('Rust and JavaScript give the same chats, settings, usage and activity for damaged and Unicode logs', async t => {
  if (!available) return t.skip('Rust is not installed. The JavaScript reader stays available.');
  const dir = fixture(t), files = [];
  for (const engine of ['codex', 'claude']) {
    const lines = mixed(engine, engine.length, 300, 2000);
    const torn = lines.at(-1).slice(0, -3);
    // Plain, torn final write, CRLF endings, and a file past the 4 MB tail.
    const variants = {
      plain: body(lines),
      torn: Buffer.concat([body(lines), Buffer.from(torn)]),
      crlf: body(lines, '\r\n'),
      large: body(mixed(engine, 7, 700, 30_000)),
    };
    for (const [name, bytes] of Object.entries(variants)) {
      const path = join(dir, `${engine}-${name}.jsonl`);
      writeFileSync(path, bytes);
      files.push({ engine, path });
    }
  }
  assert.ok(readFileSync(files.find(f => f.path.endsWith('codex-large.jsonl')).path).length > 4 << 20);
  const results = await compare(files);
  for (const result of results) assert.ok(result.all.length > 20);
  // The odd lines that JSON.parse accepts still reach the chat.
  const plain = JSON.stringify(results[4].all);
  for (const text of ['after crlf', 'second after a lone return', 'Unicode اردو 😀 中文 naïve', 'duplicate last wins', 'escaped keys', 'deep'])
    assert.ok(plain.includes(text), text);
  assert.ok(results[0].all.some(message => message.text === 'lone \ud800 surrogate'));
  assert.ok(results[0].state.usage && results[0].state.settings.model);
  assert.match(results[4].snapshot, /Input:\*\* [\d,]+/);
});

test('full reads follow readline line ends across 4 MiB blocks, including lone "\\r"', async t => {
  if (!available) return t.skip('Rust is not installed. The JavaScript reader stays available.');
  const dir = fixture(t), files = [];
  for (const engine of ['codex', 'claude']) {
    const lines = mixed(engine, 11, 500, 30_000);
    // Put a "\r\n" pair and then a lone "\r" exactly on the block edges.
    const record = engine === 'codex'
      ? text => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })
      : text => JSON.stringify({ type: 'assistant', message: { id: text.slice(0, 9), content: [{ type: 'text', text }] } });
    const padded = (size, mark) => { const short = record(mark); return record(mark + 'x'.repeat(size - short.length)); };
    const edges = Buffer.concat([
      Buffer.from(padded((4 << 20) - 1, 'edge one')), Buffer.from('\r\n'),
      Buffer.from(padded((4 << 20) - 2, 'edge two')), Buffer.from('\r'),
      Buffer.from(record('after the lone return')), Buffer.from('\r'),
    ]);
    const path = join(dir, `${engine}-cr.jsonl`);
    writeFileSync(path, Buffer.concat([edges, body(lines, '\r')]));
    files.push({ engine, path });
  }
  const results = await compare(files);
  for (const result of results) {
    const texts = result.all.map(message => message.text.slice(0, 21));
    assert.ok(texts.includes('after the lone return'));
    assert.ok(result.all.length > 40);
  }
});

test('the live reader keeps fragments, torn Unicode and callback order the same for both readers', async t => {
  if (!available) return t.skip('Rust is not installed. The JavaScript reader stays available.');
  const dir = fixture(t), incremental = [];
  for (const engine of ['codex', 'claude']) {
    const source = join(dir, `${engine}.jsonl`);
    // Records past the 64 KiB read chunk make fragments that join later.
    const bytes = Buffer.concat([body(mixed(engine, 3, 80, 120_000)), Buffer.from('{"type":"assistant"')]);
    writeFileSync(source, bytes);
    const rand = random(engine.length + 10);
    const steps = [];
    for (let at = 0; at < bytes.length;) {
      at = Math.min(bytes.length, at + 1 + Math.floor(rand() * 200_000));
      // Some steps stop inside a multi-byte character.
      while (rand() < 0.3 && at < bytes.length && (bytes[at] & 0xc0) !== 0x80) at++;
      steps.push(at);
    }
    for (const sidechain of [false, true])
      incremental.push({ engine, source, target: join(dir, `${engine}-${sidechain}-live.jsonl`), steps, sidechain });
  }
  // Each reader writes its own target, so the target names differ by reader.
  const run = reader => readAll([], { reader, incremental: incremental.map(x => ({ ...x, target: `${x.target}.${reader}` })) });
  const [js, rust] = [await run('javascript'), await run('rust')];
  assert.equal(rust.reader, 'rust');
  assert.deepEqual(rust.files, js.files);
  const reads = rust.files[0].reads;
  assert.ok(reads.length > 20 && reads.every(read => !read.error));
  assert.ok(reads.at(-1).messages.length > 10);
  assert.ok(reads.some(read => read.changedFrom !== null && read.changedFrom < read.messages.length));
});

test('JavaScript reads transcripts alone when Rust is switched off', async t => {
  const dir = fixture(t), path = join(dir, 'claude.jsonl');
  writeFileSync(path, body(mixed('claude', 5, 40, 500)));
  const js = await readAll([{ engine: 'claude', path }], { reader: 'javascript' });
  assert.equal(js.reader, 'javascript');
  assert.ok(js.files[0].all.length > 0);
});
