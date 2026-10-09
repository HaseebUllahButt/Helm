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

async function sendBuffered(channel, frame) {
  if (!channel) return false;
  const deadline = Date.now() + 120_000;
  while (channel.readyState === 'connecting' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (channel.readyState !== 'open') return false;
  const pieces = fragment(frame, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  for (const piece of pieces) {
    while (channel.readyState === 'open' && channel.bufferedAmount > 512 * 1024 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (channel.readyState !== 'open' || Date.now() >= deadline) return false;
    channel.send(piece);
  }
  return true;
}

const TUNNEL_TYPES = new Set(['tunnel.open', 'tunnel.ack', 'tunnel.data', 'tunnel.close']);

export class PeerHub {
  #peers = new Map();
  #transportSeq = 0;

  /**
   * @param {(peer: string, payload: object, link?: object) => void} sendSignal  post a signalling blob back
   * @param {(method: string, params: object, caller?: string) => Promise<any>} dispatch  the daemon's RPC handler
   */
  constructor(sendSignal, dispatch, { onTunnel = null, onTunnelClose = null } = {}) {
    this.sendSignal = sendSignal;
    this.dispatch = dispatch;
    this.onTunnel = onTunnel;
    this.onTunnelClose = onTunnelClose;
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

    if (payload?.type === 'offer') {
      if (!device) return;
      this.drop(peerId);
      peer = this.#create(peerId, link);
      peer.negotiation = payload.negotiation;
    }

    if (!peer) return;
    if (payload.negotiation && payload.negotiation !== peer.negotiation) return;
    if (link) peer.link = link;
    // Which device this channel belongs to, so a revocation can find it.
    if (device) peer.device = device;

    const { pc } = peer;
    if (payload.type === 'offer') {
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
        if (this.#peers.get(peerId) !== peer) return;
        peer.remoteReady = true;
        for (const candidate of peer.candidates.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
        const answer = await pc.createAnswer();
        if (this.#peers.get(peerId) !== peer) return;
        await pc.setLocalDescription(answer);
        if (this.#peers.get(peerId) !== peer) return;
        this.sendSignal(peerId, { type: 'answer', sdp: pc.localDescription.sdp, negotiation: peer.negotiation }, peer.link);
      } catch (error) {
        this.drop(peerId, peer);
        throw error;
      }
      return;
    }
    if (payload.type === 'candidate' && payload.candidate) {
      if (!peer.remoteReady) {
        if (peer.candidates.length < 128) peer.candidates.push(payload.candidate);
        return;
      }
      await pc.addIceCandidate(payload.candidate).catch(() => {});
    }
  }

  #create(peerId, link = null) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const peer = { id: peerId, pc, channel: null, link, remoteReady: false, candidates: [] };
    peer.transport = {
      id: `dc-${peerId}-${++this.#transportSeq}`,
      send: (t, extra = {}) => this.#sendTunnel(peerId, peer, t, extra),
    };
    this.#peers.set(peerId, peer);
    peer.deadline = setTimeout(() => this.drop(peerId, peer), 20_000);
    peer.deadline.unref?.();

    pc.onicecandidate = ({ candidate }) => {
      if (candidate && this.#peers.get(peerId) === peer) {
        this.sendSignal(peerId, { type: 'candidate', candidate, negotiation: peer.negotiation }, peer.link);
      }
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        this.drop(peerId, peer);
      }
    };

    pc.ondatachannel = ({ channel }) => {
      if (this.#peers.get(peerId) !== peer) { channel.close(); return; }
      peer.channel = channel;
      peer.fragments = new Map();
      channel.onopen = () => clearTimeout(peer.deadline);
      if (channel.readyState === 'open') clearTimeout(peer.deadline);
      channel.onmessage = (ev) => this.#onRaw(peer, ev.data);
      channel.onclose = () => this.drop(peerId, peer);
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
    if (typeof gid !== 'string' || gid.length > 100
        || typeof data !== 'string' || data.length > DC_CHUNK_AT
        || !Number.isInteger(n) || n <= 1 || n > 4195) return null;
    if (!peer.fragments) peer.fragments = new Map();
    let entry = peer.fragments.get(gid);
    if (!entry) {
      entry = { n, parts: new Array(n), got: 0, at: Date.now() };
      peer.fragments.set(gid, entry);
    }
    if (n !== entry.n || !Number.isInteger(i) || i < 0 || i >= entry.n || entry.parts[i] !== undefined) return null;
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
    if (TUNNEL_TYPES.has(msg.t)) {
      if (!this.onTunnel) {
        if (msg.t === 'tunnel.open') {
          this.#sendTunnel(peer.id, peer, 'tunnel.close', { sid: msg.sid, reason: 'unsupported tunnel' });
        }
        return;
      }
      try { this.onTunnel(peer.transport, msg, peer.device); } catch {}
      return;
    }
    if (msg.t !== 'rpc') return;

    const reply = (body) => {
      return sendBuffered(peer.channel, JSON.stringify({ t: 'rpcResult', ...body }));
    };

    try {
      await reply({ id: msg.id, ok: true, result: await this.dispatch(msg.method, msg.params ?? {}, peer.device) });
    } catch (err) {
      await reply({
        id: msg.id, ok: false,
        error: { code: err.code || 'error', message: String(err?.message || err) },
      }).catch(() => {});
    }
  }

  /** Push an event to every connected client that took the direct route. */
  broadcast(kind, payload, eid) {
    const frame = JSON.stringify({ t: 'event', kind, payload, eid });
    for (const peer of this.#peers.values()) {
      sendFrame(peer.channel, frame);
    }
  }

  drop(peerId, expected) {
    const peer = this.#peers.get(peerId);
    if (!peer || (expected && expected !== peer)) return;
    this.#peers.delete(peerId);
    clearTimeout(peer.deadline);
    peer.fragments?.clear();
    try { peer.channel?.close(); peer.pc.close(); } catch { /* already torn down */ }
    const transport = peer.transport;
    peer.transport = null;
    if (transport) {
      try { this.onTunnelClose?.(transport); } catch {}
    }
  }

  #sendTunnel(peerId, peer, t, extra) {
    const run = (peer.sendChain ?? Promise.resolve()).then(async () => {
      let ok = false;
      try { ok = await sendBuffered(peer.channel, JSON.stringify({ t, ...extra })); } catch {}
      if (!ok) this.drop(peerId, peer);
      return ok;
    });
    peer.sendChain = run.catch(() => {});
    return run;
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
