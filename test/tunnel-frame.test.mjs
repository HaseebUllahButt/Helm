import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { encodeTunnelFrame, decodeTunnelFrame, fragmentTunnelFrame, TunnelFrames, compressible, frameCompress } from '../packages/protocol/tunnel-frame.js';

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

test('video and encrypted tunnel bytes skip deflate; text and other frames keep it', () => {
  const random = randomBytes(65536);
  const page = Buffer.from('<div class="row">hello world, a web page from a dev server</div>\n'.repeat(1000)).subarray(0, 65536);
  const gzip = deflateRawSync(readFileSync(new URL('../packages/connect/src/agent.js', import.meta.url)));
  assert.equal(compressible(random), false);
  assert.equal(compressible(gzip), false, 'already compressed');
  assert.equal(compressible(page), true);
  assert.equal(compressible(Buffer.alloc(65536)), true);
  assert.equal(compressible(Buffer.from('tiny')), false, 'too small to gain anything');
  const video = { t: 'tunnel.data', sid: 's', data: random };
  assert.equal(frameCompress(video, encodeTunnelFrame(video, true)), false);
  assert.equal(frameCompress(video, encodeTunnelFrame(video, false)), undefined, 'base64 to an older hop deflates as before');
  const text = { t: 'tunnel.data', sid: 's', data: page };
  assert.equal(frameCompress(text, encodeTunnelFrame(text, true)), undefined);
  const list = { t: 'rpcResult', id: 'x', result: 'a'.repeat(5000) };
  assert.equal(frameCompress(list, encodeTunnelFrame(list, true)), undefined);
});
