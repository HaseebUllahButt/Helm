import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { visualDocument } from '../packages/protocol/visual.js';

/** Runs a saved page's boot script with just enough of a browser to press keys. */
function bootFrame() {
  const doc = visualDocument('<html><head></head><body></body></html>', { token: 't1' });
  const script = doc.match(/<script>([\s\S]*?)<\/script>/)[1];
  const listeners = { window: [], document: [] };
  const sent = [];
  const parent = { postMessage: (data) => sent.push(JSON.parse(JSON.stringify(data))) };
  const documentStub = {
    getElementById: () => null,
    documentElement: { style: { setProperty() {} }, dataset: {} },
    addEventListener: (type, fn) => listeners.document.push([type, fn]),
  };
  const context = { document: documentStub, parent, addEventListener: (type, fn) => listeners.window.push([type, fn]) };
  context.window = context;
  vm.runInNewContext(script, context);
  const press = (key, extra = {}) => {
    const event = { key, code: `Key${key.toUpperCase()}`, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, isTrusted: true, isComposing: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const [type, fn] of [...listeners.document, ...listeners.window]) if (type === 'keydown') fn(event);
    return event;
  };
  return { press, sent };
}

test('Ctrl+S in a saved page goes to Helm, not to the browser save', () => {
  const { press, sent } = bootFrame();
  const event = press('s');
  assert.ok(event.defaultPrevented, 'the browser does not save the page');
  assert.deepEqual(sent.at(-1), { type: 'helm.visual', token: 't1', key: { key: 's', code: 'KeyS', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false } });
  press('k', { metaKey: true, ctrlKey: false });
  assert.equal(sent.at(-1).key.key, 'k', 'Cmd keys go too');
});

test('a saved page keeps copy, find, zoom, plain typing and keys it takes itself', () => {
  const { press, sent } = bootFrame();
  for (const key of ['c', 'v', 'a', 'f', 'r', '+', '0', 'Control']) assert.ok(!press(key).defaultPrevented, key);
  press('s', { ctrlKey: false });
  press('s', { isTrusted: false });
  press('s', { defaultPrevented: true });
  assert.equal(sent.length, 0);
});
