import { RTCPeerConnection } from 'node-datachannel/polyfill';
import { randomBytes } from 'node:crypto';
import { loadNetwork } from '@helm/protocol/network';
import { signDirectOffer } from './direct-auth.js';
import { nativeDirectConfig } from './direct-config.js';

const CHUNK = 16_000;
const MAX_FRAME = 64 * 1024 * 1024;

export function directPeer({ signal, onMessage, onClose, connectTimeout = 5000, env, rtcConfig = nativeDirectConfig() }) {
  const pc = new RTCPeerConnection(rtcConfig);
  const channel = pc.createDataChannel('helm', { ordered: true });
  const negotiation = randomBytes(12).toString('hex');
  const candidates = [];
  const localCandidates = [];
  const fragments = new Map();
  let offerSent = false, remoteReady = false;
  let open = false, closed = false;
  let disconnectedTimer;
  let localCount = 0, remoteCount = 0;
  let sendChain = Promise.resolve();
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const finish = (error) => {
    if (closed) return;
    closed = true;
    clearTimeout(connectTimer);
    clearTimeout(disconnectedTimer);
    try { channel.close(); pc.close(); } catch {}
    if (!open) rejectReady(error ?? new Error('direct channel closed'));
    try { onClose?.(error); } catch {}
  };
  const connectTimer = setTimeout(() => finish(new Error(`direct connection timed out (${remoteReady ? 'answer received' : 'no answer'}; ${localCount} local, ${remoteCount} remote addresses; ${pc.iceConnectionState})`)), connectTimeout);
  channel.onmessage = ({ data }) => {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (message.t === 'dc-chunk') {
      if (!Number.isInteger(message.n) || message.n < 2 || message.n > Math.ceil(MAX_FRAME / CHUNK)
          || !Number.isInteger(message.i) || message.i < 0 || message.i >= message.n
          || typeof message.data !== 'string' || message.data.length > CHUNK
          || typeof message.gid !== 'string' || message.gid.length > 100) return;
      let entry = fragments.get(message.gid);
      if (!entry) {
        // A channel kept open between machines sees many large replies over
        // its life. One the sender gave up on halfway never completes, so the
        // oldest half-built frame makes room rather than the newest being
        // refused - refusing would fail every large reply after eight such.
        if (fragments.size >= 8) fragments.delete(fragments.keys().next().value);
        entry = { parts: new Array(message.n), got: 0 };
        fragments.set(message.gid, entry);
      }
      if (entry.parts.length !== message.n || entry.parts[message.i] !== undefined) return;
      entry.parts[message.i] = message.data;
      if (++entry.got !== message.n) return;
      fragments.delete(message.gid);
      try { message = JSON.parse(entry.parts.join('')); } catch { return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    }
    try { onMessage?.(message); } catch {}
  };
  channel.onopen = () => { open = true; clearTimeout(connectTimer); resolveReady(); };
  channel.onclose = () => finish(open ? undefined : new Error('direct channel closed'));
  pc.onconnectionstatechange = () => {
    clearTimeout(disconnectedTimer);
    if (['failed', 'closed'].includes(pc.connectionState)) finish(new Error(`direct connection ${pc.connectionState}`));
    // Brief packet loss is recoverable. Closing immediately makes the two
    // sides discard a channel that ICE could still restore on its own.
    else if (pc.connectionState === 'disconnected') disconnectedTimer = setTimeout(() => finish(new Error('direct connection lost')), 5000);
  };
  pc.onicecandidate = ({ candidate }) => {
    if (!candidate || closed) return;
    localCount++;
    if (offerSent) signal({ type: 'candidate', candidate, negotiation });
    else localCandidates.push(candidate);
  };
  const start = async () => {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (!closed) {
      signal(signDirectOffer(loadNetwork(), env, { type: 'offer', sdp: pc.localDescription.sdp, negotiation }));
      offerSent = true;
      for (const candidate of localCandidates.splice(0)) signal({ type: 'candidate', candidate, negotiation });
    }
  };
  start().catch((error) => finish(error));

  // `unsent` on a failure means not one byte of this frame left: the caller
  // may send it another way without any chance of it running twice.
  const sendBuffered = async (serialized, onStart) => {
    const count = Math.ceil(serialized.length / CHUNK);
    const gid = randomBytes(12).toString('hex');
    for (let index = 0; index < count; index++) {
      const deadline = Date.now() + 120_000;
      while (!closed && channel.readyState === 'open' && channel.bufferedAmount > 512 * 1024 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (closed || channel.readyState !== 'open') throw Object.assign(new Error('direct channel closed'), { unsent: index === 0 });
      if (Date.now() >= deadline) throw Object.assign(new Error('direct channel backpressure did not drain'), { unsent: index === 0 });
      if (index === 0) onStart?.();
      channel.send(count === 1 ? serialized : JSON.stringify({
        t: 'dc-chunk', gid, i: index, n: count,
        data: serialized.slice(index * CHUNK, (index + 1) * CHUNK),
      }));
    }
  };
  return {
    ready,
    close: () => finish(new Error('direct channel closed')),
    send(frame, onStart) {
      const unsent = (message) => Promise.reject(Object.assign(new Error(message), { unsent: true }));
      let serialized;
      try { serialized = JSON.stringify(frame); } catch { return unsent('unserializable direct frame'); }
      if (typeof serialized !== 'string') return unsent('unserializable direct frame');
      if (serialized.length > MAX_FRAME) return unsent('direct frame exceeds size limit');
      const run = sendChain.then(() => sendBuffered(serialized, onStart));
      sendChain = run.catch(() => {});
      return run;
    },
    async receive(payload) {
      if (closed || (payload?.negotiation && payload.negotiation !== negotiation)) return;
      try {
        if (payload?.type === 'answer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
          remoteReady = true;
          for (const candidate of candidates.splice(0)) await pc.addIceCandidate(candidate);
        } else if (payload?.type === 'candidate' && payload.candidate) {
          remoteCount++;
          if (remoteReady) await pc.addIceCandidate(payload.candidate);
          else if (candidates.length < 128) candidates.push(payload.candidate);
        }
      } catch (error) { finish(error); }
    },
  };
}

export function directRpc({ signal, frame, timeout = 240_000, connectTimeout = 3000, makePeer = directPeer }) {
  let settled = false;
  let generation = 0, dispatched = false;
  let resolveResult, rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  let peer = null;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { peer?.close(); } catch {}
    if (error) rejectResult(error); else resolveResult(value);
  };
  const timer = setTimeout(() => finish(new Error('direct RPC timed out')), timeout);
  const connect = (attempt) => {
    const failed = (error) => {
      if (settled || attempt !== generation) return;
      // libdatachannel can reject an early answer before its ICE transport
      // exists. One fresh offer recovers that startup race. Once sending has
      // begun, delivery is uncertain and retrying could execute a write twice.
      if (!dispatched && attempt === 1 && /without ICE transport/i.test(error?.message ?? '')) {
        generation++;
        try { peer?.close(); } catch {}
        connect(generation);
      } else finish(error ?? new Error('direct channel closed'));
    };
    try {
      const candidate = makePeer({
        signal, connectTimeout, env: frame.env,
        onMessage: (message) => {
          if (settled || attempt !== generation || message?.t !== 'rpcResult' || message.id !== frame.id) return;
          if (message.ok) finish(null, message.result);
          else finish(Object.assign(new Error(message.error?.message || 'direct RPC failed'), { rpc: true, code: message.error?.code }));
        },
        onClose: failed,
      });
      if (settled || attempt !== generation) {
        candidate.ready.catch(() => {});
        try { candidate.close(); } catch {}
        return;
      }
      peer = candidate;
      candidate.ready.then(() => {
        if (settled || attempt !== generation) return;
        dispatched = true;
        return candidate.send(frame);
      }).catch(failed);
    } catch (error) { failed(error); }
  };
  connect(++generation);
  return {
    result,
    close: () => finish(new Error('direct RPC closed')),
    receive: async (payload) => peer.receive(payload),
  };
}
