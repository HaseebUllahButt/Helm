import { randomBytes } from 'node:crypto';

const MAGIC = Buffer.from('HLMB');
const PART = Buffer.from('HLMP');
const MAX_HEADER = 2048;
const MAX_FRAME = 128 * 1024;
const PART_HEADER = 12;
const PART_SIZE = 16_000 - PART_HEADER;

function bytes(raw) {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  return null;
}

/** Binary copy bytes stay binary only on a hop that advertised support. */
export function encodeTunnelFrame(frame, binary = false) {
  if (frame?.t !== 'tunnel.data' || !Buffer.isBuffer(frame.data)) return JSON.stringify(frame);
  if (!binary) return JSON.stringify({ ...frame, data: frame.data.toString('base64') });
  const { data, ...fields } = frame;
  const header = Buffer.from(JSON.stringify(fields));
  if (header.length > MAX_HEADER || data.length + header.length + 6 > MAX_FRAME) throw new Error('copy frame is too large');
  const prefix = Buffer.allocUnsafe(6);
  MAGIC.copy(prefix); prefix.writeUInt16BE(header.length, 4);
  return Buffer.concat([prefix, header, data]);
}

export function decodeTunnelFrame(raw) {
  const input = bytes(raw);
  if (!input || input.length < 4 || !input.subarray(0, 4).equals(MAGIC)) return JSON.parse(input ? input.toString('utf8') : raw);
  if (input.length < 6 || input.length > MAX_FRAME) throw new Error('invalid binary copy frame');
  const length = input.readUInt16BE(4);
  if (!length || length > MAX_HEADER || 6 + length >= input.length) throw new Error('invalid binary copy header');
  const header = JSON.parse(input.toString('utf8', 6, 6 + length));
  if (header?.t !== 'tunnel.data' || typeof header.sid !== 'string' || !header.sid || header.sid.length > 64) throw new Error('invalid binary copy header');
  return { ...header, data: input.subarray(6 + length) };
}

/** Data channels carry small ordered messages, including binary copy packets. */
export function fragmentTunnelFrame(frame) {
  if (!Buffer.isBuffer(frame) || frame.length > MAX_FRAME) throw new Error('invalid binary copy frame');
  if (frame.length <= 16_000) return [frame];
  const count = Math.ceil(frame.length / PART_SIZE), id = randomBytes(4).readUInt32BE();
  return Array.from({ length: count }, (_, index) => {
    const head = Buffer.allocUnsafe(PART_HEADER);
    PART.copy(head); head.writeUInt32BE(id, 4); head.writeUInt16BE(index, 8); head.writeUInt16BE(count, 10);
    return Buffer.concat([head, frame.subarray(index * PART_SIZE, (index + 1) * PART_SIZE)]);
  });
}

export class TunnelFrames {
  #parts = new Map();
  decode(raw) {
    const input = bytes(raw);
    if (!input || input.length < 4 || !input.subarray(0, 4).equals(PART)) return decodeTunnelFrame(raw);
    if (input.length <= PART_HEADER || input.length > 16_000) throw new Error('invalid binary copy fragment');
    const id = input.readUInt32BE(4), index = input.readUInt16BE(8), count = input.readUInt16BE(10);
    if (count < 2 || count > Math.ceil(MAX_FRAME / PART_SIZE) || index >= count) throw new Error('invalid binary copy fragment');
    let entry = this.#parts.get(id);
    if (!entry) {
      if (this.#parts.size >= 8) this.#parts.delete(this.#parts.keys().next().value);
      entry = { parts: new Array(count), got: 0, bytes: 0 }; this.#parts.set(id, entry);
    }
    if (entry.parts.length !== count || entry.parts[index]) throw new Error('invalid binary copy fragment');
    entry.bytes += input.length - PART_HEADER;
    if (entry.bytes > MAX_FRAME) { this.#parts.delete(id); throw new Error('binary copy frame is too large'); }
    entry.parts[index] = Buffer.from(input.subarray(PART_HEADER));
    if (++entry.got !== count) return;
    this.#parts.delete(id);
    return decodeTunnelFrame(Buffer.concat(entry.parts));
  }
  clear() { this.#parts.clear(); }
}
