import { randomBytes } from 'node:crypto';
import { CHUNK_AT, CHUNK_TYPE } from './frame-chunks.js';
import { fragmentTunnelFrame } from './tunnel-frame.js';

/**
 * Small frames first on a socket that crosses machines.
 *
 * A WebSocket sends first in, first out. On a slow, lossy link (the VM hub
 * at 30-300 KB/s) one 2 MB chat list held "create chat", "send message" and
 * the WebRTC offer for a minute, and the owner saw chats that never started.
 *
 * Here a small frame goes out at once. A large frame waits in its own lane
 * and leaves in pieces, the next piece only while the socket's own buffer
 * is nearly empty, so a small frame waits behind one piece at most. Nothing
 * is dropped and nothing is capped: the large lane only holds frames back.
 *
 * Order: frames with the same lane key (one tunnel stream, all events, all
 * requests, all signals) keep their order, and a small frame waits behind
 * a large frame with its key. Replies have no key: each answers its own
 * request.
 *
 * Pieces go only to a peer that asked for them (`lanes=1` on the hub URL,
 * `lanes: 1` in the hub's welcome; `chunks=1` for the web app's text
 * pieces). Any other peer gets each frame whole, as before.
 */

/**
 * Feed the next piece of a large frame only below this many buffered bytes:
 * the buffer is nearly empty. On a fast link a write leaves at once, so
 * pieces still flow back to back.
 */
export const LANE_LOW = 4 * 1024;
/** Text pieces: the dc-chunk shape of frame-chunks.js, joined by FramePieces. */
const PIECE = CHUNK_AT;
/** Binary copy frames above this size go as HLMP parts (tunnel-frame.js). */
const BINARY_PIECE = 16_000;
/** The same bound `ws` puts on one whole message (its default maxPayload). */
export const JOIN_LIMIT = 100 * 1024 * 1024;

// Requests that carry a workspace or a file. Their accept is idempotent and
// keyed by their own id, so other requests need not wait behind them.
const BULK = new Set(['handoff.accept', 'transfer.accept']);

/** The order a frame must keep, or null when it may pass other frames. */
export function laneKey(frame) {
  if (!frame || typeof frame !== 'object') return null;
  if (typeof frame.sid === 'string') return `sid:${frame.sid}`;
  switch (frame.t) {
    case 'event': case 'hubEvent': case 'notify':
      return 'event';
    case 'rpc': case 'hubRpc':
      return BULK.has(frame.method) ? null : 'rpc';
    case 'signal': case 'signal.ready': case 'hubSignal': case 'hubSignalClose':
      return 'signal';
    case 'handoff.job': case 'handoff.complete': case 'handoff.result':
      return 'handoff';
    default:
      return null;
  }
}

function size(data) {
  return typeof data === 'string' ? data.length : data?.length ?? 0;
}

function textPieces(frame, gid, rid) {
  const n = Math.ceil(frame.length / PIECE);
  let i = 0;
  return {
    left: () => frame.length - i * PIECE,
    next() {
      const piece = JSON.stringify({ t: CHUNK_TYPE, gid, i, n, ...(rid != null ? { rid } : {}),
        data: frame.slice(i * PIECE, (i + 1) * PIECE) });
      i++;
      return { piece, last: i === n };
    },
  };
}

function wholePieces(list) {
  let i = 0;
  return {
    left: () => list.slice(i).reduce((sum, piece) => sum + size(piece), 0),
    next() { const piece = list[i++]; return { piece, last: i === list.length }; },
  };
}

export class FrameLanes {
  #sock;
  #text;
  #binary;
  #maxPieces;
  #low;
  #large = [];
  #keys = new Map();
  #queued = 0;
  #pumping = false;
  /** Writes whose callback has not come yet; each one wakes the pump. */
  #writes = 0;
  #wake = null;
  #groups = 0;
  #prefix = `l${randomBytes(3).toString('hex')}.`;

  /**
   * @param {object} sock  a `ws` WebSocket, or anything with readyState, send and bufferedAmount
   * @param {object} [opts]
   * @param {() => boolean} [opts.text]    whether the peer joins text pieces now
   * @param {() => boolean} [opts.binary]  whether the peer joins binary copy parts now
   * @param {number|(() => number)} [opts.maxPieces]  the most text pieces the peer joins for one frame
   */
  constructor(sock, { text = () => false, binary = () => false, maxPieces = Infinity, low = LANE_LOW } = {}) {
    this.#sock = sock;
    this.#text = text;
    this.#binary = binary;
    this.#maxPieces = maxPieces;
    this.#low = low;
    sock.on?.('close', () => this.#drop(new Error('socket closed')));
  }

  /** Bytes in the socket buffer plus bytes this queue still holds back. */
  get bufferedAmount() { return (this.#sock.bufferedAmount ?? 0) + this.#queued; }
  /** Bytes this queue still holds back. */
  get queued() { return this.#queued; }

  /**
   * Send one encoded frame.
   * @param {string|Buffer} data
   * @param {object} [opts]
   * @param {string|null} [opts.key]  frames with the same key keep their order (laneKey)
   * @param {string} [opts.rid]       the request a reply answers, named on each text piece
   * @param {(error?: Error) => void} [opts.done]  called once its last byte left this process, or it failed
   */
  send(data, { key = null, rid, done } = {}) {
    if (this.#sock.readyState !== 1) { done?.(new Error('socket closed')); return; }
    const bytes = size(data);
    if (bytes <= PIECE && !(key && this.#keys.has(key))) {
      this.#write(data, done);
      return;
    }
    this.#large.push({ pieces: this.#cut(data, rid), key, done, bytes });
    this.#queued += bytes;
    if (key) this.#keys.set(key, (this.#keys.get(key) ?? 0) + 1);
    this.#pump();
  }

  #cut(data, rid) {
    if (typeof data === 'string') {
      const most = typeof this.#maxPieces === 'function' ? this.#maxPieces() : this.#maxPieces;
      if (data.length > PIECE && this.#text() && Math.ceil(data.length / PIECE) <= most) {
        return textPieces(data, `${this.#prefix}${(++this.#groups).toString(36)}`, rid);
      }
      return wholePieces([data]);
    }
    if (data.length > BINARY_PIECE && this.#binary()) {
      try { return wholePieces(fragmentTunnelFrame(data)); } catch { /* not a copy frame: send it whole */ }
    }
    return wholePieces([data]);
  }

  #write(data, done) {
    this.#writes++;
    let called = false;
    const after = (error) => {
      if (called) return;
      called = true;
      this.#writes--;
      done?.(error ?? undefined);
      if (this.#large.length) this.#pump();
    };
    try { this.#sock.send(data, after); }
    catch (error) { after(error); }
  }

  #pump() {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (this.#large.length) {
        if (this.#sock.readyState !== 1) { this.#drop(new Error('socket closed')); return; }
        if ((this.#sock.bufferedAmount ?? 0) >= this.#low) {
          // Bytes another writer put there (a ping, a close) bring no
          // callback here: look again shortly instead of waiting forever.
          if (!this.#writes && !this.#wake) {
            this.#wake = setTimeout(() => { this.#wake = null; this.#pump(); }, 50);
            this.#wake.unref?.();
          }
          return;
        }
        const entry = this.#large[0];
        const before = entry.pieces.left();
        const { piece, last } = entry.pieces.next();
        const left = last ? 0 : entry.pieces.left();
        this.#queued -= Math.min(before - left, this.#queued);
        if (last) {
          this.#large.shift();
          if (entry.key) {
            const count = this.#keys.get(entry.key) - 1;
            if (count > 0) this.#keys.set(entry.key, count); else this.#keys.delete(entry.key);
          }
        }
        this.#write(piece, last ? entry.done : undefined);
      }
    } finally {
      this.#pumping = false;
    }
  }

  #drop(error) {
    clearTimeout(this.#wake);
    this.#wake = null;
    const lost = this.#large.splice(0);
    this.#keys.clear();
    this.#queued = 0;
    for (const entry of lost) entry.done?.(error);
  }
}

/**
 * The receiving side of text pieces: one frame back from its dc-chunk
 * pieces. Pieces of several frames may arrive mixed with each other and
 * with whole frames.
 */
export class FramePieces {
  #groups = new Map();
  #bytes = 0;
  #limit;
  constructor({ limit = JOIN_LIMIT } = {}) { this.#limit = limit; }

  /**
   * @param {object} msg  one decoded frame
   * @returns {string|null|undefined} the whole frame's text once its last
   *   piece is here, null while pieces are missing, undefined when msg is
   *   not a piece
   */
  take(msg) {
    if (msg?.t !== CHUNK_TYPE) return undefined;
    const { gid, i, n, data } = msg;
    if (typeof gid !== 'string' || gid.length > 100 || typeof data !== 'string' || data.length > PIECE
        || !Number.isInteger(n) || n < 2 || !Number.isInteger(i) || i < 0 || i >= n) return null;
    let group = this.#groups.get(gid);
    if (!group) { group = { n, parts: new Array(n), got: 0, bytes: 0 }; this.#groups.set(gid, group); }
    if (group.n !== n || group.parts[i] !== undefined) return null;
    if (group.refused || this.#bytes + data.length > this.#limit) {
      // Larger than one whole WebSocket message may be: the same refusal.
      // The group stays marked until its last piece, so it cannot restart.
      this.#bytes -= group.bytes;
      Object.assign(group, { refused: true, parts: [], bytes: 0 });
      if (i === n - 1) this.#groups.delete(gid);
      return null;
    }
    group.parts[i] = data;
    group.got++;
    group.bytes += data.length;
    this.#bytes += data.length;
    if (group.got < n) return null;
    this.#groups.delete(gid);
    this.#bytes -= group.bytes;
    return group.parts.join('');
  }

  clear() { this.#groups.clear(); this.#bytes = 0; }
}
