import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The reconciliation rule the terminal's predictive echo runs on, lifted out
 * of the component so it can be checked without a browser.
 *
 * This is the part that has to be right. Drawing a keystroke before it has
 * been to the machine and back is what makes a far-away terminal usable, and
 * getting the reconciliation wrong is what would put a character on screen
 * that was never typed - which is worse than any amount of latency.
 */
function settle(state, text) {
  const drawn = [];
  if (!state.owed) {
    if (state.lastSent && text.startsWith(state.lastSent)) state.echoes = true;
    drawn.push(text);
    return { state, drawn };
  }
  if (text.startsWith(state.owed)) {
    const rest = text.slice(state.owed.length);
    state.owed = '';
    if (rest) drawn.push(rest);
    return { state, drawn };
  }
  if (state.owed.startsWith(text)) {
    state.owed = state.owed.slice(text.length);
    return { state, drawn };
  }
  drawn.push('\b \b'.repeat(state.owed.length));
  state.owed = '';
  state.echoes = false;
  drawn.push(text);
  return { state, drawn };
}

test('an echo that matches the guess is not drawn twice', () => {
  const { state, drawn } = settle({ owed: 'a', echoes: true, lastSent: 'a' }, 'a');
  assert.equal(state.owed, '');
  assert.deepEqual(drawn, [], 'the character is already on screen');
});

test('an echo carrying more than the guess draws only the remainder', () => {
  // Enter, after typing `ls`: the machine echoes the line and then runs it.
  const { state, drawn } = settle({ owed: 'ls', echoes: true, lastSent: '\r' }, 'ls\r\nfile.txt\r\n$ ');
  assert.equal(state.owed, '');
  assert.deepEqual(drawn, ['\r\nfile.txt\r\n$ ']);
});

test('an echo arriving in pieces keeps waiting for the rest', () => {
  const s = { owed: 'abc', echoes: true, lastSent: 'c' };
  const first = settle(s, 'a');
  assert.deepEqual(first.drawn, []);
  assert.equal(first.state.owed, 'bc');
  const second = settle(first.state, 'bc');
  assert.deepEqual(second.drawn, []);
  assert.equal(second.state.owed, '');
});

test('a wrong guess is taken back, and guessing stops', () => {
  // The classic one: a password prompt, which echoes nothing of what you
  // type. Whatever comes next must not be typed over a character that was
  // never really there.
  const { state, drawn } = settle({ owed: 'p', echoes: true, lastSent: 'p' }, 'Password: ');
  assert.equal(drawn[0], '\b \b', 'the guess is erased first');
  assert.equal(drawn[1], 'Password: ');
  assert.equal(state.owed, '');
  assert.equal(state.echoes, false, 'and it stops guessing until echo is seen again');
});

test('two wrong characters are erased, both of them', () => {
  const { drawn } = settle({ owed: 'ab', echoes: true, lastSent: 'b' }, 'XYZ');
  assert.equal(drawn[0], '\b \b\b \b');
});

test('a program that echoes what it is sent is learned, not assumed', () => {
  const cold = { owed: '', echoes: false, lastSent: 'k' };
  assert.equal(settle(cold, 'k').state.echoes, true);
  const silent = { owed: '', echoes: false, lastSent: 'k' };
  assert.equal(settle(silent, 'Password: ').state.echoes, false);
});
