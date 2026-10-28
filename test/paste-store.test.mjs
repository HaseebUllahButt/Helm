import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * A draft saved before pastes stopped being folded can hold a token; it
 * comes back whole on send. What must hold: the agent receives exactly what
 * was pasted, and a token that is not ours is left alone.
 */
const { stashPaste, expandPastes } = await import('../apps/web/src/session/pasteStore.ts');

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
