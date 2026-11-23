import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineBuffer } from '../packages/connect/src/line-buffer.js';

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
  const { lines, tail } = collect(chunks);
  const messages = [], junk = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { messages.push(JSON.parse(line)); } catch { junk.push(line); }
  }
  assert.deepEqual({ messages, junk, tail }, { messages: [{ n: 1 }, { n: 2 }, { n: 3 }], junk: ['{bad}'], tail: 'unfinished' });
});
