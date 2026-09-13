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
      channel.onmessage = (ev) => this.#onMessage(peer, ev.data);
      channel.onclose = () => { peer.channel = null; };
    };

    return peer;
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
      if (peer.channel?.readyState === 'open') {
        peer.channel.send(JSON.stringify({ t: 'rpcResult', ...body }));
      }
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
  broadcast(kind, payload) {
    const frame = JSON.stringify({ t: 'event', kind, payload });
    for (const peer of this.#peers.values()) {
      if (peer.channel?.readyState === 'open') peer.channel.send(frame);
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
