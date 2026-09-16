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

test('Devin runs headless like the other agents', () => {
  // A duplicate registry entry without `driver` once overwrote this one and
  // silently dropped devin back to herdr panes - no ACP, no modes, and a
  // model.list that looked for its default in the wrong place.
  assert.equal(ENGINES.devin.driver, 'devin');
  assert.equal(ENGINES.devin.homeEnv, 'XDG_CONFIG_HOME');
  assert.equal(ENGINES.devin.defaultHome, '~/.config');
});
