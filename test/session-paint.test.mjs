import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transform } from 'esbuild';

const source = await readFile(new URL('../apps/web/src/session/useSessionLog.ts', import.meta.url), 'utf8');
const compiled = await transform(source, { loader: 'ts', format: 'cjs' });

async function mount() {
  const effects = [], states = [], timers = new Map(), saves = [];
  let listener, id = 0;
  const module = { exports: {} };
  const emptyLog = () => ({ last: 0, turns: [], pending: [], loaded: false });
  vm.runInNewContext(compiled.code, {
    module, exports: module.exports,
    require: (name) => name === 'react' ? {
      useRef: (value) => ({ current: value }), useCallback: (fn) => fn,
      useEffect: (fn) => effects.push(fn),
      useState: (value) => [value, (next) => states.push(next)],
    } : name === './types' ? {
      emptyLog, apply: (log, event) => { log.last = event.seq; log.turns.push(event.seq); },
    } : name === './logCache' ? {
      loadCached: () => Promise.resolve(null),
      saveCached: (...args) => { saves.push(args); return Promise.resolve(); },
    } : {},
    setTimeout: (fn, ms) => { const key = ++id; timers.set(key, { fn, ms }); return key; },
    clearTimeout: (key) => timers.delete(key), setInterval: () => 1, clearInterval() {},
    document: { addEventListener() {}, removeEventListener() {} },
    window: { addEventListener() {}, removeEventListener() {} },
  });
  module.exports.useSessionLog({ subscribe() {},
    rpc: () => Promise.resolve({events:[],pending:[],last:0}),
    on: (fn) => { listener = fn; return () => {}; } }, 'machine', 'thread');
  const cleanup = effects.map((fn) => fn());
  await new Promise(setImmediate); // streaming begins after initial history is reconciled
  states.length = 0;
  return {
    push(seq) { listener('machine', 'session.event', { id: 'thread', events: [{ seq }] }); },
    timers, states, saves,
    tick(ms) { for (const [key, timer] of [...timers]) if (timer.ms === ms) { timers.delete(key); timer.fn(); } },
    close() { cleanup.forEach((fn) => fn?.()); },
  };
}

test('a burst of stream events paints once without dropping events', async () => {
  const h = await mount();
  for (let seq = 1; seq <= 100; seq++) h.push(seq);
  assert.equal(h.states.length, 0);
  assert.equal([...h.timers.values()].filter((t) => t.ms === 50).length, 1);
  h.tick(50);
  assert.equal(h.states.length, 1);
  assert.equal(h.states[0].last, 100);
  assert.equal(h.states[0].turns.length, 100);
  h.push(101); h.tick(50);
  assert.equal(h.states.length, 2);
  assert.equal(h.states[1].last, 101);
  h.close();
});

test('unmount cancels a pending paint and persists the final events', async () => {
  const h = await mount();
  h.push(1); h.close(); h.tick(50);
  assert.equal(h.states.length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0][2], 1);
});
