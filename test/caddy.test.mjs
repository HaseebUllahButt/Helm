import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPublicIpv4, freeHostname } from '../packages/connect/src/caddy.js';

test('a VM public IP becomes a free stable hostname', () => {
  assert.equal(freeHostname('203.0.113.42'), '203-0-113-42.sslip.io');
  assert.throws(() => freeHostname('not-an-ip'), /public IPv4/);
});

test('public IP discovery trims the response', async () => {
  const ip = await detectPublicIpv4(async () => ({ ok: true, text: async () => '203.0.113.42\n' }));
  assert.equal(ip, '203.0.113.42');
});
