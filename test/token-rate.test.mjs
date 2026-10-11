import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['apps/web/src/session/tokenRate.ts'], bundle: true, write: false, format: 'esm' });
const { addSample, tokensPerSecond, streamedChars, WINDOW_MS, QUIET_MS } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

/** Feed `chars` growth at a steady pace and return the samples. */
const stream = (start, ms, charsPerSecond, every = 100, from = 0) => {
  let samples = [];
  for (let at = start; at <= start + ms; at += every) samples = addSample(samples, at, from + Math.round((at - start) / 1000 * charsPerSecond));
  return samples;
};

test('a steady stream reads as characters over four, per second', () => {
  const samples = stream(0, 10_000, 200);
  assert.equal(tokensPerSecond(samples, 10_000), 50);
});

test('only the last few seconds count, so a slowdown shows', () => {
  let samples = stream(0, 10_000, 400);
  for (let at = 10_100; at <= 20_000; at += 100) samples = addSample(samples, at, 4000 + Math.round((at - 10_000) / 1000 * 40));
  assert.equal(tokensPerSecond(samples, 20_000), 10);
  assert.ok(samples.length <= WINDOW_MS / 100 + 2, 'old readings are dropped');
});

test('nothing streamed, too little to go on, or a pause reads as nothing', () => {
  assert.equal(tokensPerSecond([], 1000), null);
  assert.equal(tokensPerSecond(addSample([], 0, 500), 100), null, 'one reading is a baseline, not a rate');
  assert.equal(tokensPerSecond(stream(0, 500, 400), 500), null, 'half a second is too short to say');
  const samples = stream(0, 5000, 400);
  assert.equal(tokensPerSecond(samples, 5000 + QUIET_MS + 1), null, 'a tool running is not writing');
});

test('opening a chat mid-turn counts from what was already there', () => {
  const samples = stream(0, 3000, 200, 100, 80_000);
  assert.equal(tokensPerSecond(samples, 3000), 50);
});

test('a count that drops starts over instead of reading negative', () => {
  const samples = addSample(stream(0, 3000, 200), 3100, 10);
  assert.deepEqual(samples, [{ at: 3100, chars: 10 }]);
  assert.equal(tokensPerSecond(samples, 3200), null);
});

test('the model writes words, thinking and tool calls; command output is not its writing', () => {
  const turn = { items: [
    { kind: 'text', text: 'abcd' },
    { kind: 'thinking', text: 'efgh' },
    { kind: 'tool', text: '', inputJson: '{"a":1}' },
    { kind: 'subagent', text: '', inputJson: '{}' },
    { kind: 'command', text: 'lots of build output' },
    { kind: 'error', text: 'boom' },
  ] };
  assert.equal(streamedChars(turn), 4 + 4 + 7 + 2);
  assert.equal(streamedChars(undefined), 0);
});
