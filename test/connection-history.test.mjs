import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConnectionHistory } from '../packages/connect/src/connection-history.js';
import { connectionSupport, connectionChecks } from '../packages/protocol/connection-report.js';

test('connection changes survive restart, keep last seen times, and forget removed machines', t => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-connections-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = 1000000;
  const file = join(dir, 'history.json');
  const history = new ConnectionHistory(file, { now: () => now });
  history.observe([{ env: 'laptop', url: 'https://private.example/?secret' }]);
  const moved = history.observe([{ env: 'laptop', url: 'https://second.private.example/?secret' }]);
  assert.equal(moved.history.at(-1).state, 'path-changed');
  now += 120000;
  const lost = history.observe([{ env: 'laptop', url: null }]);
  assert.equal(lost.machines[0].lastSeen, 1000000);
  assert.deepEqual(lost.history.map(e => e.state), ['connected', 'path-changed', 'disconnected']);
  assert.match(connectionChecks(lost, { now })[0].message, /2 minutes ago/);
  const restored = new ConnectionHistory(file, { now: () => now });
  assert.deepEqual(restored.observe([{ env: 'laptop', url: null }]), lost);
  restored.observe([{ env: 'laptop', attached: true }]);
  const changed = restored.observe([{ env: 'laptop', direct: { used: true } }]);
  assert.equal(changed.history.at(-1).state, 'path-changed');
  assert.doesNotMatch(readFileSync(file, 'utf8'), /private|secret|https/);
  assert.deepEqual(restored.observe([]).history, []);
});

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
