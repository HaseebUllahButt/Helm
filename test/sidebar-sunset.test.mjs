import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['apps/web/src/SidebarSunset.tsx'], bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
const { skyAt } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const at = (h, m = 0) => skyAt(new Date(2026, 9, 26, h, m));

test('the sidebar sky follows the clock: dawn, day, sunset, night', () => {
  assert.equal(at(4, 59), 'night');
  assert.equal(at(5), 'dawn');
  assert.equal(at(6, 59), 'dawn');
  assert.equal(at(7), 'day');
  assert.equal(at(16, 59), 'day');
  assert.equal(at(17), 'sunset');
  assert.equal(at(18, 59), 'sunset');
  assert.equal(at(19), 'night');
  assert.equal(at(0), 'night');
});
