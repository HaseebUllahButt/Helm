import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['apps/web/src/session/NativeAgentView.tsx'], bundle: true, write: false, format: 'cjs', external: ['react', 'react/jsx-runtime', './Composer', './Transcript', '../EngineMark', '../Icon'] });
function fixture(saved = new Map(), agentId = 'helper', parentId = 'parent', envId = 'pc') {
  const hooks = [], effects = [], cleanups = [];
  let cursor = 0, first = true, resolveSend;
  const sent = [];
  const react = {
    useState(value) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof value === 'function' ? value() : value; return [hooks[i], next => { hooks[i] = typeof next === 'function' ? next(hooks[i]) : next; }]; },
    useRef(value) { const i = cursor++; return hooks[i] ??= { current: value }; },
    useCallback(fn) { cursor++; return fn; },
    useEffect(fn) { cursor++; if (first) effects.push(fn); },
  };
  const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' };
  const Composer = function Composer() {};
  const modules = { react, 'react/jsx-runtime': jsx, './Composer': { Composer }, './Transcript': { Transcript() {} }, '../EngineMark': { EngineMark() {} }, '../Icon': { BackIcon() {} } };
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) };
  const module = { exports: {} };
  vm.runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: name => modules[name] ?? {}, localStorage: storage, setTimeout, clearTimeout });
  const client = { rpc: (_, method, params) => {
    if (method === 'session.native-message') { sent.push(params); return new Promise(resolve => { resolveSend = resolve; }); }
    return new Promise(() => {});
  } };
  const props = { client, env: { id: envId }, parent: { id: parentId, engine: 'codex' }, agent: { id: agentId, status: 'done', canMessage: true }, onBack() {} };
  function find(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === Composer) return node.props;
    const children = node.props?.children;
    for (const child of Array.isArray(children) ? children : [children]) { const found = find(child); if (found) return found; }
  }
  function render() { cursor = 0; const tree = module.exports.NativeAgentView(props); if (first) { first = false; cleanups.push(...effects.map(fn => fn())); } return find(tree); }
  return { render, sent, resolveSend: () => resolveSend({ ok: true }), unmount: () => cleanups.forEach(fn => fn?.()) };
}

test('a late helper send reply keeps newer typed words', async () => {
  const view = fixture();
  view.render().setDraft('first');
  view.render().onSend();
  assert.equal(view.sent[0].data, 'first');
  view.render().setDraft('new words');
  view.resolveSend();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.render().draft, 'new words');
  view.unmount();
});

test('helper drafts survive leaving and stay separate from other helpers', () => {
  const saved = new Map();
  const view = fixture(saved);
  view.render().setDraft('keep these words');
  view.unmount();
  assert.equal(fixture(saved).render().draft, 'keep these words');
  assert.equal(fixture(saved, 'other').render().draft, '');
  assert.equal(fixture(saved, 'helper', 'other').render().draft, '');
  assert.equal(fixture(saved, 'helper', 'parent', 'other').render().draft, '');
});
