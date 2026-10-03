import WebSocket from 'ws';
import { beginTransferActivity } from '@helm/protocol/transfer-activity';
import { sshPeer, directSshAddresses, hasPinnedSshHost, connectDirectSsh, bridgeDirectSsh } from './direct-ssh.js';
import { TunnelSender, TunnelReceiver } from './tunnel-flow.js';
import { T } from '@helm/protocol';
import { requireNetwork, hubCredential, allEndpoints } from '@helm/protocol/network';

/** SSH stays end-to-end encrypted; hubs only carry its byte stream. */
export async function proxy(host, port) {
  const release = beginTransferActivity();
  try { return await connectProxy(host, port); } finally { release(); }
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
      return bridgeDirectSsh(socket);
    }
  }
  const hubs = [...new Set([`http://127.0.0.1:${net.port ?? 8787}`, ...allEndpoints(net)])];
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

export function bridge(hub, token, host, port, {
  path = '/helm/ws', input = process.stdin, output = process.stdout, timeout = 5000,
} = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${hub.replace(/^http/, 'ws')}${path}?role=proxy`, {
      headers: { authorization: `Bearer ${token}` }, handshakeTimeout: timeout,
    });
    const sid = `p${Date.now().toString(36)}`;
    let open = false;
    let settled = false;
    let sender, receiver;
    const timer = setTimeout(() => shutdown(new Error('tunnel open timed out')), timeout);
    const drain = () => { if (!settled) ws.resume(); };
    const send = (chunk) => {
      input.pause();
      ws.send(JSON.stringify({ t: T.TUNNEL_DATA, sid, data: chunk.toString('base64') }), (err) => {
        if (err) shutdown(err);
        else if (!settled) input.resume();
      });
    };
    const end = () => {
      const close = () => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: T.TUNNEL_CLOSE, sid })); };
      if (sender) sender.finish(close); else close();
    };
    const shutdown = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.pause();
      sender?.stop();
      receiver?.stop();
      input.off('data', send);
      input.off('end', end);
      input.off('error', shutdown);
      output.off('drain', drain);
      output.off('error', shutdown);
      ws.terminate();
      if (err) { err.established = open; reject(err); } else resolve();
    };
    ws.on('open', () => ws.send(JSON.stringify({ t: T.TUNNEL_OPEN, sid, env: host, port, flow: 1 })));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.sid !== sid || settled) return;
      if (msg.t === T.TUNNEL_READY && !open) {
        open = true;
        clearTimeout(timer);
        if (msg.flow === 1) {
          receiver = new TunnelReceiver(output, bytes => ws.send(JSON.stringify({ t: T.TUNNEL_ACK, sid, bytes })), shutdown);
          sender = new TunnelSender(input, chunk => ws.send(JSON.stringify({ t: T.TUNNEL_DATA, sid, data: chunk.toString('base64') })), shutdown);
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
        else if (!output.write(Buffer.from(msg.data, 'base64'))) ws.pause();
      } else if (msg.t === T.TUNNEL_CLOSE) {
        shutdown(open && (!msg.reason || msg.reason === 'closed')
          ? null : new Error(msg.reason || 'tunnel refused'));
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
