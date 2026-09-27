import test from 'node:test';
import assert from 'node:assert/strict';
import { ENGINES, engineForCommand, isInteractiveProc } from '../packages/connect/src/engines.js';

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

test('OpenCode 2 is a separate discovered CLI', () => {
  assert.deepEqual(
    { id: ENGINES.opencode2.id, label: ENGINES.opencode2.label, bin: ENGINES.opencode2.bin },
    { id: 'opencode2', label: 'OpenCode 2', bin: 'opencode2' },
  );
  assert.equal(engineForCommand('opencode2'), 'opencode2');
  assert.equal(engineForCommand('/usr/bin/opencode2'), 'opencode2');
  assert.equal(ENGINES.opencode2.driver, 'opencode2');
});

test('isInteractiveProc counts a chat someone is typing into, not helm\'s own children', () => {
  // A person at a TUI.
  assert.equal(isInteractiveProc('pi', ['/usr/bin/pi']), true);
  assert.equal(isInteractiveProc('omp', ['omp']), true);
  assert.equal(isInteractiveProc('grok', ['/usr/local/bin/grok']), true);
  assert.equal(isInteractiveProc('muse', ['/usr/bin/muse-bin-1.4.2']), true);
  // The same binaries in the shapes helm itself launches must not pass for
  // an external session - they are the driver, not a user.
  assert.equal(isInteractiveProc('pi', ['/usr/bin/pi', '--mode', 'rpc']), false);
  assert.equal(isInteractiveProc('omp', ['omp', '--mode', 'rpc']), false);
  assert.equal(isInteractiveProc('grok', ['grok', 'agent', '--no-leader', 'stdio']), false);
  assert.equal(isInteractiveProc('cursor', ['cursor-agent', 'acp']), false);
  assert.equal(isInteractiveProc('opencode', ['opencode', 'acp']), false);
  // cursor-agent is a node script: comm is `node` and the path is argv[1].
  assert.equal(isInteractiveProc('cursor', ['node', '/opt/cursor-agent/index.js']), true);
  assert.equal(isInteractiveProc('cursor', ['node', '/opt/cursor-agent/index.js', 'acp']), false);
  // An unrelated process whose argv merely mentions a flag is not a hit.
  assert.equal(isInteractiveProc('pi', ['vitest', '--mode', 'rpc']), false);
});
