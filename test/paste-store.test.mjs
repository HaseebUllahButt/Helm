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

test('dollar signs and regex characters in a paste survive replacement', () => {
  const text = 'price $1 $& $` $\' $$ (a|b)* [x] \\d';
  const token = stashPaste(text.repeat(80));
  assert.equal(expandPastes(token), text.repeat(80));
});
