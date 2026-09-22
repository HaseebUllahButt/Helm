import http from 'node:http';
import { loadNetwork } from '@helm/protocol/network';

/**
 * The /media/<machine>/... route every hub answers.
 *
 * Browsers cannot stream media over the JSON socket - a <video> element
 * speaks HTTP, sends Range headers, and can carry no Authorization header -
 * so media gets a real HTTP surface of its own. Its gate is the media
 * credential: a signed ticket in the URL minted by the target nas for one
 * caller, or the usual member bearer.
 *
 * Two ways the bytes get here:
 *
 * - The machine is this one: the hub answers straight from the shared
 *   folders through @helm/nas's handler. This is the fast path a phone on
 *   the same wifi takes.
 * - The machine is elsewhere: the hub asks that machine (over the socket
 *   its daemon already holds) which port its media listens on, opens a
 *   tunnel to it, and relays one HTTP request through. This is the path a
 *   phone on the other side of NAT takes, and it is why the daemon's
 *   listener only ever binds loopback - reachability is the tunnel's job.
 *
 * The nas module is loaded on first use: a network that never designates
 * one never pays for it.
 */
const ROUTE = /^\/media\/([0-9a-f]{6,32})(\/(?:roots|list|stream))?$/;

let nasModule;
const nas = () => (nasModule ??= import('@helm/nas'));

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

// What the client sent that the upstream media handler still needs.
const FORWARD = [
  'authorization', 'range', 'if-range', 'if-none-match', 'if-modified-since', 'accept',
];
// What must not survive a proxy hop, per the HTTP spec.
const HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'te', 'trailer', 'proxy-authorization', 'proxy-authenticate',
]);

/**
 * Replay one request on the tunnelled socket and relay the answer. The
 * upstream server speaks plain HTTP because it is the same media handler -
 * the tunnel only changes what carries it.
 */
function proxy(req, res, socket, path) {
  const headers = {};
  for (const h of FORWARD) if (req.headers[h]) headers[h] = req.headers[h];
  // A tunnel stream is one request's socket, never a pool entry: a fresh
  // agent per request, keep-alive off, and the stream dies with the answer.
  const agent = new http.Agent({ keepAlive: false });
  agent.createConnection = () => socket;
  const up = http.request({ method: req.method, path, headers, agent });
  up.on('response', (ur) => {
    const out = {};
    for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k)) out[k] = v;
    res.writeHead(ur.statusCode, out);
    ur.pipe(res);
  });
  // A media element abandons connections constantly - every seek drops the
  // last one. Dropping our end must drop the tunnel too, or the daemon's
  // side reads forever.
  res.on('close', () => up.destroy());
  up.on('error', () => {
    if (res.headersSent) res.destroy();
    else json(res, 502, { error: 'the nas did not answer' });
  });
  up.end();
}

export function createMediaRoute({ online, callEnv, openTcp }) {
  let local; // the self handler, built on first use

  return async function mediaRoute(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const url = new URL(req.url, 'http://localhost');
    const m = ROUTE.exec(url.pathname);
    if (!m) return false;
    const [, env, verb = '/roots'] = m;
    const tail = `/media${verb}${url.search}`;

    const net = loadNetwork();
    if (!net) { json(res, 503, { error: 'this machine is not in a network' }); return true; }

    const { mediaAuthorize, mediaHandler } = await nas();
    if (!(await mediaAuthorize({ self: env })(req))) {
      json(res, 401, { error: 'unauthorized' });
      return true;
    }

    if (env === net.self) {
      const kind = net.machines[net.self]?.kind ?? net.role;
      if (kind !== 'nas') { json(res, 404, { error: 'this machine is not a nas' }); return true; }
      local ??= mediaHandler({ authorize: mediaAuthorize({ self: env }) });
      req.url = tail;
      await local(req, res);
      return true;
    }

    if (!online.has(env)) {
      json(res, 404, { error: 'that machine is not connected here' });
      return true;
    }
    let port;
    try {
      ({ port } = await callEnv(env, 'media.info'));
    } catch (err) {
      // An older daemon, or one that is not a nas: both answer the same.
      json(res, 404, { error: err?.message || 'that machine is not serving media' });
      return true;
    }
    if (!port) { json(res, 404, { error: 'that machine is not serving media' }); return true; }

    try {
      proxy(req, res, await openTcp(env, port), tail);
    } catch (err) {
      json(res, 502, { error: `the nas is unreachable: ${err?.message || err}` });
    }
    return true;
  };
}
