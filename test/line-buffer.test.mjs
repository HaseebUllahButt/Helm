import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineBuffer } from '../packages/connect/src/line-buffer.js';

function original(chunks) {
  let tail = '';
  const lines = [];
  for (const chunk of chunks) {
    tail += chunk;
    let cut;
    while ((cut = tail.indexOf('\n')) >= 0) {
      lines.push(tail.slice(0, cut)); tail = tail.slice(cut + 1);
    }
  }
  return { lines, tail };
}
function collect(chunks) {
  const reader = new LineBuffer();
  const lines = [];
  for (const chunk of chunks) {
    reader.write(chunk);
    let line;
    while ((line = reader.read()) !== null) lines.push(line);
  }
  return { lines, tail: reader.tail };
}

test('line collector matches the old reader with Unicode and arbitrary chunks', () => {
  const text = '\n \r\n{bad}\n{"reply":"اردو 😀 café \\n \\ud800"}\n'
    + '\u0000\ud800 \udc00\nlast\r\ntorn 😀\udfff';
  for (let size = 1; size < text.length + 2; size++) {
    const chunks = [];
    for (let at = 0; at < text.length; at += size) chunks.push(text.slice(at, at + size), '');
    assert.deepEqual(collect(chunks), original(chunks), `chunk size ${size}`);
  }
  const bytes = Buffer.from('اردو 😀 café\n');
  const chunks = Array.from(bytes, byte => Buffer.from([byte]));
  assert.deepEqual(collect(chunks), original(chunks), 'preserve each Buffer chunk decode, including replacements');
});

test('line collector holds large partial lines without changing text', () => {
  const text = '😀 café \ud800 '.repeat(140000);
  const chunks = [];
  for (let at = 0; at < text.length; at += 511) chunks.push(text.slice(at, at + 511));
  const reader = new LineBuffer();
  for (const chunk of chunks) { reader.write(chunk); assert.equal(reader.read(), null); }
  assert.equal(reader.tail, text);
  reader.write('\n{bad}\nnext\npartial');
  assert.equal(reader.read(), text);
  assert.equal(reader.read(), '{bad}');
  assert.equal(reader.read(), 'next');
  assert.equal(reader.read(), null);
  assert.equal(reader.tail, 'partial');
  reader.write(' complete\n');
  assert.equal(reader.read(), 'partial complete');
  assert.equal(reader.tail, '');
});

test('queued lines keep provider order across async handlers and failures', async () => {
  const reader = new LineBuffer();
  reader.write('first\nsecond\n');
  assert.equal(reader.read(), 'first');
  // Another data callback can arrive while the first handler awaits work.
  await Promise.resolve();
  reader.write('third\npartial');
  assert.equal(reader.read(), 'second');
  assert.equal(reader.read(), 'third');
  assert.equal(reader.read(), null);
  reader.write(' reply\nfourth\n');
  assert.throws(() => { assert.equal(reader.read(), 'partial reply'); throw new Error('handler failed'); });
  assert.equal(reader.read(), 'fourth', 'the next callback retains unread complete lines');
  assert.equal(reader.read(), null);
  assert.equal(new LineBuffer().tail, '', 'another pipe starts empty');
});

test('malformed JSON recovery keeps blank lines, junk and later messages unchanged', () => {
  const chunks = ['\n \r\n{"n":1}\n{b', 'ad}\n{"n":2}\n{"n":', '3}\nunfinished'];
  const consume = ({ lines, tail }) => {
    const messages = [], junk = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { messages.push(JSON.parse(line)); } catch { junk.push(line); }
    }
    return { messages, junk, tail };
  };
  assert.deepEqual(consume(collect(chunks)), consume(original(chunks)));
  assert.deepEqual(consume(collect(chunks)), { messages: [{ n: 1 }, { n: 2 }, { n: 3 }], junk: ['{bad}'], tail: 'unfinished' });
});

test('chunk conversion uses the same coercion as the old loops', () => {
  const chunks = [null, 12, { [Symbol.toPrimitive]: hint => hint === 'default' ? 'original\n' : 'changed\n' }];
  assert.deepEqual(collect(chunks), original(chunks));
  const reader = new LineBuffer();
  assert.throws(() => reader.write(Symbol('chunk')), TypeError);
});
