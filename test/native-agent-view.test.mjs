import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['apps/web/src/session/NativeAgentView.tsx'], bundle: true, write: false, format: 'cjs', external: ['react', 'react/jsx-runtime', './Composer', './Transcript', '../EngineMark', '../Icon', '../Modal'] });
function fixture(saved = new Map(), agentId = 'helper', parentId = 'parent', envId = 'pc', actions = [], denyClear = false) {
  const hooks = [], effects = [], cleanups = [];
  let cursor = 0, first = true, resolveSend;
  const sent = [];
  const acknowledged = [];
  const abandoned = [];
  const react = {
    useState(value) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof value === 'function' ? value() : value; return [hooks[i], next => { hooks[i] = typeof next === 'function' ? next(hooks[i]) : next; }]; },
    useRef(value) { const i = cursor++; return hooks[i] ??= { current: value }; },
    useCallback(fn) { cursor++; return fn; },
    useEffect(fn) { cursor++; if (first) effects.push(fn); },
  };
  const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' };
  const Composer = function Composer() {};
  const Confirm = function Confirm() {};
  const modules = { react, 'react/jsx-runtime': jsx, './Composer': { Composer }, './Transcript': { Transcript() {} }, '../EngineMark': { EngineMark() {} }, '../Icon': { BackIcon() {} }, '../Modal': { Confirm } };
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => { if (denyClear) throw Error('denied'); return saved.delete(key); } };
  const module = { exports: {} };
  vm.runInNewContext(bundle.outputFiles[0].text, { module, exports: module.exports, require: name => modules[name] ?? {}, localStorage: storage, window: { addEventListener() {}, removeEventListener() {} }, setTimeout, clearTimeout });
  const client = { nativeMessageActions: () => actions, ackNativeMessage: id => acknowledged.push(id),
    abandonNativeMessage: (...args) => { abandoned.push(args); actions.splice(0,actions.length); },
    resumeNativeMessage: action => action.fail ? Promise.reject(Object.assign(Error('Checking delivery.'), {code:'delivery_pending'})) : Promise.resolve({ actionId: action.actionId }), rpc: (_, method, params) => {
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
  let tree;
  function render() { cursor = 0; tree = module.exports.NativeAgentView(props); if (first) { first = false; cleanups.push(...effects.map(fn => fn())); } return find(tree); }
  function element(type, label, node) {
    if (Array.isArray(node)) { for (const child of node) { const found=element(type,label,child); if(found) return found; } return; }
    if (!node || typeof node !== 'object') return;
    if (node.type===type && (label===undefined || node.props?.children===label)) return node;
    return element(type,label,node.props?.children);
  }
  return { render, sent, acknowledged, abandoned, Confirm, element: (type, label) => element(type, label, tree), resolveSend: () => resolveSend({ ok: true, actionId: 'message' }), unmount: () => cleanups.forEach(fn => fn?.()) };
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

test('a send that finishes after leaving keeps its receipt and draft', async () => {
  const saved=new Map(), view=fixture(saved);
  view.render().setDraft('first'); view.render().onSend(); view.unmount(); view.resolveSend();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(view.acknowledged,[]);
  assert.equal(fixture(saved).render().draft,'first');
});

test('returning to a confirmed send clears only its unchanged draft', async () => {
  const saved=new Map(), original=fixture(saved);
  original.render().setDraft('first'); original.unmount();
  const action={actionId:'message',confirmed:true,params:{data:'first'}};
  const returned=fixture(saved,'helper','parent','pc',[action]); returned.render();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(returned.render().draft,'');
  assert.deepEqual(returned.acknowledged,['message']);
  returned.unmount();
});

test('a failed draft clear keeps the confirmed receipt for the next visit', async () => {
  const saved=new Map(), view=fixture(saved,'helper','parent','pc',[],true);
  view.render().setDraft('first'); view.render().onSend(); view.resolveSend();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(view.acknowledged,[]);
  assert.equal(fixture(saved).render().draft,'first');
  view.unmount();
});

test('an uncertain send requires a warning and explicit confirmation to clear', async () => {
  const actions=[{actionId:'message',params:{data:'first'},fail:true}];
  const view=fixture(new Map(),'helper','parent','pc',actions);
  view.render(); await new Promise(resolve=>setImmediate(resolve)); view.render();
  view.element('button','Check the previous message').props.onClick(); view.render();
  const confirmation=view.element(view.Confirm);
  assert.match(confirmation.props.body,/may already have reached/i);
  assert.deepEqual(view.abandoned,[]);
  confirmation.props.onConfirm();
  assert.deepEqual(view.abandoned,[['pc','parent','helper','message']]);
  view.unmount();
});
