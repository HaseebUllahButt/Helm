import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['apps/web/src/session/helperFailures.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
const { failureUnseen } = await import(`data:text/javascript,${encodeURIComponent(bundle.outputFiles[0].text)}`);

// On 2026-11-11 a helper on the Laptop for a lead on `why` kept opening its
// failure after the owner dismissed it: the mark was saved on the lead's
// record and read from the helper's own.
test('a helper on another machine reads the seen mark from its lead', () => {
  const helper = { id: 'h', delegation: { finishedAt: 5 } };
  assert.equal(failureUnseen(helper, [{ id: 'h', finishedAt: 5, dismissedFailureAt: 5 }]), false);
  assert.equal(failureUnseen(helper, [{ id: 'h', finishedAt: 6, dismissedFailureAt: 5 }]), true, 'a new failure asks again');
});

test('a helper on this machine reads its own mark', () => {
  assert.equal(failureUnseen({ id: 'h', delegation: { finishedAt: 5, dismissedFailureAt: 5 } }), false);
  assert.equal(failureUnseen({ id: 'h', delegation: { finishedAt: 5 } }), true);
  assert.equal(failureUnseen({ id: 'h', delegation: { finishedAt: 5, dismissedFailureAt: 5 } }, [{ id: 'other', finishedAt: 1 }]), false);
});
