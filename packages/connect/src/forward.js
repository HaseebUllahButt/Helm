import { createServer } from 'node:net';
import { hubCredential, allEndpoints } from '@helm/protocol/network';
import { bridge } from './proxy.js';

/**
 * `helm forward <machine> <port>`: another machine's localhost, here.
 *
 * Listens on 127.0.0.1 and carries each connection to <machine>'s own
 * 127.0.0.1:<port> over a hub, the same tunnel `helm ssh` rides. Nothing new
 * is opened to the world: the far machine still accepts tunnels only to the
 * ports it shared (`#allowedTunnelPorts` in agent.js), and only a member's
 * credential can ask a hub for one. No browser sign-in either - the browser
 * talks to localhost.
 */

/** Hubs to try: this machine's own first, then every address the roster knows. */
export const forwardHubs = (net) => [...new Set([`http://127.0.0.1:${net.port ?? 8787}`, ...allEndpoints(net)])];

/**
 * Listen on `localPort` (or the first free port from it, unless `exact`).
 * Resolves to { server, port, close }.
 */
export async function startForward(net, {
  target, port, localPort = port, exact = false, hubs = forwardHubs(net),
  open = bridge, credential = hubCredential, onRefused = () => {}, onError = () => {},
} = {}) {
  // The hub that worked last goes first; most connections are a page's
  // files, all to the same place.
  let preferred = null;
  const sockets = new Set();

  async function carry(sock) {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    // Bytes the browser sends before the tunnel is up wait in the socket:
    // nothing reads it until the bridge does.
    sock.pause();
    sock.on('error', () => {});
    const order = preferred ? [preferred, ...hubs.filter((h) => h !== preferred)] : hubs;
    const failures = [];
    for (const hub of order) {
      for (const path of ['/helm/ws', '/ws']) {
        try {
          const token = await credential(net, hub);
          if (sock.destroyed) return;
          await open(hub, token, target, port, { path, input: sock, output: sock });
          preferred = hub;
          sock.end();
          return;
        } catch (err) {
          // Once bytes have flowed the connection cannot be replayed elsewhere.
          if (err.established) { preferred = hub; sock.destroy(); return; }
          // The far machine said no: no other hub will change its mind.
          if (/port not allowed/.test(err.message)) { onRefused(err); sock.destroy(); return; }
          failures.push(`${hub}: ${err.message}`);
          if (!err.legacyPath) break;
        }
      }
    }
    onError(new Error(`could not reach it through any hub\n  ${failures.join('\n  ')}`));
    sock.destroy();
  }

  const server = createServer((sock) => { carry(sock).catch(() => sock.destroy()); });
  const listen = (p) => new Promise((resolve, reject) => {
    const fail = (err) => { server.off('listening', ok); reject(err); };
    const ok = () => { server.off('error', fail); resolve(); };
    server.once('error', fail);
    server.once('listening', ok);
    server.listen(p, '127.0.0.1');
  });
  let chosen = Number(localPort);
  for (let tries = 0; ; tries++) {
    try { await listen(chosen); break; }
    catch (err) {
      if (err.code !== 'EADDRINUSE' || exact || tries >= 20 || chosen >= 65535) throw err;
      chosen += 1;
    }
  }
  return {
    server,
    port: server.address().port,
    close: () => new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}
