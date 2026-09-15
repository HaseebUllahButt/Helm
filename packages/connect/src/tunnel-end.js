import { connect as tcpConnect } from 'node:net';
import { T } from '@helm/protocol';

/**
 * The far end of a tunnel: a TCP connection to a port on this machine's
 * loopback interface. This is how ssh and the hub's T3 proxy reach a box
 * behind NAT - the daemon already holds the outbound link, so nothing has
 * to accept an inbound connection.
 *
 * Only ports this machine chose to expose are allowed. A hub is trusted to
 * carry bytes, not to pick which local services it may reach.
 */
export function createTunnelEnd({ allowPorts }) {
  const tunnels = new Map();
  const key = (link, sid) => `${link.id} ${sid}`;

  function open(link, { sid, port }) {
    const wanted = Number(port) || 22;
    if (!allowPorts().includes(wanted)) {
      return link.send(T.TUNNEL_CLOSE, { sid, reason: 'port not allowed' });
    }
    const k = key(link, sid);
    const sock = tcpConnect({ host: '127.0.0.1', port: wanted });
    tunnels.set(k, sock);

    sock.on('connect', () => link.send(T.TUNNEL_READY, { sid }));
    sock.on('data', (chunk) => link.send(T.TUNNEL_DATA, { sid, data: chunk.toString('base64') }));
    const end = (reason) => {
      if (!tunnels.delete(k)) return;
      link.send(T.TUNNEL_CLOSE, { sid, reason });
      sock.destroy();
    };
    sock.on('error', (err) => end(err.message));
    sock.on('close', () => end('closed'));
  }

  function data(link, { sid, data: b64 }) {
    tunnels.get(key(link, sid))?.write(Buffer.from(b64, 'base64'));
  }

  function close(link, { sid }) {
    const k = key(link, sid);
    tunnels.get(k)?.destroy();
    tunnels.delete(k);
  }

  /** Handle one frame if it is a tunnel frame; returns whether it was. */
  function onFrame(link, msg) {
    if (msg.t === T.TUNNEL_OPEN) { open(link, msg); return true; }
    if (msg.t === T.TUNNEL_DATA) { data(link, msg); return true; }
    if (msg.t === T.TUNNEL_CLOSE) { close(link, msg); return true; }
    return false;
  }

  return { onFrame, get size() { return tunnels.size; } };
}
