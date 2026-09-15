import { RTCPeerConnection } from 'node-datachannel/polyfill';

/**
 * Direct connections to clients.
 *
 * The relay introduces the two sides and then gets out of the way. This
 * matters more than it might sound: relaying a session through a distant VM
 * costs two internet round trips per redraw, while a direct connection on the
 * same network costs single-digit milliseconds. The relay stays as the
 * fallback for networks where hole punching cannot succeed.
 */
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/**
 * libdatachannel (and browsers) cap a single data-channel message well below
 * what a chat history can be - an old session's `session.events` reply is
 * easily megabytes. Anything over CHUNK_AT is fragmented into small
 * `dc-chunk` frames and reassembled on the other side (see client.ts, which
 * implements the same wire format). The relay path has no such limit, so a
 * direct copy that still fails to send is simply dropped: the hub already
 * carries the same event.
 */
export const DC_CHUNK_AT = 16_000;
export const DC_CHUNK_TYPE = 'dc-chunk';

/** Split a large frame into chunk frames. Small frames pass through as-is. */
export function fragment(frame, gid) {
  if (frame.length <= DC_CHUNK_AT) return [frame];
  const n = Math.ceil(frame.length / DC_CHUNK_AT);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(JSON.stringify({
      t: DC_CHUNK_TYPE, gid, i, n,
      data: frame.slice(i * DC_CHUNK_AT, (i + 1) * DC_CHUNK_AT),
    }));
  }
  return out;
}

/** Best-effort send of one (possibly fragmented) frame; never throws. */
function sendFrame(channel, frame) {
  if (!channel || channel.readyState !== 'open') return false;
  try {
    if (frame.length <= DC_CHUNK_AT) {
      channel.send(frame);
      return true;
    }
    const gid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    for (const piece of fragment(frame, gid)) channel.send(piece);
    return true;
  } catch {
    // "Message size exceeds" or a racing close: the relay carries the same
    // event, so dropping this copy is correct. RPC replies have no relay
    // copy; the caller times out and retries over the hub.
    return false;
  }
}

export class PeerHub {
  #peers = new Map();

  /**
   * @param {(peer: string, payload: object, link?: object) => void} sendSignal  post a signalling blob back
   * @param {(method: string, params: object) => Promise<any>} dispatch  the daemon's RPC handler
   */
  constructor(sendSignal, dispatch) {
    this.sendSignal = sendSignal;
    this.dispatch = dispatch;
  }

  /**
   * Handle one signalling blob from a client, creating the peer if needed.
   *
   * We remember which hub introduced this peer and answer back through the
   * same one. Blasting the answer at every hub we are attached to would work
   * - the others simply do not know the peer - but it puts a client's
   * signalling traffic in front of machines with no business seeing it.
   */
  async signal(peerId, payload, link = null, device = null) {
    let peer = this.#peers.get(peerId);

    if (!peer) {
      if (payload?.type !== 'offer') return; // candidates for a peer we dropped
      peer = this.#create(peerId, link);
    }
    if (link) peer.link = link;
    // Which device this channel belongs to, so a revocation can find it.
    if (device) peer.device = device;

    const { pc } = peer;
    if (payload.type === 'offer') {
      await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.sendSignal(peerId, { type: 'answer', sdp: pc.localDescription.sdp }, peer.link);
      return;
    }
    if (payload.type === 'candidate' && payload.candidate) {
      await pc.addIceCandidate(payload.candidate).catch(() => {});
    }
  }

  #create(peerId, link = null) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer = { pc, channel: null, link };
    this.#peers.set(peerId, peer);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.sendSignal(peerId, { type: 'candidate', candidate }, peer.link);
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        this.drop(peerId);
      }
    };

    pc.ondatachannel = ({ channel }) => {
      peer.channel = channel;
      peer.fragments = new Map();
      channel.onmessage = (ev) => this.#onRaw(peer, ev.data);
      channel.onclose = () => { peer.channel = null; peer.fragments?.clear(); };
    };

    return peer;
  }

  #onRaw(peer, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg?.t === DC_CHUNK_TYPE && typeof msg.gid === 'string') {
      const full = this.#accumulate(peer, msg);
      if (full == null) return;
      raw = full;
    }
    this.#onMessage(peer, raw);
  }

  #accumulate(peer, { gid, i, n, data }) {
    if (!peer.fragments) peer.fragments = new Map();
    let entry = peer.fragments.get(gid);
    if (!entry) {
      if (!Number.isInteger(n) || n <= 1 || n > 2000) return null;
      entry = { n, parts: new Array(n), got: 0, at: Date.now() };
      peer.fragments.set(gid, entry);
    }
    if (!Number.isInteger(i) || i < 0 || i >= entry.n || entry.parts[i] !== undefined) return null;
    entry.parts[i] = typeof data === 'string' ? data : '';
    entry.got++;
    // Stale fragments from a peer that went away mid-message must not leak.
    if (peer.fragments.size > 8) {
      const oldest = [...peer.fragments.keys()][0];
      peer.fragments.delete(oldest);
    }
    if (entry.got < entry.n) return null;
    peer.fragments.delete(gid);
    return entry.parts.join('');
  }

  /**
   * The data channel speaks the same RPC dialect as the relay path, so the
   * client's calls are identical whichever route they take.
   */
  async #onMessage(peer, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t !== 'rpc') return;

    const reply = (body) => {
      sendFrame(peer.channel, JSON.stringify({ t: 'rpcResult', ...body }));
    };

    try {
      reply({ id: msg.id, ok: true, result: await this.dispatch(msg.method, msg.params ?? {}) });
    } catch (err) {
      reply({
        id: msg.id, ok: false,
        error: { code: err.code || 'error', message: String(err?.message || err) },
      });
    }
  }

  /** Push an event to every connected client that took the direct route. */
  broadcast(kind, payload, eid) {
    const frame = JSON.stringify({ t: 'event', kind, payload, eid });
    for (const peer of this.#peers.values()) {
      sendFrame(peer.channel, frame);
    }
  }

  drop(peerId) {
    const peer = this.#peers.get(peerId);
    if (!peer) return;
    try { peer.channel?.close(); peer.pc.close(); } catch { /* already torn down */ }
    this.#peers.delete(peerId);
  }

  /**
   * Close every direct channel held by a revoked member. The channel was
   * authorised by the hub at introduction time; this is the matching teardown
   * when that authorisation is withdrawn.
   */
  dropRevoked(revoked = {}) {
    for (const [id, peer] of this.#peers) {
      if (peer.device && revoked[peer.device]) this.drop(id);
    }
  }

  get count() { return this.#peers.size; }

  stop() { for (const id of [...this.#peers.keys()]) this.drop(id); }
}
