import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * "[Image #1]" in the message box is one thing, not ten letters. A delete
 * that cuts into it takes all of it, so the composer can drop the picture
 * behind it with the same keystroke.
 */
const { wholeTagEdit, renumberImages } = await import('../apps/web/src/session/attachTags.ts');

test('one backspace at the end of a tag removes the whole tag', () => {
  const before = 'look [Image #1]';
  const edit = wholeTagEdit(before, 'look [Image #1');
  assert.deepEqual(edit, { text: 'look ', caret: 5, removed: ['[Image #1]'] });
});

test('backspace on the space after a tag takes the tag too', () => {
  assert.deepEqual(wholeTagEdit('[Image #1] hi', '[Image #1]hi'), { text: 'hi', caret: 0, removed: ['[Image #1]'] });
  assert.deepEqual(wholeTagEdit('[Image #1] [Image #2] ', '[Image #1] [Image #2]'), { text: '[Image #1] ', caret: 11, removed: ['[Image #2]'] });
  // A space after words, or after a hand-written label, is only a space.
  assert.equal(wholeTagEdit('hi there', 'hithere'), null);
  assert.equal(wholeTagEdit('[Image #9] x', '[Image #9]x', (tag) => tag !== '[Image #9]'), null);
});

test('a delete from inside or in front of a tag takes all of it and its space', () => {
  assert.deepEqual(wholeTagEdit('[Image #1] hi', 'Image #1] hi'), { text: 'hi', caret: 0, removed: ['[Image #1]'] });
  assert.deepEqual(wholeTagEdit('a [File: n.pdf] b', 'a [File: npdf] b'), { text: 'a b', caret: 2, removed: ['[File: n.pdf]'] });
  const paste = '⟦pasted text 1 · 3,412 chars⟧';
  assert.equal(wholeTagEdit(`x ${paste}`, `x ${paste.slice(0, -1)}`).text, 'x ');
});

test('a selection that covers a tag reports it; a selection across two takes both', () => {
  assert.deepEqual(wholeTagEdit('a [Image #1] b', 'a  b').removed, ['[Image #1]']);
  const edit = wholeTagEdit('[Image #1] and [Image #2] end', 'Image #2] end');
  assert.deepEqual(edit.removed, ['[Image #1]', '[Image #2]']);
  assert.equal(edit.text, 'end');
});

test('typing, plain deletes and hand-written labels are left alone', () => {
  assert.equal(wholeTagEdit('hi [Image #1]', 'hi [Image #1] x'), null);
  assert.equal(wholeTagEdit('hello [Image #1]', 'hell [Image #1]'), null);
  assert.equal(wholeTagEdit('see [Image #9]', 'see [Image #9', (tag) => tag !== '[Image #9]'), null);
  // Replacing part of a tag with typed text is an edit, not a delete.
  assert.equal(wholeTagEdit('[Image #1]', '[Image #2]'), null);
});

test('labels after a removed picture move up, and its other copies leave', () => {
  assert.equal(renumberImages('[Image #2] vs [Image #3]', [1]), '[Image #1] vs [Image #2]');
  assert.equal(renumberImages('[Image #1] again [Image #2] x', [1]), 'again [Image #1] x');
  assert.equal(renumberImages('[Image #4]', [1, 3]), '[Image #2]');
});

test('the box is cut at live tags only, so only those get a tint', async () => {
  const { splitTags } = await import('../apps/web/src/session/attachTags.ts');
  assert.deepEqual(splitTags('see [Image #1] and [Image #9]', (tag) => tag !== '[Image #9]'), [
    { text: 'see ', tag: false }, { text: '[Image #1]', tag: true }, { text: ' and [Image #9]', tag: false },
  ]);
  assert.deepEqual(splitTags(''), []);
});
