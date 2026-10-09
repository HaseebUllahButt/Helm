import { RTCPeerConnection } from 'node-datachannel/polyfill';
import { randomBytes } from 'node:crypto';

const CHUNK = 16_000;
const MAX_FRAME = 64 * 1024 * 1024;

export function directPeer({ signal, onMessage, onClose, connectTimeout = 5000 }) {
  const pc = new RTCPeerConnection({ iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ] });
  const channel = pc.createDataChannel('helm', { ordered: true });
  const negotiation = randomBytes(12).toString('hex');
  const candidates = [];
  const localCandidates = [];
  const fragments = new Map();
  let offerSent = false, remoteReady = false;
  let open = false, closed = false;
  let sendChain = Promise.resolve();
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const finish = (error) => {
    if (closed) return;
    closed = true;
    clearTimeout(connectTimer);
    try { channel.close(); pc.close(); } catch {}
    if (!open) rejectReady(error ?? new Error('direct channel closed'));
    try { onClose?.(error); } catch {}
  };
  const connectTimer = setTimeout(() => finish(new Error('direct connection timed out')), connectTimeout);
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
        if (fragments.size >= 8) return;
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
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) finish(new Error('direct connection closed'));
  };
  pc.onicecandidate = ({ candidate }) => {
    if (!candidate || closed) return;
    if (offerSent) signal({ type: 'candidate', candidate, negotiation });
    else localCandidates.push(candidate);
  };
  const start = async () => {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (!closed) {
      signal({ type: 'offer', sdp: pc.localDescription.sdp, negotiation });
      offerSent = true;
      for (const candidate of localCandidates.splice(0)) signal({ type: 'candidate', candidate, negotiation });
    }
  };
  start().catch((error) => finish(error));

  const sendBuffered = async (serialized) => {
    const count = Math.ceil(serialized.length / CHUNK);
    const gid = randomBytes(12).toString('hex');
    for (let index = 0; index < count; index++) {
      const deadline = Date.now() + 120_000;
      while (!closed && channel.readyState === 'open' && channel.bufferedAmount > 512 * 1024 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (closed || channel.readyState !== 'open') throw new Error('direct channel closed');
      if (Date.now() >= deadline) throw new Error('direct channel backpressure did not drain');
      channel.send(count === 1 ? serialized : JSON.stringify({
        t: 'dc-chunk', gid, i: index, n: count,
        data: serialized.slice(index * CHUNK, (index + 1) * CHUNK),
      }));
    }
  };
  return {
    ready,
    close: () => finish(new Error('direct channel closed')),
    send(frame) {
      let serialized;
      try { serialized = JSON.stringify(frame); } catch { return Promise.reject(new Error('unserializable direct frame')); }
      if (typeof serialized !== 'string') return Promise.reject(new Error('unserializable direct frame'));
      if (serialized.length > MAX_FRAME) return Promise.reject(new Error('direct frame exceeds size limit'));
      const run = sendChain.then(() => sendBuffered(serialized));
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
          if (remoteReady) await pc.addIceCandidate(payload.candidate);
          else if (candidates.length < 128) candidates.push(payload.candidate);
        }
      } catch (error) { finish(error); }
    },
  };
}

export function directRpc({ signal, frame, timeout = 240_000, connectTimeout = 3000 }) {
  let settled = false;
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
  peer = directPeer({
    signal,
    connectTimeout,
    onMessage: (message) => {
      if (message?.t !== 'rpcResult' || message.id !== frame.id) return;
      if (message.ok) finish(null, message.result);
      else finish(Object.assign(new Error(message.error?.message || 'direct RPC failed'), { rpc: true, code: message.error?.code }));
    },
    onClose: (error) => finish(error ?? new Error('direct channel closed')),
  });
  peer.ready
    .then(() => peer.send(frame))
    .catch((error) => finish(error));
  return {
    result,
    close: () => finish(new Error('direct RPC closed')),
    receive: async (payload) => peer.receive(payload),
  };
}
