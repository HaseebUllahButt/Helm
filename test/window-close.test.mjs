import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
const { code } = await transform(await readFile('apps/web/src/windowClose.ts', 'utf8'), { loader: 'ts', format: 'esm' });
const { hasNoFrame } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test("Helm's Close button shows only where the desktop drew no title bar", () => {
  assert.equal(hasNoFrame({ w: 1280, h: 800 }, { w: 1280, h: 800 }), true, 'a bare window');
  // Zoomed to 110%: the page is smaller in page pixels, the window is not.
  assert.equal(hasNoFrame({ w: 1280, h: 800 }, { w: 1164, h: 727 }), true, 'a bare window, zoomed');
  assert.equal(hasNoFrame({ w: 1280, h: 837 }, { w: 1280, h: 800 }), false, 'a title bar from the desktop');
  assert.equal(hasNoFrame({ w: 1282, h: 838 }, { w: 1280, h: 800 }), false, 'a title bar and thin side borders');
  assert.equal(hasNoFrame({ w: 1280, h: 837 }, { w: 1164, h: 727 }), false, 'a title bar, zoomed');
  assert.equal(hasNoFrame({ w: 0, h: 0 }, { w: 1280, h: 800 }), false, 'a window that reports no size');
});
