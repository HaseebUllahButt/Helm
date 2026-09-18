import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { HerdrRuntime } from '../packages/connect/src/runtime/herdr-runtime.js';

// herdr subscriptions are requested with dotted names (`pane.closed`) but the
// events themselves arrive with underscores (`pane_closed`). Checking the
// dotted form dropped every agent-status event, which is how "the phone knows
// an agent is blocked" - the whole point of helm - silently stopped working.
test('delivered herdr events (underscore names) translate to runtime events', () => {
  const stub = new EventEmitter();
  const rt = new HerdrRuntime({ herdr: stub });
  const got = [];
  rt.on('status', (e) => got.push(['status', e]));
  rt.on('closed', (e) => got.push(['closed', e]));

  stub.emit('event', {
    event: 'pane_agent_status_changed',
    data: { pane_id: 'w1:p1', agent_status: 'blocked', agent: 'claude' },
  });
  // The safety net for panes helm did not start: pane_updated carries PaneInfo.
  stub.emit('event', {
    event: 'pane_updated',
    data: { pane: { pane_id: 'w1:p2', agent_status: 'working' } },
  });
  stub.emit('event', { event: 'pane_closed', data: { pane_id: 'w1:p1' } });
  stub.emit('event', { event: 'pane_exited', data: { pane_id: 'w1:p3' } });
  // Closing a workspace does not deliver pane_closed for its panes.
  stub.emit('event', { event: 'workspace_closed', data: { workspace_id: 'w1' } });
  // Noise must be ignored, not crash the daemon.
  stub.emit('event', { event: 'pane_focused', data: { pane_id: 'w1:p1' } });
  stub.emit('event', { event: 'pane_updated', data: { pane: { pane_id: 'w1:p9' } } });

  assert.deepEqual(got, [
    ['status', { paneId: 'w1:p1', status: 'blocked', agent: 'claude' }],
    ['status', { paneId: 'w1:p2', status: 'working', agent: undefined }],
    ['closed', { paneId: 'w1:p1' }],
    ['closed', { paneId: 'w1:p3' }],
    ['closed', { workspaceId: 'w1' }],
  ]);
});
