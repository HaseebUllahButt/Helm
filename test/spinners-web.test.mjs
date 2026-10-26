import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['apps/web/src/spinners.ts'], bundle: true, write: false, format: 'esm' });
const { turnSpinners } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

// A stand-in page: the spinners on screen, whether it is hidden, and reduced motion.
const page = ({ hidden = false, still = false } = {}) => {
  const spinners = [{ style: {} }, { style: {} }];
  return { spinners, doc: { hidden, getElementsByClassName: () => spinners, defaultView: { matchMedia: () => ({ matches: still }) } } };
};

test('spinners turn in steps from one timer, not every frame', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { doc, spinners } = page();
  const timer = turnSpinners(doc, 200);
  t.after(() => clearInterval(timer));
  t.mock.timers.tick(199);
  assert.equal(spinners[0].style.transform, undefined, 'nothing moves between steps');
  t.mock.timers.tick(1);
  assert.deepEqual(spinners.map(s => s.style.transform), ['rotate(45deg)', 'rotate(45deg)']);
  t.mock.timers.tick(200 * 7);
  assert.equal(spinners[0].style.transform, 'rotate(0deg)', 'a whole turn every 8 steps');
});

test('a hidden window and reduced motion keep spinners still', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  for (const options of [{ hidden: true }, { still: true }]) {
    const { doc, spinners } = page(options);
    const timer = turnSpinners(doc, 200);
    t.mock.timers.tick(1000);
    clearInterval(timer);
    assert.equal(spinners[0].style.transform, undefined, JSON.stringify(options));
  }
});
