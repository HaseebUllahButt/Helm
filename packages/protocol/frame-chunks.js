/**
 * One text frame as ordered pieces, so a slow link delivers whole messages
 * often. A WebSocket or data channel message counts only once it is whole:
 * a large reply looked like a dead link until its last byte. Direct
 * channels (peer.js) and hub sockets that ask for it (`chunks=1`) use this
 * shape; the app joins the pieces' `data` in order and parses the result.
 */
export const CHUNK_AT = 16_000;
export const CHUNK_TYPE = 'dc-chunk';
/** The most pieces a receiver accepts for one frame (client.ts accumulate). */
export const CHUNK_MAX = 2000;

/**
 * Pieces for a text frame, or the frame alone when it is small. `rid` names
 * the request a reply answers, so the receiver can tell which request is
 * still arriving; events carry none.
 */
export function chunkText(frame, gid, rid) {
  if (frame.length <= CHUNK_AT) return [frame];
  const n = Math.ceil(frame.length / CHUNK_AT);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(JSON.stringify({
      t: CHUNK_TYPE, gid, i, n, ...(rid != null ? { rid } : {}),
      data: frame.slice(i * CHUNK_AT, (i + 1) * CHUNK_AT),
    }));
  }
  return out;
}
