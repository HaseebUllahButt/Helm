/**
 * Publishing each machine's T3 Code server.
 *
 * A request arriving at the hub carries a Host header. On the home VM that
 * host is the public name Caddy fronts, and the port says which machine:
 *
 *   https://130-210-33-163.sslip.io           this machine's own T3
 *   https://130-210-33-163.sslip.io:44301     the machine holding port 44301
 *
 * Ports are handed out from the roster in join order, so every machine
 * agrees on them without talking. The request is proxied to that machine's
 * loopback T3 port: directly for this machine, through a tunnel over the
 * machine's own link for any other. WebSocket upgrades ride the same way,
 * as raw bytes. T3's own authentication is the only gate; the hub adds none
 * and removes none.
 */
import http from 'node:http';
import { connect as tcpConnect } from 'node:net';
import { loadNetwork, publishedPorts, homeHosts } from '@helm/protocol/network';
import { TunnelSocket } from './tunnel-socket.js';

const MAX_TUNNELS = 256;
const MAX_PER_MACHINE = 64;

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

function splitHost(header) {
  const raw = String(header || '').trim().toLowerCase();
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(raw);
  if (!m) return null;
  return { host: m[1], port: m[2] ? Number(m[2]) : null };
}

export function createPublish({ online, routeTunnel, hubPort = null }) {
  const live = new Map(); // envId -> count of open tunnels

  /**
   * Which machine does this Host header name?
   * @returns {{ kind:'self'|'machine', id, sock, port } | { kind:'unknown'|'offline'|'no-t3', id? } | null}
   *   null means "not a published host at all" - the hub's own business.
   */
  function resolve(hostHeader) {
    const parsed = splitHost(hostHeader);
    if (!parsed) return null;
    const net = loadNetwork();
    if (!net) return null;
    const homes = homeHosts(net);
    if (!homes.includes(parsed.host)) return null;

    let id;
    // Bare, https, or the hub's own port (a direct hit without Caddy): this machine.
    if (parsed.port === null || parsed.port === 443 || parsed.port === hubPort) id = net.self;
    else {
      for (const [mid, port] of publishedPorts(net)) if (port === parsed.port) { id = mid; break; }
      if (!id) return { kind: 'unknown' };
    }
    if (!net.machines[id]) return { kind: 'unknown' };
    const sock = online.get(id);
    if (!sock) return { kind: 'offline', id };
    const port = Number(sock.info?.t3?.port);
    if (!port) return { kind: 'no-t3', id };
    return { kind: id === net.self ? 'self' : 'machine', id, sock, port };
  }

  function connect(target) {
    if (target.kind === 'self') return tcpConnect({ host: '127.0.0.1', port: target.port });
    const total = [...live.values()].reduce((a, b) => a + b, 0);
    if (total >= MAX_TUNNELS || (live.get(target.id) ?? 0) >= MAX_PER_MACHINE) {
      throw Object.assign(new Error('too many open connections to that machine'), { code: 503 });
    }
    live.set(target.id, (live.get(target.id) ?? 0) + 1);
    const sock = new TunnelSocket({ env: target.id, port: target.port, routeTunnel });
    sock.once('close', () => live.set(target.id, Math.max(0, (live.get(target.id) ?? 1) - 1)));
    return sock;
  }

  function explain(res, target) {
    if (target.kind === 'unknown') return json(res, 404, { error: 'no machine is published at this address' });
    if (target.kind === 'offline') return json(res, 502, { error: 'that machine is offline' });
    if (target.kind === 'no-t3') return json(res, 503, { error: 'T3 Code is not running on that machine yet' });
    return json(res, 500, { error: 'cannot route' });
  }

  const forwarded = (req) => ({
    'x-forwarded-proto': req.headers['x-forwarded-proto'] ?? 'https',
    'x-forwarded-host': req.headers['x-forwarded-host'] ?? req.headers.host ?? '',
    'x-forwarded-for': [req.headers['x-forwarded-for'], req.socket?.remoteAddress]
      .filter(Boolean).join(', '),
  });

  /** Proxy an ordinary request. Returns false when the host is not published. */
  function handleRequest(req, res) {
    const target = resolve(req.headers.host);
    if (target === null) return false;
    if (!target.sock) { explain(res, target); return true; }

    let conn;
    try { conn = connect(target); }
    catch (err) { json(res, err.code || 502, { error: err.message }); return true; }

    // No agent: with one, Node ignores createConnection and dials the host.
    const up = http.request({
      createConnection: () => conn,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, connection: 'close', ...forwarded(req) },
    });
    up.on('response', (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', (err) => {
      if (!res.headersSent) json(res, 502, { error: `could not reach that machine's T3: ${err.message}` });
      else res.destroy();
    });
    res.on('close', () => up.destroy());
    req.pipe(up);
    return true;
  }

  /** Proxy a WebSocket upgrade as raw bytes. Returns false when not published. */
  function handleUpgrade(req, socket, head) {
    const target = resolve(req.headers.host);
    if (target === null) return false;
    const refuse = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (!target.sock) { refuse(target.kind === 'unknown' ? 404 : 502, 'Bad Gateway'); return true; }

    let conn;
    try { conn = connect(target); }
    catch { refuse(503, 'Service Unavailable'); return true; }

    const start = () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      const extra = forwarded(req);
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        if (name.toLowerCase() in extra) continue;
        lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
      }
      for (const [k, v] of Object.entries(extra)) if (v) lines.push(`${k}: ${v}`);
      conn.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) conn.write(head);
      socket.pipe(conn).pipe(socket);
    };
    const fail = () => { if (!socket.destroyed) refuse(502, 'Bad Gateway'); conn.destroy(); };

    if (target.kind === 'self') conn.once('connect', start);
    else conn.once('connect', start);
    conn.once('error', fail);
    conn.once('close', () => socket.destroy());
    socket.once('close', () => conn.destroy());
    socket.once('error', () => conn.destroy());
    return true;
  }

  return { resolve, handleRequest, handleUpgrade };
}
