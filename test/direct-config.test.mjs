import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { RTCPeerConnection } from 'node-datachannel/polyfill';
import { cleanup } from 'node-datachannel';
import { nativeDirectConfig, DIRECT_PORTS } from '../packages/connect/src/direct-config.js';
test.after(() => cleanup());

test('both native directions use a known, shared UDP range', () => {
  const config = nativeDirectConfig({});
  assert.equal(config.portRangeBegin, DIRECT_PORTS.begin);
  assert.equal(config.portRangeEnd, DIRECT_PORTS.end);
  assert.equal(config.enableIceUdpMux, true);
  assert.equal(nativeDirectConfig({ directPorts: { begin: 32000, end: 32100 } }).portRangeBegin, 32000);
  for (const ports of [{}, { begin: 0, end: 1 }, { begin: 40000, end: 39999 }, { begin: 30000, end: 30000 }, { begin: 10000, end: 65536 }, { begin: '30000', end: 30001 }]) {
    assert.throws(() => nativeDirectConfig({ directPorts: ports }), /directPorts/);
  }
});

test('many native peers share a small loopback UDP range', { timeout: 15000 }, async () => {
  const socket = dgram.createSocket('udp4');
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const begin = Math.min(port, 65532);
  const config = { ...nativeDirectConfig({ directPorts: { begin, end: begin + 2 } }),
    iceServers: [], bindAddress: '127.0.0.1' };
  const peers = [];
  try {
    const addresses = await Promise.all(Array.from({ length: 6 }, async () => {
      const pc = new RTCPeerConnection(config); peers.push(pc);
      const candidate = new Promise(resolve => { pc.onicecandidate = ({ candidate }) => { if (candidate) resolve(candidate.candidate); }; });
      pc.createDataChannel('test');
      await pc.setLocalDescription(await pc.createOffer());
      return candidate;
    }));
    for (const address of addresses) {
      const match = address.match(/127\.0\.0\.1 (\d+) typ host/);
      assert.ok(match);
      assert.ok(Number(match[1]) >= begin && Number(match[1]) <= begin + 2);
    }
    assert.ok(new Set(addresses.map(address => address.match(/127\.0\.0\.1 (\d+)/)[1])).size <= 2);
  } finally { for (const pc of peers) pc.close(); }
});
