import test from 'node:test';
import assert from 'node:assert/strict';
import { Herdr } from '../packages/connect/src/herdr.js';

test('a missing herdr executable is reported instead of crashing the process', async () => {
  const bin = '/definitely/missing/con-test-herdr';
  await assert.rejects(
    new Herdr({ bin }).ensureServer(),
    (err) => {
      assert.match(err.message, /herdr executable/);
      assert.match(err.message, /CON_HERDR_BIN/);
      assert.match(err.message, new RegExp(bin));
      return true;
    }
  );
});
