import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['apps/web/src/session/chatKeys.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
const { chatKey, nextInRing, modelRing, deleteKey } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const key = (k, mods = {}) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

test('the chat keys need Ctrl or Cmd with Shift, never a bare letter', () => {
  assert.equal(chatKey(key('Y', { ctrlKey: true, shiftKey: true })), 'effort');
  assert.equal(chatKey(key('M', { metaKey: true, shiftKey: true })), 'model');
  assert.equal(chatKey(key('a', { ctrlKey: true, shiftKey: true })), 'agents');
  for (const k of [key('y'), key('Y', { shiftKey: true }), key('y', { ctrlKey: true }),
    key('y', { ctrlKey: true, shiftKey: true, altKey: true }), key('x', { ctrlKey: true, shiftKey: true }),
    key('e', { ctrlKey: true, shiftKey: true }),
    key('l', { ctrlKey: true, shiftKey: true }),
    { ...key('y', { ctrlKey: true, shiftKey: true }), isComposing: true }]) assert.equal(chatKey(k), null);
});

test('stepping wraps, and starts at the top when the current one is not listed', () => {
  assert.equal(nextInRing(['low', 'medium', 'high'], 'low'), 'medium');
  assert.equal(nextInRing(['low', 'medium', 'high'], 'high'), 'low');
  assert.equal(nextInRing(['low', 'high'], ''), 'low');
  assert.equal(nextInRing([], 'low'), undefined);
});

test('favorites come first, from either list, and the long tail stays out', () => {
  assert.deepEqual(modelRing(['a', 'b', 'c'], ['x', 'y'], ['y', 'b']), ['b', 'y', 'a', 'c']);
  assert.deepEqual(modelRing(['a', 'b'], ['x'], []), ['a', 'b']);
});

test('Delete deletes only when it is not typing: outside a text box or in an empty message box', () => {
  const box = (value, composer = true) => ({ tagName: 'TEXTAREA', value, hasAttribute: (n) => composer && n === 'data-composer', closest: () => null });
  const row = { tagName: 'BUTTON', closest: () => null };
  const del = (mods = {}) => ({ ...key('Delete', mods), repeat: false });
  assert.equal(deleteKey(del(), row), true);
  assert.equal(deleteKey(del(), null), true);
  assert.equal(deleteKey(del(), box('')), true);
  assert.equal(deleteKey(del(), box('hello')), false, 'a message being written keeps its Delete');
  assert.equal(deleteKey(del(), box('', false)), false, 'another text box keeps its Delete');
  assert.equal(deleteKey(del(), { tagName: 'DIV', closest: (s) => s.includes('.xterm') }), false, 'a terminal keeps its Delete');
  assert.equal(deleteKey(del(), { tagName: 'INPUT', closest: (s) => s.includes('input') }), false);
  assert.equal(deleteKey({ ...del(), repeat: true }, row), false, 'a held key does not repeat into it');
  assert.equal(deleteKey(key('Backspace'), row), false);
  for (const mods of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }]) assert.equal(deleteKey(del(mods), row), false);
});
