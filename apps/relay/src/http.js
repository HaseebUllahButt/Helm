import { timingSafeEqual } from 'node:crypto';
import { q, now, newId, newInviteCode } from './db.js';
import {
  loadNetwork, saveNetwork, roster, mergeRoster, issueDevice, revoke,
  authenticate, allEndpoints, localKey, deviceToken,
} from '@helm/protocol/network';
import { ROLE } from '@helm/protocol/identity';

/** Compare two secrets without leaking where they first differ. */
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

const INVITE_TTL_MS = 10 * 60 * 1000;

/** Wrong passwords a login window survives before it is burned. */
const MAX_PASSWORD_ATTEMPTS = 10;

/**
 * Invite guesses allowed across all callers, per minute.
 *
 * An invite code is 40 bits, so this is not what makes guessing one hopeless;
 * it is what stops a hub spending its life answering someone who is trying
 * anyway. Global rather than per-address on purpose: behind Caddy every
 * request shares one remote address, so a per-address bucket is a global one
 * that only looks careful.
 */
const MAX_JOIN_ATTEMPTS = 30;
const JOIN_WINDOW_MS = 60 * 1000;
let joinAttempts = [];

const joinAllowed = () => {
  const cutoff = now() - JOIN_WINDOW_MS;
  joinAttempts = joinAttempts.filter((t) => t > cutoff);
  if (joinAttempts.length >= MAX_JOIN_ATTEMPTS) return false;
  joinAttempts.push(now());
  return true;
};

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
    // blob: is not optional: the composer decodes a picked photo locally
    // before sending it, and without this every attachment failed with "the
    // browser could not decode it" - the CSP, not the file.
    "img-src 'self' data: blob:",
    "connect-src 'self' https: wss: http: ws:",
    "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  // The composer's dictation mic needs getUserMedia, which an empty
  // microphone policy would forbid even to this page itself - (self) keeps
  // it for the app and denies it to anything it embeds.
  'permissions-policy': 'camera=(), microphone=(self), geolocation=()',
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

/**
 * Which cross-origin pages may read an answer from this hub.
 *
 * Something is needed here: a device paired at the VM keeps the VM's origin
 * while probing every other hub in the network, and those are cross-origin
 * requests that have to work. `*` was too much, though - it let every page the
 * owner happens to visit reach this hub, on loopback and across the LAN, and
 * read what came back.
 *
 * So the origin is reflected only when it is somewhere this network actually
 * lives: loopback, or an address the roster advertises. Deliberately *not*
 * "whatever host this request was addressed to" - that sounds equivalent and
 * is not, because in a DNS rebinding attack the browser puts the attacker's
 * own name in both headers, and a hub comparing them to each other would
 * agree with itself and let the page straight in.
 *
 * Nothing legitimate needs the looser rule: the app only ever learns an
 * address from the roster, and a page talking to the hub that served it is
 * same-origin, which asks no permission of anybody. A request with no Origin
 * at all - curl, the CLI, another daemon - needs no header and gets none;
 * CORS is a browser rule and nothing else has ever consulted it.
 */
function allowedOrigin(req, net) {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return null;

  let host;
  try { ({ host } = new URL(origin)); } catch { return null; }
  if (!host) return null;

  if (/^(127\.\d+\.\d+\.\d+|\[::1\]|localhost)(:\d+)?$/.test(host)) return origin;

  for (const endpoint of net ? allEndpoints(net) : []) {
    try { if (new URL(endpoint).host === host) return origin; } catch { /* not a URL */ }
  }
  return null;
}

const reply = (res, code, body, origin = null) => {
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    // Origin decides the body's audience, so it decides the cached copy too.
    vary: 'Origin',
    ...(origin ? {
      'access-control-allow-origin': origin,
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    } : {}),
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
      // What the machine is for; absent on records from before kinds existed.
      kind: m.kind ?? null,
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

    // Worked out once and bound into every answer below, so no route can
    // forget it and quietly go back to answering everyone.
    const origin = allowedOrigin(req, loadNetwork());
    const json = (r, code, body) => reply(r, code, body, origin);

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
        // One credential for this machine's own browsers, not one per page
        // load. Every fresh profile, every cleared site-data and every token
        // this hub cut used to leave another permanent device in a roster that
        // gossips to the whole network, and no way to tell which was live.
        //
        // Re-issuing is safe precisely here: the caller proved it holds the
        // local key, and anyone who can read that can read the network key
        // beside it, so this hands back nothing they could not mint. If the
        // remembered device has since been removed, `deviceToken` says so and
        // a new one is issued - which is what makes pruning stick rather than
        // locking the owner out of their own machine.
        const remembered = q.localDeviceGet.get()?.device_id;
        const existing = remembered ? deviceToken(net, remembered) : null;
        const { id, token } = existing
          ? { id: remembered, token: existing }
          : issueDevice(net, body.label || 'this machine');
        if (!existing) q.localDeviceSet.run(id);
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
      // Constant-time, like every other secret comparison here: the password
      // is short-lived but it is still the thing standing between a stranger
      // and a durable token.
      if (!safeEqual(body.password ?? '', expected)) {
        // A window that has been guessed at this many times is being attacked,
        // not mistyped. Burning it costs the owner one `helm add controller`
        // and costs an attacker the whole attempt - and unlike a per-address
        // limit it still works behind Caddy, where every request on earth
        // arrives from 127.0.0.1 and would share one bucket.
        const failures = (q.authGet.get()?.failures ?? 0) + 1;
        q.authFail.run(failures);
        if (failures >= MAX_PASSWORD_ATTEMPTS) {
          q.authExpire.run();
          return json(res, 403, {
            error: 'too many wrong passwords - that link is dead; run `helm add controller` for a new one',
          });
        }
        return json(res, 401, { error: 'bad password' });
      }

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

      if (!joinAllowed()) {
        return json(res, 429, { error: 'too many join attempts - wait a minute' });
      }

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
    //
    // Machines only. Replication is something daemons do to each other; a
    // phone has never had a reason to post a roster, and letting it meant the
    // weakest credential in the network could write the SSH keys every machine
    // trusts and the addresses every device dials next. Reading the roster is
    // a different question, and stays open to anyone in the network via
    // `/api/network`.
    if (path === '/api/roster' && req.method === 'POST') {
      if (claims.role !== ROLE.MACHINE) {
        return json(res, 403, { error: 'only a machine can gossip the roster' });
      }
      const body = await readBody(req).catch(() => ({}));
      mergeRoster(net, body);
      return json(res, 200, roster(loadNetwork()));
    }

    // ---- push: where to reach this device when the app is not open.
    //
    // The VAPID public key is not a secret - it is what the browser checks
    // the signature against, and it has to be handed out before anything can
    // subscribe.
    if (path === '/api/push/key' && req.method === 'GET') {
      const { keys } = await import('@helm/protocol/push');
      return json(res, 200, { key: keys().publicKey });
    }

    if (path === '/api/push/subscribe' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const endpoint = String(body.endpoint ?? '');
      const p256dh = String(body.keys?.p256dh ?? '');
      const auth = String(body.keys?.auth ?? '');
      // An endpoint is a URL this machine will POST to. Only accept the
      // https ones the push services actually use; anything else would make
      // the hub a willing sender of requests chosen by whoever asked.
      if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) {
        return json(res, 400, { error: 'that is not a push subscription' });
      }
      q.pushSet.run(endpoint, claims.sub, p256dh, auth, String(body.label ?? '').slice(0, 60), now());
      return json(res, 200, { ok: true });
    }

    if (path === '/api/push/unsubscribe' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      if (body.endpoint) q.pushDelete.run(String(body.endpoint));
      else for (const row of q.pushForDevice.all(claims.sub)) q.pushDelete.run(row.endpoint);
      return json(res, 200, { ok: true });
    }

    if (path === '/api/push/status' && req.method === 'GET') {
      return json(res, 200, { subscribed: q.pushForDevice.all(claims.sub).length > 0 });
    }

    if (path === '/api/auth/rotate' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      return json(res, 200, rotatePassword(null, passwordTtl(body.ttlMs)));
    }

    if (path === '/api/invite' && req.method === 'POST') {
      q.inviteSweep.run(now());
      const body = await readBody(req).catch(() => ({}));
      // The kind the inviter says the machine will be. Anything outside the
      // set quietly becomes 'pc', the kind with no extra duties - an invite
      // must never mint something the network does not have a meaning for.
      const role = ['vm', 'nas'].includes(body.role) ? body.role : 'pc';
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
