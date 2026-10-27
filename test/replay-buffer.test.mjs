import test from 'node:test';
import assert from 'node:assert/strict';
const { createReplayBuffer } = await import('../packages/connect/src/replay-buffer.js');
const cap = 262144;
function baseline(text, chunk, limit, trimLine) {
  text += chunk;
  if (text.length <= limit) return text;
  const cut = text.length - limit, newline = text.indexOf('\n', cut);
  return text.slice(trimLine && newline !== -1 && newline - cut < 4096 ? newline + 1 : cut);
}

for (const trimLine of [true, false]) {
  test(`JavaScript: every replay point matches the old ${trimLine ? 'terminal' : 'process'} tail`, () => {
    const buffer = createReplayBuffer(32, { trimLine });
    assert.equal(buffer.text(), '');
    let expected = '';
    const chunks = ['', 'hello\r\n', '\x1b[31mاردو 😀\x1b[0m', '\ud800', '\udc00', '\udfff', 'x'.repeat(90), '\n', 'end'];
    let seed = 41;
    for (let i = 0; i < 2000; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      let chunk = '';
      for (let j = 0; j < seed % 51; j++) chunk += String.fromCharCode((seed + j * 911) & 65535);
      chunks.push(chunk + (i % 7 ? '' : '\n'));
    }
    for (const chunk of chunks) {
      expected = baseline(expected, chunk, 32, trimLine);
      buffer.append(chunk);
      assert.equal(buffer.text(), expected);
      assert.equal(buffer.text(), expected, 'repeated reads use the same text');
    }
    buffer.clear();
    assert.equal(buffer.text(), '');
    buffer.append('after clear');
    assert.equal(buffer.text(), 'after clear');
  });

  test(`JavaScript: newline boundaries, large writes and split surrogate tails (${trimLine})`, () => {
    const buffer = createReplayBuffer(cap, { trimLine });
    const cases = [
      ['a'.repeat(cap)],
      ['\n' + 'a'.repeat(cap - 1)], // exactly full: never trim the first line
      ['old', '\n' + 'a'.repeat(cap - 1)],
      ['😀' + 'a'.repeat(cap - 1)], // cut between surrogate halves
      ['a'.repeat(cap - 1) + '\ud800', '\udc00', '\n'],
      ['\x1b[31m' + 'x'.repeat(cap), '\x1b[0m'],
    ];
    for (const offset of [0, 4095, 4096, 4097]) {
      cases.push(['x'.repeat(17 + offset) + '\n' + 'y'.repeat(cap - offset - 1)]);
    }
    for (const chunks of cases) {
      let expected = ''; buffer.clear();
      for (const chunk of chunks) {
        expected = baseline(expected, chunk, cap, trimLine);
        buffer.append(chunk);
        assert.equal(buffer.text(), expected);
      }
    }
  });
}
