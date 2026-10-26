import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'helm-relay-ws-'));
Object.assign(process.env, { HELM_DIR: root, HELM_DB: join(root, 'hub.sqlite') });
const { createWsLayer } = await import('../apps/relay/src/ws.js');
const { hasActiveTransfers } = await import('../packages/protocol/transfer-activity.js');
test.after(() => rmSync(root, { recursive: true, force: true }));

function socket() {
  return { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); } };
}

test('a repeated tunnel id closes both ends and releases its first route', t => {
  const layer = createWsLayer(); t.after(() => layer.stop());
  const source = socket(), target = socket();
  layer.online.set('target', target);
  const open = { t: 'tunnel.open', sid: 'copy', env: 'target' };
  layer.routeTunnel(source, open);
  const firstSid = target.sent[0].sid;
  assert.equal(hasActiveTransfers(), true);
  layer.routeTunnel(source, open);
  assert.deepEqual(target.sent.at(-1), { t: 'tunnel.close', sid: firstSid, reason: 'duplicate stream id' });
  assert.equal(source.sent.at(-1).t, 'tunnel.close');
  assert.equal(source.sidMap.size, 0);
  assert.equal(source.tunnelSids.size, 0);
  assert.equal(target.tunnelSids.size, 0);
  assert.equal(hasActiveTransfers(), false);

  layer.routeTunnel(source, open);
  const nextSid = target.sent.at(-1).sid;
  layer.routeTunnel(target, { t: 'tunnel.close', sid: firstSid });
  assert.equal(source.sidMap.get('copy'), nextSid, 'late close cannot remove the next stream');
  layer.routeTunnel(source, { t: 'tunnel.close', sid: 'copy' });
  assert.equal(hasActiveTransfers(), false);
});
