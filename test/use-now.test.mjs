import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transform } from 'esbuild';

const source = await readFile(new URL('../apps/web/src/useNow.ts', import.meta.url), 'utf8');
const compiled = await transform(source, { loader: 'ts', format: 'cjs' });

/** useNow with a hand-run clock: each mount is one component using the hook. */
function load() {
  let clock = 1_000_000_000_000 + 400, current, timers = [];
  const module = { exports: {} };
  vm.runInNewContext(compiled.code, {
    module, exports: module.exports,
    require: () => ({
      useState: (init) => { const box = current; box.value ??= init(); return [box.value, (fn) => { const next = fn(box.value); if (next !== box.value) { box.value = next; box.renders++; } }]; },
      useEffect: (fn) => { current.cleanup = fn(); },
    }),
    Date: { now: () => clock },
    setTimeout: (fn, ms) => { const t = { fn, at: clock + ms }; timers.push(t); return t; },
    clearTimeout: (t) => { timers = timers.filter((x) => x !== t); },
  });
  return {
    mount(...args) { current = { renders: 0 }; module.exports.useNow(...args); return current; },
    advance(ms) {
      const until = clock + ms;
      for (;;) {
        const next = timers.sort((a, b) => a.at - b.at)[0];
        if (!next || next.at > until) break;
        timers = timers.filter((t) => t !== next); clock = next.at; next.fn();
      }
      clock = until;
    },
    timers: () => timers.length,
  };
}

test('the shared clock runs at the fastest pace any user asks for', () => {
  const h = load();
  const slow = h.mount(30_000), fast = h.mount(15_000);
  h.advance(60_000);
  assert.equal(fast.renders, 4);
  assert.equal(slow.renders, 2);
  assert.equal(h.timers(), 1);
});

test('seconds counters turn over together, on the whole second, and stop when unused', () => {
  const h = load();
  const a = h.mount(1000), b = h.mount(1000), idle = h.mount(1000, false);
  h.advance(599);
  assert.equal(a.renders, 0);
  h.advance(10);
  assert.equal(a.renders, 1);
  assert.equal(a.value, b.value);
  assert.equal(a.value % 1000 < 50, true);
  assert.equal(idle.renders, 0);
  a.cleanup(); b.cleanup();
  assert.equal(h.timers(), 0);
});
