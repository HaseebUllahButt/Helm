import test from 'node:test';
import assert from 'node:assert/strict';
import { isInteractiveProc } from '../packages/connect/src/engines.js';

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
  // Vibe: the terminal app is a chat; vibe-acp and one-shot runs are not.
  assert.equal(isInteractiveProc('vibe', ['/home/a/.local/bin/vibe']), true);
  assert.equal(isInteractiveProc('vibe', ['vibe', '-p', 'hello']), false);
  assert.equal(isInteractiveProc('vibe', ['vibe-acp']), false);
});
