import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionSupport } from '../packages/protocol/connection-report.js';

test('support reports copy only safe generated fields', () => {
  const route = { machines: [{ env: 'private-id', name: 'private-name', url: 'https://secret', error: 'password', lastSeen: null }],
    history: [{ env: 'private-id', state: 'connected', at: 12, error: 'secret' },
      { env: 'private-id', state: 'secret', at: 13 }, { env: 'removed', state: 'connected', at: 14 },
      { env: 'private-id', state: 'connected', at: 1e99 }], chat: 'secret' };
  const report = connectionSupport(route);
  assert.equal(report.history.length, 1);
  assert.equal(report.checks[0].state, 'ok');
  assert.doesNotMatch(JSON.stringify(report), /private|secret|password|https|removed/);
});
