import { RTCPeerConnection } from 'node-datachannel/polyfill';
import { randomBytes } from 'node:crypto';

const CHUNK = 16_000;
const MAX_FRAME = 64 * 1024 * 1024;

export function directRpc({ signal, frame, timeout = 240_000, connectTimeout = 3000 }) {
  const pc = new RTCPeerConnection({ iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ] });
  const channel = pc.createDataChannel('helm', { ordered: true });
  let settled = false;
  let resolveResult, rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(connectTimer);
    clearTimeout(timer);
    try { channel.close(); pc.close(); } catch {}
    if (error) rejectResult(error); else resolveResult(value);
  };
  const connectTimer = setTimeout(() => finish(new Error('direct connection timed out')), connectTimeout);
  const timer = setTimeout(() => finish(new Error('direct RPC timed out')), timeout);
  const fragments = new Map();
  channel.onmessage = ({ data }) => {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message.t === 'dc-chunk') {
      if (!Number.isInteger(message.n) || message.n < 2 || message.n > Math.ceil(MAX_FRAME / CHUNK)
          || !Number.isInteger(message.i) || message.i < 0 || message.i >= message.n
          || typeof message.data !== 'string' || message.data.length > CHUNK
          || typeof message.gid !== 'string' || message.gid.length > 100) return;
      let entry = fragments.get(message.gid);
      if (!entry) {
        if (fragments.size >= 2) return;
        entry = { parts: new Array(message.n), got: 0 };
        fragments.set(message.gid, entry);
      }
      if (entry.parts.length !== message.n || entry.parts[message.i] !== undefined) return;
      entry.parts[message.i] = message.data;
      if (++entry.got !== message.n) return;
      fragments.delete(message.gid);
      try { message = JSON.parse(entry.parts.join('')); } catch { return; }
    }
    if (message.t !== 'rpcResult' || message.id !== frame.id) return;
    if (message.ok) finish(null, message.result);
    else finish(Object.assign(new Error(message.error?.message || 'direct RPC failed'), { rpc: true, code: message.error?.code }));
  };
  channel.onclose = () => finish(new Error('direct channel closed'));
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) finish(new Error('direct connection closed'));
  };
  pc.onicecandidate = ({ candidate }) => {
    if (candidate && !settled) signal({ type: 'candidate', candidate });
  };
  channel.onopen = async () => {
    clearTimeout(connectTimer);
    try {
      const serialized = JSON.stringify(frame);
      if (serialized.length > MAX_FRAME) throw new Error('direct request exceeds size limit');
      const count = Math.ceil(serialized.length / CHUNK);
      const gid = randomBytes(12).toString('hex');
      for (let index = 0; index < count; index++) {
        while (!settled && channel.bufferedAmount > 512 * 1024) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        if (settled) return;
        channel.send(count === 1 ? serialized : JSON.stringify({
          t: 'dc-chunk', gid, i: index, n: count,
          data: serialized.slice(index * CHUNK, (index + 1) * CHUNK),
        }));
      }
    } catch (error) { finish(error); }
  };
  const start = async () => {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (!settled) signal({ type: 'offer', sdp: pc.localDescription.sdp });
  };
  start().catch((error) => finish(error));
  return {
    result,
    close: () => finish(new Error('direct RPC closed')),
    receive: async (payload) => {
      if (settled) return;
      try {
        if (payload?.type === 'answer') await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
        else if (payload?.type === 'candidate' && payload.candidate) await pc.addIceCandidate(payload.candidate);
      } catch (error) { finish(error); }
    },
  };
}
