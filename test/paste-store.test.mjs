import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * A big paste stands in as a token and comes back whole on send. What must
 * hold: the agent receives exactly what was pasted, a token that is not ours
 * is left alone, and small pastes are never folded.
 */
const { isBigPaste, stashPaste, expandPastes, PASTE_CHARS } = await import('../apps/web/src/session/pasteStore.ts');

test('short text is not a big paste; a wall of characters or of lines is', () => {
  assert.equal(isBigPaste('hello'), false);
  assert.equal(isBigPaste('x'.repeat(PASTE_CHARS - 1)), false);
  assert.equal(isBigPaste('x'.repeat(PASTE_CHARS)), true);
  assert.equal(isBigPaste(Array(40).fill('a').join('\n')), true);
});

test('a stashed paste comes back exactly, wherever its token stands', () => {
  const text = 'line one\n  indented  \n\ttabbed\n' + 'z'.repeat(2000);
  const token = stashPaste(text);
  assert.match(token, /^⟦pasted text \d+ · [\d,]+ chars⟧$/);
  const sent = expandPastes(`before ${token} after`);
  assert.equal(sent, `before ${text} after`);
});

test('two pastes in one message each expand to their own text', () => {
  const a = stashPaste('AAAA'.repeat(500));
  const b = stashPaste('BBBB'.repeat(500));
  assert.notEqual(a, b);
  assert.equal(expandPastes(`${a}\n${b}`), `${'AAAA'.repeat(500)}\n${'BBBB'.repeat(500)}`);
});

test('a token that was never stashed is left as it was typed', () => {
  const fake = '⟦pasted text 999 · 5 chars⟧';
  assert.equal(expandPastes(`x ${fake} y`), `x ${fake} y`);
});

test('dollar signs and regex characters in a paste survive replacement', () => {
  const text = 'price $1 $& $` $\' $$ (a|b)* [x] \\d';
  const token = stashPaste(text.repeat(80));
  assert.equal(expandPastes(token), text.repeat(80));
});

test('a message with no token is returned untouched', () => {
  assert.equal(expandPastes('just words'), 'just words');
});
