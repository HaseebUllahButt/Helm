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

test('two machines can each dial the other at once on their shared ports', { timeout: 30000 }, async () => {
  const { dialConfig } = await import('../packages/connect/src/direct-rpc.js');
  const free = async () => {
    const socket = dgram.createSocket('udp4');
    await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    return Math.min(port, 65530);
  };
  const machine = (begin) => ({ ...nativeDirectConfig({ directPorts: { begin, end: begin + 3 } }), iceServers: [], bindAddress: '127.0.0.1' });
  const a = machine(await free()), b = machine(await free());
  const peers = [];
  const gathered = (pc) => new Promise(resolve => {
    const candidates = [];
    pc.onicecandidate = ({ candidate }) => { if (candidate) candidates.push(candidate); else resolve(candidates); };
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') resolve(candidates); };
  });
  // The dialer uses dialConfig, the answerer the machine's shared port, as in Helm.
  const link = async (dialer, answerer) => {
    const from = new RTCPeerConnection(dialConfig(dialer)), to = new RTCPeerConnection(answerer);
    peers.push(from, to);
    const channel = from.createDataChannel('helm');
    const open = new Promise((resolve, reject) => { channel.onopen = resolve; setTimeout(() => reject(new Error('link stayed closed')), 12000); });
    const fromCandidates = gathered(from), toCandidates = gathered(to);
    await from.setLocalDescription(await from.createOffer());
    await to.setRemoteDescription(from.localDescription);
    await to.setLocalDescription(await to.createAnswer());
    await from.setRemoteDescription(to.localDescription);
    for (const candidate of await fromCandidates) await to.addIceCandidate(candidate).catch(() => {});
    for (const candidate of await toCandidates) await from.addIceCandidate(candidate).catch(() => {});
    return open;
  };
  try {
    await link(b, a);
    await link(a, b);
  } finally {
    for (const pc of peers) pc.close();
  }
});
