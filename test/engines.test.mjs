import test from 'node:test';
import assert from 'node:assert/strict';
import { ENGINES, engineForCommand } from '../packages/connect/src/engines.js';

test('Devin is registered for PATH and alias discovery', () => {
  assert.deepEqual(
    { id: ENGINES.devin.id, label: ENGINES.devin.label, bin: ENGINES.devin.bin },
    { id: 'devin', label: 'Devin', bin: 'devin' },
  );
  assert.equal(engineForCommand('devin'), 'devin');
  assert.equal(engineForCommand('/opt/devin/bin/devin'), 'devin');
});
