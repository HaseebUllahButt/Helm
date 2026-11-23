import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['apps/web/src/session/chatKeys.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', define: { 'process.env.NODE_ENV': '"production"' } });
const { deleteKey } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const key = (k, mods = {}) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

test('Delete deletes only when it is not typing: outside a text box or in an empty message box', () => {
  const box = (value, composer = true) => ({ tagName: 'TEXTAREA', value, hasAttribute: (n) => composer && n === 'data-composer', closest: () => null });
  const row = { tagName: 'BUTTON', closest: () => null };
  const del = (mods = {}) => ({ ...key('Delete', mods), repeat: false });
  assert.equal(deleteKey(del(), row), true);
  assert.equal(deleteKey(del(), box('')), true);
  assert.equal(deleteKey(del(), box('hello')), false, 'a message being written keeps its Delete');
  assert.equal(deleteKey(del(), box('', false)), false, 'another text box keeps its Delete');
  assert.equal(deleteKey(del(), { tagName: 'DIV', closest: (s) => s.includes('.xterm') }), false, 'a terminal keeps its Delete');
  assert.equal(deleteKey(del(), { tagName: 'INPUT', closest: (s) => s.includes('input') }), false);
  assert.equal(deleteKey({ ...del(), repeat: true }, row), false, 'a held key does not repeat into it');
  for (const mods of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }]) assert.equal(deleteKey(del(mods), row), false);
});
