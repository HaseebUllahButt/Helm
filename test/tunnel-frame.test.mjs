import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encodeTunnelFrame, decodeTunnelFrame, fragmentTunnelFrame, TunnelFrames } from '../packages/protocol/tunnel-frame.js';

test('binary tunnel bytes round-trip with a JSON fallback for older hops', () => {
  const data = randomBytes(65536), frame = { t: 'tunnel.data', sid: 'copy-1', data };
  const encoded = encodeTunnelFrame(frame, true);
  assert.ok(Buffer.isBuffer(encoded));
  assert.ok(encoded.length < data.length + 100);
  assert.deepEqual(decodeTunnelFrame(encoded), frame);
  const legacy = encodeTunnelFrame(frame, false);
  assert.equal(typeof legacy, 'string');
  assert.equal(decodeTunnelFrame(legacy).data, data.toString('base64'));
  const ordinary = { t: 'rpc', id: 'one', params: { text: 'اردو 日本語 😀' } };
  assert.deepEqual(decodeTunnelFrame(encodeTunnelFrame(ordinary, true)), ordinary);
});

test('ordered binary fragments reassemble Buffer and ArrayBuffer data without text encoding', () => {
  const frame = { t: 'tunnel.data', sid: 'copy-2', data: randomBytes(65560) };
  const parts = fragmentTunnelFrame(encodeTunnelFrame(frame, true));
  assert.ok(parts.length > 1);
  assert.ok(parts.every(part => part.length <= 16000));
  for (const asArrayBuffer of [false, true]) {
    const decoder = new TunnelFrames();
    for (let n = 0; n < parts.length; n++) {
      const input = asArrayBuffer ? Uint8Array.from(parts[n]).buffer : parts[n];
      const result = decoder.decode(input);
      if (n < parts.length - 1) assert.equal(result, undefined);
      else assert.deepEqual(result, frame);
    }
  }
});

test('binary decoding rejects corrupt headers, fragment indexes, duplicates and excess sizes', () => {
  const valid = encodeTunnelFrame({ t: 'tunnel.data', sid: 'copy', data: Buffer.alloc(65536) }, true);
  const header = Buffer.from(valid); header.writeUInt16BE(65535, 4);
  assert.throws(() => decodeTunnelFrame(header));
  assert.throws(() => decodeTunnelFrame(Buffer.from('HLMB')));
  assert.throws(() => encodeTunnelFrame({ t: 'tunnel.data', sid: 'copy', data: Buffer.alloc(140000) }, true));
  const parts = fragmentTunnelFrame(valid);
  for (const count of [0, 1, 65535]) {
    const part = Buffer.from(parts[0]); part.writeUInt16BE(count, 10);
    assert.throws(() => new TunnelFrames().decode(part));
  }
  const badIndex = Buffer.from(parts[0]); badIndex.writeUInt16BE(65535, 8);
  assert.throws(() => new TunnelFrames().decode(badIndex));
  const decoder = new TunnelFrames(); decoder.decode(parts[0]);
  assert.throws(() => decoder.decode(parts[0]));
  decoder.clear();
  for (const part of parts) decoder.decode(part);
});
