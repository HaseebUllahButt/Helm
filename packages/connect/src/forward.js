import { createServer } from 'node:net';
import { hubCredential, allEndpoints } from '@helm/protocol/network';
import { bridge } from './proxy.js';

/**
 * A forward: another machine's localhost port, on this machine's localhost.
 *
 * Listens on 127.0.0.1 and carries each connection to <machine>'s own
 * 127.0.0.1:<port> over a hub, the same tunnel `helm ssh` rides. Nothing new
 * is opened to the world: the far machine still accepts tunnels only to the
 * ports it shared or forwards (`#allowedTunnelPorts` in agent.js), and only
 * a member's credential can ask a hub for one. No browser sign-in either -
 * the browser talks to localhost.
 *
 * Each connection opens its own tunnel, so a restarted app or a network
 * that came back works on the next page load. When a connection cannot be
 * carried, a browser gets a 502 page that says which machine, which port
 * and why, never an empty answer.
 */

/** Hubs to try: this machine's own first, then every address the roster knows. */
export const forwardHubs = (net) => [...new Set([`http://127.0.0.1:${net.port ?? 8787}`, ...allEndpoints(net)])];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Why a connection could not be carried, in the words the page uses. */
export function forwardFailure(kind, { machine, port }) {
  if (kind === 'app') return `Nothing runs on port ${port} on ${machine}. Start the app there.`;
  if (kind === 'refused') return `${machine} does not open port ${port} for this machine now. Start the forward again.`;
  return `Helm cannot reach ${machine} now. ${machine} can be off, asleep or offline, or the network is down.`;
}

function failurePage(kind, where) {
  const text = forwardFailure(kind, where);
  const body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(where.machine)} port ${where.port} - not reachable</title><style>
:root{color-scheme:light dark}body{margin:0;min-height:100dvh;display:grid;place-items:center;font:15px/1.5 system-ui,sans-serif;padding:20px}
.c{max-width:420px}h1{font-size:19px;margin:0 0 8px}p{margin:0 0 12px;opacity:.75}
</style><div class="c"><h1>${esc(where.machine)}, port ${where.port}: not reachable</h1><p>${esc(text)}</p>
<p>This page tries again in 3 seconds.</p><p>Forwarded by Helm</p></div></html>`;
  return `HTTP/1.1 502 Bad Gateway\r\ncontent-type: text/html; charset=utf-8\r\ncache-control: no-store\r\nrefresh: 3\r\n`
    + `x-helm-forward: ${kind}\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`;
}

const HTTP_REQUEST = /^[A-Z]{3,10} \S+ HTTP\/1\.[01]\r?\n/;

/**
 * Answer a connection that could not be carried. A browser (an HTTP request
 * is waiting in the socket) gets the page; anything else is closed.
 */
function answerFailure(sock, kind, where) {
  if (sock.destroyed) return;
  let first = sock.read();
  let timer = null;
  const done = () => {
    clearTimeout(timer);
    sock.off('readable', more);
    sock.off('close', done);
    const head = first ? first.subarray(0, 2048).toString('latin1') : '';
    if (HTTP_REQUEST.test(head)) sock.end(failurePage(kind, where), () => sock.destroy());
    else sock.destroy();
  };
  const more = () => {
    const chunk = sock.read();
    if (chunk) first = first ? Buffer.concat([first, chunk]) : chunk;
    if (first && (first.includes('\n') || first.length >= 2048)) done();
  };
  if (first && first.includes('\n')) return done();
  // Nothing sent yet: a browser always speaks first, and fast.
  timer = setTimeout(done, 1500);
  sock.on('readable', more);
  sock.once('close', done);
}

/** Sort a tunnel failure: the app, a refusal, or the way there. */
function kindOf(err) {
  if (/port not allowed/.test(err.message)) return 'refused';
  if (err.far && /Nothing answered|ECONNREFUSED|EADDRNOTAVAIL|ECONNRESET|connect/i.test(err.message)
    && !/offline|not connected|peer disconnected/i.test(err.message)) return 'app';
  return 'unreachable';
}

/**
 * Listen on `localPort` (or the first free port from it, unless `exact`).
 * `machine` names the far machine on the 502 page.
 * Resolves to { server, port, close }.
 */
export async function startForward(net, {
  target, port, localPort = port, exact = false, hubs = forwardHubs(net), machine = target,
  open = bridge, credential = hubCredential, onRefused = () => {}, onError = () => {},
} = {}) {
  // The hub that worked last goes first; most connections are a page's
  // files, all to the same place.
  let preferred = null;
  const sockets = new Set();
  const where = { machine, port };
  const hubList = () => (typeof hubs === 'function' ? hubs() : hubs);

  async function carry(sock) {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    // Bytes the browser sends before the tunnel is up wait in the socket:
    // nothing reads it until the bridge does.
    sock.pause();
    sock.on('error', () => {});
    const list = hubList();
    const order = preferred ? [preferred, ...list.filter((h) => h !== preferred)] : list;
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
          if (sock.destroyed) return;
          const kind = kindOf(err);
          // The far machine answered: no other hub will change its answer.
          if (kind === 'refused') { onRefused(err); answerFailure(sock, kind, where); return; }
          if (kind === 'app') { preferred = hub; answerFailure(sock, kind, where); return; }
          failures.push(`${hub}: ${err.message}`);
          if (!err.legacyPath) break;
        }
      }
    }
    onError(new Error(`could not reach it through any hub\n  ${failures.join('\n  ')}`));
    answerFailure(sock, 'unreachable', where);
  }

  const server = createServer((sock) => {
    carry(sock).catch(() => answerFailure(sock, 'unreachable', where));
  });
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
