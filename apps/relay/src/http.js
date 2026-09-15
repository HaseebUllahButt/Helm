import { timingSafeEqual } from 'node:crypto';
import { q, now, newId, newInviteCode } from './db.js';
import {
  loadNetwork, saveNetwork, roster, mergeRoster, issueDevice, revoke,
  authenticate, allEndpoints, localKey,
} from '@helm/protocol/network';
import { ROLE } from '@helm/protocol/identity';

/** Compare two secrets without leaking where they first differ. */
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

const INVITE_TTL_MS = 10 * 60 * 1000;

/**
 * How long a login password stays usable.
 *
 * Short on purpose. The password only has to survive the walk from the
 * terminal that printed it to the phone that types it; after that the device
 * holds a durable token and never needs it again.
 */
export const PASSWORD_TTL_MS = Number(process.env.HELM_PASSWORD_TTL_MS || 10 * 60 * 1000);
const MIN_PASSWORD_TTL_MS = 60 * 1000;
const MAX_PASSWORD_TTL_MS = 15 * 60 * 1000;

const passwordTtl = (value) => {
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested <= 0) return PASSWORD_TTL_MS;
  return Math.min(MAX_PASSWORD_TTL_MS, Math.max(MIN_PASSWORD_TTL_MS, requested));
};

export const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' https: wss: http: ws:",
    "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

/**
 * Open a fresh login window.
 *
 * This used to revoke every device token as well, which was a mistake: the
 * hub rotates on every start, so restarting it - a reboot, a crash, a code
 * change - silently signed out every phone in the network. A password and a
 * paired device are different kinds of thing with different lifetimes, and
 * conflating them made the durable one as fragile as the temporary one.
 * Devices now leave only when you remove them.
 */
export function rotatePassword(password, ttl = PASSWORD_TTL_MS) {
  const value = password || newId(6);
  const expiresAt = now() + ttl;
  q.authSet.run(value, expiresAt, now());
  return { password: value, expiresAt };
}

function currentPassword() {
  const row = q.authGet.get();
  if (!row || row.expires_at < now()) return null;
  return row.password;
}

/**
 * Is this request from the machine itself?
 *
 * The socket's own address is the only thing worth trusting here - a header
 * saying "I am 127.0.0.1" is written by whoever sent it. `::ffff:127.0.0.1`
 * is the same address seen through a dual-stack socket.
 */
export function isLoopback(req) {
  const addr = req.socket?.remoteAddress;
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
    || addr.startsWith('127.');
};

const json = (res, code, body) => {
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    ...SECURITY_HEADERS,
  });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });

export const clientTokenFrom = (header) => {
  const m = /^Bearer\s+(.+)$/i.exec(header || '');
  return m ? m[1] : null;
};

/**
 * Identify a bearer.
 *
 * The roster is re-read per call rather than cached. It is a few hundred
 * bytes, requests are rare (the WebSocket carries the real traffic), and it
 * means a revocation from the CLI or another process takes effect on the very
 * next request instead of whenever this process happened to reload.
 */
export function identify(token) {
  const net = loadNetwork();
  if (!net) return null;
  const claims = authenticate(net, token);
  return claims ? { net, claims } : null;
}

/** Machines, with their live-connection state and cached description. */
export function listMachines(online) {
  const net = loadNetwork();
  if (!net) return [];
  return Object.values(net.machines).map((m) => {
    const cached = q.stateGet.get(m.id);
    return {
      id: m.id,
      name: m.name,
      self: m.id === net.self,
      online: online.has(m.id),
      lastSeen: cached?.last_seen ?? null,
      info: JSON.parse(cached?.info || '{}'),
      endpoints: m.endpoints ?? [],
      createdAt: m.addedAt,
    };
  });
}

export function makeHttpHandler({ online, kick }) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (req.method === 'OPTIONS') return json(res, 204, {});

    // -------------------------------------------------- unauthenticated routes

    if (path === '/api/health') {
      const net = loadNetwork();
      return json(res, 200, { ok: true, network: net?.id ?? null });
    }

    // The local key, for a page this machine itself is serving. `helm open`
    // used to be the only way it reached a browser; this makes opening
    // 127.0.0.1:8787 sign itself in with nothing to type.
    //
    // Held to the claim actually being made: the request must arrive over
    // loopback, be addressed to a loopback name, and not be a cross-site
    // fetch - Caddy on a public machine forwards internet requests that look
    // local to the socket but carry its public host, and a browser blocks a
    // foreign site from reading a response with no CORS headers anyway.
    if (path === '/api/auth/local' && req.method === 'POST') {
      const localHost = /^(127\.|localhost|\[::1\])/.test(String(req.headers.host));
      const sameSite = req.headers['sec-fetch-site'] !== 'cross-site';
      if (!isLoopback(req) || !localHost || !sameSite) {
        res.writeHead(403, { 'content-type': 'application/json', ...SECURITY_HEADERS });
        return res.end(JSON.stringify({ error: 'only a page served by this machine may do that' }));
      }
      res.writeHead(200, {
        'content-type': 'application/json', 'cache-control': 'no-store', ...SECURITY_HEADERS,
      });
      return res.end(JSON.stringify({ local: localKey() }));
    }

    // Exchange the short-lived password for a durable device token. The token
    // is signed with the network key, so every machine in the network will
    // accept it - including ones that have never heard of this device.
    if (path === '/api/auth/login' && req.method === 'POST') {
      const net = loadNetwork();
      if (!net) return json(res, 503, { error: 'this machine is not in a network yet' });

      const body = await readBody(req).catch(() => ({}));

      // A browser on the machine itself signs in with the local key instead of
      // a pairing password: anyone who can read that file can already read the
      // network key sitting beside it, so there is nothing left to protect by
      // sending them to another device for a link.
      //
      // Both halves are required. Loopback alone would be wrong - Caddy
      // terminates HTTPS and proxies to this hub over loopback, so a request
      // from the internet also arrives from 127.0.0.1 - and the key alone
      // would travel further than this machine.
      if (body.local && isLoopback(req) && safeEqual(body.local, localKey())) {
        const { id, token } = issueDevice(net, body.label || 'this machine');
        return json(res, 200, {
          token, deviceId: id, network: net.id, endpoints: allEndpoints(net), local: true,
        });
      }

      const expected = currentPassword();
      if (!expected) {
        return json(res, 403, {
          error: 'the pairing link has expired - run `helm add controller` for a new one',
        });
      }
      if (body.password !== expected) return json(res, 401, { error: 'bad password' });

      const { id, token } = issueDevice(net, body.label || 'web');
      return json(res, 200, {
        token, deviceId: id, network: net.id, endpoints: allEndpoints(net),
      });
    }

    // Claim an invite. This hands over the network key, which is why invites
    // are single-use, short-lived, and only exist because someone with access
    // asked for one moments ago.
    if (path === '/api/join' && req.method === 'POST') {
      const net = loadNetwork();
      if (!net) return json(res, 503, { error: 'this machine is not in a network yet' });

      const body = await readBody(req).catch(() => ({}));
      const code = String(body.code || '').trim().toUpperCase();
      q.inviteSweep.run(now());
      const row = q.inviteGet.get(code);
      if (!row) return json(res, 404, { error: 'unknown or expired invite' });
      if (row.used_by) return json(res, 409, { error: 'invite already used' });
      if (row.expires_at < now()) return json(res, 410, { error: 'invite expired' });

      q.inviteUse.run(String(body.name || 'machine').slice(0, 64), code);
      // `role` travels back so the joining machine knows what it was invited
      // as, and can set itself up as a home without being told again.
      return json(res, 200, {
        id: net.id, key: net.key, self: net.self, ...roster(net),
        endpoints: allEndpoints(net), role: row.role ?? 'pc',
      });
    }

    // ---------------------------------------------------- authenticated routes

    const who = identify(clientTokenFrom(req.headers.authorization));
    if (!who) return json(res, 401, { error: 'unauthorized' });
    const { net, claims } = who;

    if (path === '/api/network' && req.method === 'GET') {
      return json(res, 200, {
        id: net.id,
        self: net.self,
        you: claims.sub,
        machines: listMachines(online),
        devices: Object.values(net.devices),
        endpoints: allEndpoints(net),
      });
    }

    // Gossip. A peer posts its roster and gets ours back, so one exchange
    // reconciles both directions.
    if (path === '/api/roster' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      mergeRoster(net, body);
      return json(res, 200, roster(loadNetwork()));
    }

    if (path === '/api/auth/rotate' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      return json(res, 200, rotatePassword(null, passwordTtl(body.ttlMs)));
    }

    if (path === '/api/invite' && req.method === 'POST') {
      q.inviteSweep.run(now());
      const body = await readBody(req).catch(() => ({}));
      const role = body.role === 'vm' ? 'vm' : 'pc';
      const code = newInviteCode();
      const expiresAt = now() + INVITE_TTL_MS;
      q.inviteInsert.run(code, expiresAt, role);
      return json(res, 200, { code, expiresAt, role, endpoints: allEndpoints(net) });
    }

    if (path === '/api/machines' && req.method === 'GET') {
      return json(res, 200, { machines: listMachines(online) });
    }

    if (path === '/api/devices' && req.method === 'GET') {
      return json(res, 200, {
        devices: Object.values(net.devices).map((d) => ({ ...d, self: d.id === claims.sub })),
      });
    }

    // Removing a member is the one and only way something leaves the network.
    const memberMatch = /^\/api\/(machines|devices)\/([a-f0-9]+)$/.exec(path);
    if (memberMatch && req.method === 'DELETE') {
      const [, kind, id] = memberMatch;
      const bucket = kind === 'machines' ? net.machines : net.devices;
      if (!bucket[id]) return json(res, 404, { error: `no such ${kind.slice(0, -1)}` });
      if (id === net.self) {
        return json(res, 409, {
          error: 'a machine cannot remove itself - do it from another machine, or run `helm leave` here',
        });
      }
      revoke(net, id);
      // Close what they have open, not just what they open next: a machine's
      // daemon socket, and every client socket a removed device holds.
      if (kick) kick(id);
      else online.get(id)?.close(4004, 'removed from the network');
      return json(res, 200, { ok: true, removed: id });
    }

    if (path === '/api/digests' && req.method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 500);
      const env = url.searchParams.get('env');
      return json(res, 200, {
        digests: env ? q.digestByEnv.all(env, limit) : q.digestRecent.all(limit),
      });
    }

    return json(res, 404, { error: 'not found' });
  };
}

export { ROLE };
