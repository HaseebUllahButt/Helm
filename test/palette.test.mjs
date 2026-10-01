import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transform } from 'esbuild';

const source = await readFile(new URL('../apps/web/src/Palette.tsx', import.meta.url), 'utf8');
const compiled = await transform(source, { loader: 'tsx', format: 'cjs', jsx: 'automatic' });

function mount() {
  const state = [];
  let cursor = 0, closed = 0, chosen;
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in state)) state[i] = initial;
      return [state[i], (value) => { state[i] = typeof value === 'function' ? value(state[i]) : value; }];
    },
    useRef: () => ({ current: null }), useId: () => 'palette',
    useMemo: (fn) => fn(), useEffect: () => {},
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled.code, {
    module, exports: module.exports,
    require: (name) => name === 'react' ? react : name === 'react/jsx-runtime'
      ? { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
      : name === './useDialog' ? { useDialog: () => ({ current: null }) } : {},
  });
  let count = 3, tree;
  function render() {
    cursor = 0;
    tree = module.exports.Palette({
      items: Array.from({ length: count }, (_, i) => ({ id: String(i), group: 'thread', title: `Thread ${i}`, run: () => { chosen = i; } })),
      onClose: () => { closed++; }, engineOf: () => ({ cls: '' }),
    });
  }
  const nodes = (node) => !node || typeof node !== 'object' ? [] : Array.isArray(node)
    ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
  const input = () => nodes(tree).find((n) => n.props?.role === 'combobox');
  render();
  return {
    change(value) { input().props.onChange({ target: { value } }); render(); },
    key(key, isComposing = false) { input().props.onKeyDown({ key, nativeEvent: { isComposing }, preventDefault() {} }); render(); },
    count(value) { count = value; render(); },
    active: () => input().props['aria-activedescendant'],
    chosen: () => chosen, closed: () => closed,
  };
}

test('empty palette search never leaves selection at minus one', () => {
  const p = mount();
  p.change('missing'); p.key('ArrowDown');
  assert.equal(p.active(), undefined);
  p.change('Thread'); p.key('Enter');
  assert.equal(p.chosen(), 0);
});

test('palette wraps navigation and clamps selection as live results disappear', () => {
  const p = mount();
  p.key('ArrowUp'); assert.equal(p.active(), 'palette-2');
  p.key('ArrowDown'); assert.equal(p.active(), 'palette-0');
  p.key('ArrowUp'); p.count(1);
  assert.equal(p.active(), 'palette-0');
  p.key('Enter'); assert.equal(p.chosen(), 0);
  assert.equal(p.closed(), 1);
});

test('IME composition does not launch a result on Enter', () => {
  const p = mount();
  p.key('Enter', true);
  assert.equal(p.chosen(), undefined);
  assert.equal(p.closed(), 0);
});
