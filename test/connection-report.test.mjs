import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionSupport } from '../packages/protocol/connection-report.js';

// The support report names machines by number, the same number on every
// machine's page, and copies no names, addresses or errors.
test('a support report numbers machines across pages and leaks no private data', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');
  const routes = { machines: [{ env: 'lost', name: 'Laptop', url: null, lastSeen: now - 120_000, error: 'secret-error' }],
    history: [{ env: 'lost', state: 'disconnected', at: now, error: 'https://secret' }] };
  const report = connectionSupport(routes, now, ['home', 'lost']);
  assert.equal(report.checks[0].id, 'machine-2');
  assert.match(report.checks[0].message, /^Machine 2 has no connection from here\. Its connection was seen 2 minutes ago\./);
  assert.deepEqual(report.history, [{ machine: 'Machine 2', state: 'disconnected', at: now }]);
  assert.doesNotMatch(JSON.stringify(report), /Laptop|home|secret|https/);
});
