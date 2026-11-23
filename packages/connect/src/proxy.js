import WebSocket from 'ws';
import { beginTransferActivity } from '@helm/protocol/transfer-activity';
import { sshPeer, directSshAddresses, hasPinnedSshHost, connectDirectSsh, bridgeDirectSsh } from './direct-ssh.js';
import { TunnelSender, TunnelReceiver, STREAM_WINDOW, tunnelWindow } from './tunnel-flow.js';
import { encodeTunnelFrame, decodeTunnelFrame, frameCompress } from '../../protocol/tunnel-frame.js';
import { T } from '@helm/protocol';
import { requireNetwork, hubCredential, hubAddresses } from '@helm/protocol/network';

/** SSH stays end-to-end encrypted; hubs only carry its byte stream. */
export async function proxy(host, port) {
  return connectProxy(host, port);
}

async function connectProxy(host, port) {
  const net = requireNetwork();
  const peer = sshPeer(net, host);
  if (peer && net.revoked?.[peer.id]) throw new Error('target machine was removed from this network');
  port ??= peer?.sshPort ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid SSH port');
  // Never trust a fresh LAN address for first-use host-key pinning. Establish
  // that key through the authenticated hub first, then SSH checks it on LAN.
  if (peer && !net.revoked?.[peer.id] && await hasPinnedSshHost(host, port)) {
    for (const address of directSshAddresses(net, host)) {
      let socket;
      try { socket = await connectDirectSsh(address, port); } catch { continue; }
      const release = beginTransferActivity();
      try { return await bridgeDirectSsh(socket); } finally { release(); }
    }
  }
  const hubs = hubAddresses(net);
  const failures = [];
  for (const hub of hubs) {
    for (const path of ['/helm/ws', '/ws']) {
      try {
        // Handshake credentials are single use, including path retries.
        return await bridge(hub, await hubCredential(net, hub), peer?.id ?? host, port, { path });
      } catch (err) {
        // Never replay an established SSH stream into another connection.
        if (err.established) throw err;
        failures.push(`${hub}${path}: ${err.message}`);
        if (!err.legacyPath) break;
      }
    }
  }
  throw new Error(`could not reach "${host}" through any hub\n  ${failures.join('\n  ')}`);
}

/**
 * The same stream as `bridge`, over a direct channel to the machine instead
 * of a hub. `openChannel(handlers)` gives { send(t, extra) -> Promise,
 * close() } or null (hub-mesh.js tunnel); frames for the stream reach
 * handlers.onFrame, a lost channel handlers.onClose. Always with credit.
 * Rejects with `established` as `bridge` does, so a caller can try a hub
 * only when no byte has moved.
 */
export function bridgeDirect(openChannel, port, { input, output, timeout = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    let open = false, settled = false, ended = false;
    // Whether the far end still holds the stream and needs a close.
    let farHolds = false;
    let sender, receiver, release, linger = null, channel = null;
    const shutdown = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(linger);
      release?.();
      input.pause();
      sender?.stop();
      receiver?.stop();
      input.off('end', end);
      input.off('close', gone);
      input.off('error', shutdown);
      output.off('error', shutdown);
      // Given up on (a timeout, this side's socket gone): the far end must
      // not keep a socket to the app open for it.
      if (farHolds) channel.send(T.TUNNEL_CLOSE, {}).catch(() => {});
      channel?.close();
      if (err) { err.established = open; reject(err); } else resolve();
    };
    const send = (t, extra) => channel.send(t, extra).catch((err) => shutdown(err ?? new Error('direct channel closed')));
    const end = () => {
      ended = true;
      const close = () => {
        farHolds = false;
        send(T.TUNNEL_CLOSE, {});
        // As `bridge`: a close is the whole stream, both ways, unanswered.
        linger = setTimeout(() => shutdown(), 2000);
      };
      if (sender) sender.finish(close); else close();
    };
    const gone = () => {
      if (!ended) shutdown(new Error('connection closed'));
      else if (output.destroyed) shutdown();
    };
    const timer = setTimeout(() => shutdown(new Error('direct stream open timed out')), timeout);
    channel = openChannel({
      onClose: (err) => { farHolds = false; shutdown(err ?? new Error('direct channel closed')); },
      onFrame: (msg) => {
        if (settled) return;
        if (msg.t === T.TUNNEL_CLOSE) farHolds = false;
        if (msg.t === T.TUNNEL_READY && !open) {
          open = true;
          release = beginTransferActivity();
          clearTimeout(timer);
          receiver = new TunnelReceiver(output, (bytes) => send(T.TUNNEL_ACK, { bytes }), shutdown, { window: STREAM_WINDOW });
          sender = new TunnelSender(input, (chunk) => send(T.TUNNEL_DATA, { data: chunk }), shutdown, { window: tunnelWindow(msg.window) });
          input.on('end', end);
          input.on('error', shutdown);
          output.on('error', shutdown);
        } else if (msg.t === T.TUNNEL_ACK && sender) sender.ack(msg.bytes);
        else if (msg.t === T.TUNNEL_DATA && receiver) receiver.write(msg.data);
        else if (msg.t === T.TUNNEL_CLOSE) {
          shutdown(open && (!msg.reason || msg.reason === 'closed')
            ? null : Object.assign(new Error(msg.reason || 'tunnel refused'), { far: true }));
        }
      },
    });
    if (!channel) { shutdown(new Error('no direct channel')); return; }
    input.once('close', gone);
    if (input.destroyed) process.nextTick(gone);
    farHolds = true;
    send(T.TUNNEL_OPEN, { port, flow: 1, window: STREAM_WINDOW });
  });
}

export function bridge(hub, token, host, port, {
  path = '/helm/ws', input = process.stdin, output = process.stdout, timeout = 5000,
} = {}) {
  return new Promise((resolve, reject) => {
    // binaryTunnel=1: bytes go as binary frames once the hub's welcome says
    // it takes them. An older hub says nothing, and gets base64 as before.
    const ws = new WebSocket(`${hub.replace(/^http/, 'ws')}${path}?role=proxy&binaryTunnel=1`, {
      headers: { authorization: `Bearer ${token}` }, handshakeTimeout: timeout,
    });
    const sid = `p${Date.now().toString(36)}`;
    let open = false;
    let settled = false;
    let sender, receiver;
    let release;
    let linger = null;
    let binary = false;
    /** Tunnel bytes: binary when the hub takes that, and video or SSH never deflated. */
    const sendData = (chunk) => {
      const msg = { t: T.TUNNEL_DATA, sid, data: chunk };
      const encoded = encodeTunnelFrame(msg, binary);
      if (frameCompress(msg, encoded) === false) ws.send(encoded, { compress: false });
      else ws.send(encoded);
    };
    const timer = setTimeout(() => shutdown(new Error('tunnel open timed out')), timeout);
    const drain = () => { if (!settled) ws.resume(); };
    const send = (chunk) => {
      input.pause();
      // A hub without credit: pieces of any size, so base64, as before.
      ws.send(JSON.stringify({ t: T.TUNNEL_DATA, sid, data: chunk.toString('base64') }), (err) => {
        if (err) shutdown(err);
        else if (!settled) input.resume();
      });
    };
    let ended = false;
    const end = () => {
      ended = true;
      const close = () => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: T.TUNNEL_CLOSE, sid }));
        // A close is the whole tunnel, both ways, and nobody answers it: the
        // hub forgets the stream and the far machine drops its socket. Waiting
        // for a reply kept one hub socket open per finished connection, for
        // as long as `helm forward` ran. Bytes already on their way get a
        // moment to land; then this side is done too.
        linger = setTimeout(() => shutdown(), 2000);
      };
      if (sender) sender.finish(close); else close();
    };
    // The input torn down without ending first (a browser that gave up before
    // the tunnel was ready, `helm forward` stopping): nothing waits for a
    // tail, so the tunnel goes now. A socket that ended before the tunnel was
    // ready never fires 'end' for us; this is the only word of it.
    // Torn down after it ended, too: nothing is left to deliver a tail to.
    const gone = () => {
      if (!ended) shutdown(new Error('connection closed'));
      else if (output.destroyed) shutdown();
    };
    input.once('close', gone);
    if (input.destroyed) process.nextTick(gone);
    const shutdown = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(linger);
      release?.();
      input.pause();
      sender?.stop();
      receiver?.stop();
      input.off('data', send);
      input.off('end', end);
      input.off('close', gone);
      input.off('error', shutdown);
      output.off('drain', drain);
      output.off('error', shutdown);
      ws.terminate();
      if (err) { err.established = open; reject(err); } else resolve();
    };
    // `window`: what this end takes. An older hub or machine drops it.
    ws.on('open', () => ws.send(JSON.stringify({ t: T.TUNNEL_OPEN, sid, env: host, port, flow: 1, window: STREAM_WINDOW })));
    ws.on('message', (raw) => {
      let msg;
      try { msg = decodeTunnelFrame(raw); } catch { return; }
      if (msg?.t === T.WELCOME) { binary = msg.binaryTunnel === 1; return; }
      if (msg?.sid !== sid || settled) return;
      if (msg.t === T.TUNNEL_READY && !open) {
        open = true;
        release = beginTransferActivity();
        clearTimeout(timer);
        if (msg.flow === 1) {
          receiver = new TunnelReceiver(output, bytes => ws.send(JSON.stringify({ t: T.TUNNEL_ACK, sid, bytes })), shutdown,
            { window: STREAM_WINDOW });
          sender = new TunnelSender(input, sendData, shutdown, { window: tunnelWindow(msg.window) });
        } else input.on('data', send);
        input.on('end', end);
        input.on('error', shutdown);
        output.on('drain', drain);
        output.on('error', shutdown);
        input.resume();
      } else if (msg.t === T.TUNNEL_ACK && sender) {
        sender.ack(msg.bytes);
      } else if (msg.t === T.TUNNEL_DATA && open) {
        if (receiver) receiver.write(msg.data);
        else if (!output.write(Buffer.isBuffer(msg.data) ? msg.data : Buffer.from(msg.data, 'base64'))) ws.pause();
      } else if (msg.t === T.TUNNEL_CLOSE) {
        // `far`: the hub or the far machine said why, not this side's socket.
        shutdown(open && (!msg.reason || msg.reason === 'closed')
          ? null : Object.assign(new Error(msg.reason || 'tunnel refused'), { far: true }));
      }
    });
    ws.on('unexpected-response', (_req, res) => {
      const err = new Error(`hub answered ${res.statusCode}`);
      err.legacyPath = [404, 405].includes(res.statusCode);
      res.resume();
      shutdown(err);
    });
    ws.on('error', shutdown);
    ws.on('close', () => shutdown(new Error('hub closed the tunnel')));
  });
}
