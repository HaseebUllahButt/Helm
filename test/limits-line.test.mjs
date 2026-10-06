import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const source = await readFile(new URL('../apps/web/src/session/limits.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm' });
const { limitWindows, current } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

test("Claude's rate_limit_event reads as 5h and 7d percentages", () => {
  const limits = { claude: { rateLimitType: 'five_hour', unifiedWindows: {
    five_hour: { utilization: 0.09, resetsAt: 1791064200 }, seven_day: { utilization: 0.4, resetsAt: 1791356400 } } } };
  assert.deepEqual(limitWindows(limits).map((w) => `${w.label} ${w.used}%`), ['5h 9%', '7d 40%']);
});

test("Codex's windows are named by their length", () => {
  const limits = { codex: { primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1 }, secondary: { usedPercent: 28, windowDurationMins: 10080 } } };
  assert.deepEqual(limitWindows(limits).map((w) => `${w.label} ${w.used}%`), ['5h 1%', '7d 28%']);
  assert.deepEqual(limitWindows({ codex: { limitId: 'codex' } }), [], 'a sparse update says nothing');
});

test('a window past its reset time is back to nothing', () => {
  const [w] = current([{ label: '5h', used: 80, resetsAt: 100 }], 200_000);
  assert.equal(w.used, 0);
});
