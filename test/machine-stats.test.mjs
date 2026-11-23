import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryOf, parseNvidia } from '../packages/connect/src/machine-stats.js';

test('memory in use leaves out the cache Linux gives back', () => {
  const meminfo = 'MemTotal:       1000 kB\nMemFree:         100 kB\nMemAvailable:    600 kB\n';
  assert.deepEqual(memoryOf(meminfo), { total: 1024000, used: 409600 });
  assert.deepEqual(memoryOf(null, 2000, 500), { total: 2000, used: 1500 });
});

test('nvidia-smi rows become GPUs; a machine with none has an empty list', () => {
  assert.deepEqual(parseNvidia('NVIDIA GeForce RTX 4090, 37, 2048, 24564\n'),
    [{ name: 'NVIDIA GeForce RTX 4090', used: 37, memory: { total: 24564 * 1048576, used: 2048 * 1048576 } }]);
  assert.deepEqual(parseNvidia(''), []);
});
