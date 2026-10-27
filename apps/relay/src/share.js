import http from 'node:http';
import { loadNetwork } from '@helm/protocol/network';
import {
  checkSharePassword, shareCookie, checkShareCookie, publicHosts,
  checkShareGrant, memberCookie, checkMemberCookie, safeSharePath, MEMBER_TTL_MS, GRANT_TTL_MS,
} from '@helm/protocol/share';

/**
 * https://<name>.<this hub's host> - a public link to a port on one of the
 * network's machines, helm's own ngrok.
 *
 * The hub does not keep a list. When a link is opened it asks the machines
 * attached here what they share (`share.list`, a few seconds' cache), and
 * carries the request over a tunnel on the socket that machine already
 * holds. The machine only accepts tunnels to ports it shared, so a hub
 * cannot be talked into reaching anything else.
 *
 * A share with a password gets a small sign-in page first; the cookie that
 * page sets is checked here and never reaches the shared app.
 *
 * A private share opens only for the network's own devices. The link is a
 * different origin from the Helm app, so it cannot read the app's sign-in:
 * a visitor is sent to the app, which (signed in) gets a one-use grant from
 * a hub and posts it back to /.helm-share/enter here. That swaps it for a
 * cookie naming the member, re-checked against the roster on every request,
 * so removing a device closes its links at once.
 */

const COOKIE = '__Host-helm-share';
const MEMBER = '__Host-helm-member';
// Older hubs use this marker to skip their private landing page. Keep it
// during rolling updates, and never forward it to the shared app.
const SEEN = '__Host-helm-member-seen';
const OURS = [COOKIE, MEMBER, SEEN];
const COOKIE_DAYS = 30;
const CACHE_MS = 5000;
const MISS_MS = 2000;
// What must not survive a proxy hop, per the HTTP spec.
const HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade',
  'te', 'trailer', 'proxy-authorization', 'proxy-authenticate',
]);

// Set again by the hub itself, so a visitor cannot choose them.
const FORWARDED = new Set(['x-forwarded-proto', 'x-forwarded-for']);
// Headers that tell an app which host the visitor used. Only a share with
// --preserve-host lets the app see them.
const HOST_HEADERS = new Set([
  'x-forwarded-host', 'forwarded', 'x-original-host', 'x-host', 'x-forwarded-server', 'x-real-host',
]);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The few pages the hub itself shows on a link: a sign-in, or what is wrong. */
function page(res, status, title, body, extra = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', ...extra,
  });
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{color-scheme:light dark;--bg:#f5f5f3;--card:#fff;--text:#18181a;--dim:#6b6b70;--line:#e3e3e0;--acc:#18181a;--on:#fff;--bad:#c2410c}
@media(prefers-color-scheme:dark){:root{--bg:#111113;--card:#1a1a1d;--text:#ededed;--dim:#9a9aa1;--line:#2a2a2e;--acc:#ededed;--on:#111113;--bad:#fb923c}}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:20px}
.c{width:100%;max-width:360px;background:var(--card);border:1px solid var(--line);border-radius:18px;padding:28px 24px}
h1{font-size:19px;margin:0 0 6px;letter-spacing:-.01em}p{margin:0 0 18px;color:var(--dim)}
input{width:100%;font:inherit;padding:11px 13px;border-radius:11px;border:1px solid var(--line);background:transparent;color:inherit;margin-bottom:12px}
input:focus{outline:2px solid var(--acc);outline-offset:-1px}
button,a.b{display:block;width:100%;font:inherit;font-weight:600;padding:11px;border:0;border-radius:11px;background:var(--acc);color:var(--on);cursor:pointer;text-align:center;text-decoration:none}
.e{color:var(--bad);font-size:14px;margin:-4px 0 12px}.f{margin-top:18px;font-size:12px;color:var(--dim);text-align:center}
</style><div class="c">${body}<div class="f">Shared with Helm</div></div></html>`);
}

const signIn = (res, name, next, error = '', status = 401) => page(res, status, `${name} - password`, `
<h1>Enter the link password</h1><p>Ask the sender of <b>${esc(name)}</b> for the password.</p>
<form method="post" action="/.helm-share/unlock"><input type="hidden" name="next" value="${esc(next)}">
<input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password" aria-label="Password">
${error ? `<div class="e">${esc(error)}</div>` : ''}<button>Open</button></form>`);

function cookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** The Cookie header minus ours: the shared app has no business seeing them. */
function withoutOurCookie(header) {
  const kept = String(header || '').split(';').map((p) => p.trim())
    .filter((p) => p && !OURS.some((c) => p.startsWith(`${c}=`)));
  return kept.length ? kept.join('; ') : null;
}

function clientIp(req) {
  const address = req.socket.remoteAddress || '';
  // Only the local HTTPS proxy may report a visitor's address. Take its
  // last entry, never an entry a visitor put before it.
  if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) {
    return String(req.headers['x-forwarded-for'] || '').split(',').at(-1).trim() || address;
  }
  return address;
}

export function readForm(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let body = '', bytes = 0, finished = false;
    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', aborted);
    };
    const fail = (error) => {
      if (finished) return;
      finished = true; cleanup(); req.destroy(); reject(error);
    };
    const data = chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > limit) { fail(new Error('The request is too large.')); return; }
      body += chunk;
    };
    const end = () => { finished = true; cleanup(); resolve(new URLSearchParams(body)); };
    const aborted = () => fail(new Error('The request stopped.'));
    const timer = setTimeout(() => fail(new Error('The request took too long.')), 10_000);
    timer.unref?.();
    req.setEncoding('utf8');
    req.on('data', data); req.once('end', end); req.once('error', fail); req.once('aborted', aborted);
  });
}

export function createShareRoute({ online, callEnv, openTcp }) {
  let cache = { map: new Map() };
  const sources = new Map();
  let sequence = 0, nextDiscoveryAt = 0;
  let loading = null;
  const checking = new Map();
  const misses = new Map();
  const tries = new Map(); // ip|name -> { n, until }
  let sweepTriesAt = 0;

  function rebuild() {
    const map = new Map();
    for (const [env, source] of sources) for (const s of source.shares) {
      if (s.expiresAt != null && !(s.expiresAt > Date.now())) continue;
      const before = map.get(s.name);
      if (before) map.set(s.name, { ...before, conflict: true });
      else map.set(s.name, { ...s, env, checkedAt: source.at });
    }
    cache = { map };
  }

  async function readSource(env, apply = true) {
    const order = ++sequence, at = Date.now();
    let shares = [];
    try {
      const answer = await callEnv(env, 'share.list', { forHub: true, members: true }, { timeout: 4000 });
      if (Array.isArray(answer?.shares)) shares = answer.shares;
    } catch { /* no current access decision: refuse until the source answers */ }
    const source = { env, shares, at, order };
    if (apply) { acceptSource(source); rebuild(); }
    return source;
  }

  function acceptSource({ env, ...source }) {
    if ((sources.get(env)?.order ?? 0) < source.order) sources.set(env, source);
  }

  // Public unknown names share one discovery per second. A new link waits
  // for that discovery on its first visit instead of getting a false 404.
  const refresh = () => (loading ??= (async () => {
    const wait = nextDiscoveryAt - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    nextDiscoveryAt = Date.now() + 1000;
    for (const env of sources.keys()) if (!online.has(env)) sources.delete(env);
    const answers = await Promise.all([...online.keys()].map(env => readSource(env, false)));
    for (const answer of answers) acceptSource(answer);
    rebuild();
    for (const [name, at] of misses) if (cache.map.has(name) || Date.now() - at >= MISS_MS) misses.delete(name);
  })().finally(() => { loading = null; }));

  // Refresh a known link only at its source. A slow unrelated machine
  // must not delay this app's access check. Join simultaneous checks.
  function refreshSource(env) {
    if (checking.has(env)) return checking.get(env);
    const work = readSource(env).finally(() => checking.delete(env));
    checking.set(env, work);
    return work;
  }

  async function lookup(name) {
    const now = Date.now();
    if (now >= sweepTriesAt) {
      for (const [key, attempt] of tries) if (attempt.until <= now) tries.delete(key);
      sweepTriesAt = now + 60_000;
    }
    // A warm HTTP tunnel can outlive its share. Check expiry here too:
    // pooling means there may be no new port-open check on the machine.
    const known = cache.map.get(name);
    if (known?.expiresAt != null && !(known.expiresAt > Date.now())) cache.map.delete(name);
    // A warm tunnel can still reach a stopped or newly protected app.
    // Once this access decision expires, refresh it before serving bytes.
    if (cache.map.has(name)) {
      if (Date.now() - known.checkedAt > CACHE_MS) {
        if (known.conflict) await refresh();
        else {
          await refreshSource(known.env);
          void refresh().catch(() => {});
        }
      }
      return cache.map.get(name) ?? null;
    }
    // Check a new name on its first visit even if another link just warmed
    // the cache. Otherwise freshly created spins fail once with a 404.
    if (Date.now() - (misses.get(name) ?? 0) < MISS_MS) return null;
    await refresh();
    const share = cache.map.get(name) ?? null;
    if (!share && misses.size < 1024) misses.set(name, Date.now());
    return share;
  }

  // One connection pool per shared port. Opening a tunnel is a round trip
  // to the machine; a page with thirty files paid it thirty times.
  const agents = new Map();
  const idleTimers = new WeakMap();
  const clearIdle = (stream) => {
    clearTimeout(idleTimers.get(stream));
    idleTimers.delete(stream);
  };
  function agentFor(share) {
    const key = `${share.env}:${share.port}`;
    let agent = agents.get(key);
    if (agent) return agent;
    agent = new http.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4, timeout: 30_000 });
    const retireEmpty = () => queueMicrotask(() => {
      // Let the HTTP agent finish its close/error bookkeeping first. Empty
      // pools must not retain every shared port ever opened by this hub.
      if ([agent.sockets, agent.freeSockets, agent.requests].some(slots => Object.values(slots).some(list => list.length))) return;
      if (agents.get(key) === agent) agents.delete(key);
      agent.destroy();
    });
    // openTcp's Duplex ignores setTimeout (media streams can idle). The
    // HTTP agent therefore cannot retire a pooled tunnel with its socket
    // timer. Close idle HTTP tunnels here, before the app's advertised
    // deadline, rather than borrow one while its remote close is in flight.
    agent.keepSocketAlive = (stream) => {
      if (!http.Agent.prototype.keepSocketAlive.call(agent, stream)) return false;
      clearIdle(stream);
      const hint = /^timeout=(\d+)/.exec(stream._httpMessage?.res?.headers['keep-alive'] || '')?.[1];
      const timeout = hint == null ? 30_000 : Math.min(30_000, Number(hint) * 1000 - 1000);
      if (timeout <= 0) return false;
      const timer = setTimeout(() => stream.destroy(), timeout);
      timer.unref();
      idleTimers.set(stream, timer);
      return true;
    };
    agent.reuseSocket = (stream, req) => {
      clearIdle(stream);
      http.Agent.prototype.reuseSocket.call(agent, stream, req);
    };
    agent.createConnection = (_options, done) => {
      openTcp(share.env, share.port).then((stream) => {
        // The machine closing its end must free the slot, or the pool would
        // hand the next request a tunnel nobody is reading.
        stream.once('end', () => stream.destroy());
        stream.once('close', () => { clearIdle(stream); retireEmpty(); });
        done(null, stream);
      }, (err) => { done(err); retireEmpty(); });
    };
    agents.set(key, agent);
    return agent;
  }

  /**
   * `{ name: 'mockups', base: '130-210-33-163.sslip.io' }` from
   * mockups.130-210-33-163.sslip.io, if that is one of ours.
   */
  function linkOf(req) {
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    const bases = [...publicHosts(loadNetwork()), ...(process.env.HELM_SHARE_DOMAIN ? [process.env.HELM_SHARE_DOMAIN] : [])];
    for (const base of bases) {
      if (!host.endsWith(`.${base}`)) continue;
      const label = host.slice(0, -base.length - 1);
      if (label && !label.includes('.')) return { name: label, base };
    }
    return null;
  }
  const nameFor = (req) => linkOf(req)?.name ?? null;

  /** Who may in: a password share wants its cookie, a private one a member's. */
  function unlocked(req, share, base) {
    if (share.private) {
      return !!checkMemberCookie(loadNetwork(), cookies(req.headers.cookie)[MEMBER], { name: share.name, host: base });
    }
    return !share.lock || checkShareCookie(cookies(req.headers.cookie)[COOKIE], share.name, share.lock);
  }

  /**
   * Where the Helm app is, to sign a visitor in: this hub's own https
   * address if the link is under it, else the first one the network has.
   * The fragment never reaches a server, so it stays out of every log.
   */
  function appHop(base, share, next) {
    const hosts = publicHosts(loadNetwork());
    const app = hosts.includes(base) ? base : hosts[0];
    if (!app) return null;
    const source = loadNetwork()?.machines?.[share.env]?.name || online.get(share.env)?.info?.name;
    const hash = new URLSearchParams({ share: share.name, host: base, next: safeSharePath(next), ...(source ? { source } : {}) });
    return `https://${app}/#${hash}`;
  }

  const privatePage = (res, share, base, next, why = '') => {
    const hop = appHop(base, share, next);
    page(res, 401, `${share.name} - private`, `
<h1>Sign in to open this link</h1><p>Only devices signed in to the Helm that shares <b>${esc(share.name)}</b> can open it.</p>
${why ? `<div class="e">${esc(why)}</div>` : ''}${hop ? `<a class="b" href="${esc(hop)}">Sign in with Helm</a>` : ''}`);
  };

  // Grants spent here, until they would have expired anyway: one use each.
  const spent = new Map(); // jti -> expires
  function spend(jti, expires) {
    const now = Date.now();
    if (spent.size > 4096) for (const [k, e] of spent) if (e <= now) spent.delete(k);
    if (spent.has(jti) || spent.size > 8192) return false;
    spent.set(jti, Math.min(expires, now + GRANT_TTL_MS));
    return true;
  }

  /** The app's grant, swapped for this link's own cookie. */
  async function enter(req, res, share, base) {
    let form;
    try { form = await readForm(req); } catch { return privatePage(res, share, base, '/', 'The request did not arrive. Try again.'); }
    const next = safeSharePath(form.get('next'));
    const net = loadNetwork();
    const grant = checkShareGrant(net, form.get('grant'), { name: share.name, host: base });
    if (!grant || !spend(grant.j, grant.e)) {
      return privatePage(res, share, base, next, 'This sign-in expired or someone used it. Sign in again.');
    }
    const expiresAt = Date.now() + MEMBER_TTL_MS;
    const value = memberCookie(net, { name: share.name, host: base, sub: grant.s, expiresAt });
    res.writeHead(303, {
      location: next, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'set-cookie': [
        `${MEMBER}=${value}; Path=/; Max-Age=${Math.floor(MEMBER_TTL_MS / 1000)}; HttpOnly; Secure; SameSite=Lax`,
        `${SEEN}=1; Path=/; Max-Age=${30 * 86400}; HttpOnly; Secure; SameSite=Lax`,
      ],
    });
    res.end();
  }

  /**
   * The request as the shared app should see it.
   *
   * Dev servers (Vite, Next, webpack, Express host checks) refuse a host they
   * do not know, and some read it from X-Forwarded-Host or Forwarded, not
   * Host. So unless the share asks to keep it, the link's own host reaches
   * the app nowhere: Host is localhost:<port>, the forwarding host headers
   * are dropped, and an Origin or Referer on the link is made local too.
   */
  function upstreamHeaders(req, share) {
    const keepHost = !!share.preserveHost;
    const out = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i], lk = k.toLowerCase();
      if (HOP.has(lk) || lk === 'host' || lk === 'cookie' || FORWARDED.has(lk)) continue;
      if (!keepHost && HOST_HEADERS.has(lk)) continue;
      out[k] = out[k] != null ? `${out[k]}, ${req.rawHeaders[i + 1]}` : req.rawHeaders[i + 1];
    }
    const cookie = withoutOurCookie(req.headers.cookie);
    if (cookie) out.Cookie = cookie;
    out['X-Forwarded-Proto'] = 'https';
    out['X-Forwarded-For'] = clientIp(req);
    if (keepHost) {
      out.Host = req.headers.host;
      out['X-Forwarded-Host'] = req.headers.host || '';
      return out;
    }
    out.Host = `localhost:${share.port}`;
    const linkOrigin = `https://${String(req.headers.host || '').toLowerCase()}`;
    const local = `http://localhost:${share.port}`;
    for (const k of Object.keys(out)) {
      const lk = k.toLowerCase();
      if (lk !== 'origin' && lk !== 'referer') continue;
      const v = String(out[k]);
      if (v.toLowerCase() === linkOrigin) out[k] = local;
      else if (v.toLowerCase().startsWith(`${linkOrigin}/`)) out[k] = local + v.slice(linkOrigin.length);
    }
    return out;
  }

  async function unlock(req, res, share) {
    const key = `${clientIp(req)}|${share.name}`;
    const now = Date.now();
    const seen = tries.get(key);
    if (seen && seen.until > now && seen.n >= 8) {
      return signIn(res, share.name, '/', 'Wait a few minutes before trying again.', 429);
    }
    // Reserve the attempt before reading a body: parallel or unfinished
    // requests must not all reuse the same old count.
    tries.set(key, { n: (seen && seen.until > now ? seen.n : 0) + 1, until: now + 10 * 60_000 });
    let form;
    try { form = await readForm(req); } catch { return signIn(res, share.name, '/', 'The request did not arrive. Try again.', 400); }
    const safeNext = safeSharePath(form.get('next'));
    if (!checkSharePassword(form.get('password') || '', share.lock)) {
      return signIn(res, share.name, safeNext, 'The password is incorrect.');
    }
    tries.delete(key);
    const expiresAt = now + COOKIE_DAYS * 86_400_000;
    res.writeHead(303, {
      location: safeNext, 'cache-control': 'no-store',
      'set-cookie': `${COOKIE}=${shareCookie(share.name, share.lock, expiresAt)}; Path=/; Max-Age=${COOKIE_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`,
    });
    res.end();
  }

  const offline = (res, share, err) => page(res, 502, `${share.name} - not reachable`, `
<h1>Not reachable right now</h1><p>${/not connected|offline/i.test(err?.message || '')
    ? 'The computer sharing this link is offline. Open Helm on that computer and keep it connected.'
    : `Nothing answered at 127.0.0.1:${share.port} or [::1]:${share.port} on the sharing computer. Start the app on port ${share.port}.`}</p><p>This page tries again in 3 seconds.</p><a class="b" href="">Try now</a>`, { refresh: '3' });

  /** Handle a request if it is for a share. Returns false when it is not. */
  async function route(req, res) {
    const { name, base } = linkOf(req) ?? {};
    if (!name) return false;
    const share = await lookup(name);
    if (!share) {
      page(res, 404, 'Link not found', `<h1>No link called “${esc(name)}”</h1><p>Check that the computer is online and still shares this link.</p>`);
      return true;
    }
    if (share.conflict) {
      page(res, 409, 'Link name in use', '<h1>Two machines use this link name</h1><p>Stop one link or give it another name, then try again.</p>');
      return true;
    }
    const path = req.url || '/';
    if (share.lock && path.startsWith('/.helm-share/unlock')) {
      if (req.method === 'POST') await unlock(req, res, share);
      else signIn(res, share.name, '/');
      return true;
    }
    if (share.private && path.startsWith('/.helm-share/enter')) {
      if (req.method === 'POST') await enter(req, res, share, base);
      else privatePage(res, share, base, '/');
      return true;
    }
    if (!unlocked(req, share, base)) {
      // A page load gets the sign-in; anything else (a fetch, an image) just
      // a plain refusal, which is what a script can understand.
      const pageLoad = req.method === 'GET' && /text\/html/.test(req.headers.accept || '');
      if (share.private) {
        // The app alone can check this browser's sign-in. Go there directly:
        // members get a pass without a sign-in screen or an extra click.
        const hop = pageLoad ? appHop(base, share, path) : null;
        if (hop) { res.writeHead(303, { location: hop, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(); }
        else if (pageLoad) privatePage(res, share, base, path);
        else { res.writeHead(401, { 'content-type': 'text/plain' }); res.end('private to its Helm'); }
        return true;
      }
      if (pageLoad) signIn(res, share.name, path);
      else { res.writeHead(401, { 'content-type': 'text/plain' }); res.end('password required'); }
      return true;
    }
    const up = http.request({ method: req.method, path, headers: upstreamHeaders(req, share), agent: agentFor(share) });
    up.on('response', (ur) => {
      // Once headers arrived, a broken tunnel fails the response stream,
      // not the request. End the visitor too, so downloads do not hang.
      ur.on('error', () => res.destroy());
      const out = [];
      for (let i = 0; i < ur.rawHeaders.length; i += 2) {
        if (!HOP.has(ur.rawHeaders[i].toLowerCase())) out.push(ur.rawHeaders[i], ur.rawHeaders[i + 1]);
      }
      res.writeHead(ur.statusCode, ur.statusMessage, out);
      ur.pipe(res);
    });
    // A visitor who leaves mid-answer frees the tunnel; one who got the
    // whole answer leaves it in the pool for the next request.
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    up.on('error', (err) => {
      if (res.headersSent) res.destroy();
      else offline(res, share, err);
    });
    req.pipe(up);
    return true;
  }

  /** A websocket (live reload, a chat app) on a share: piped as raw bytes. */
  async function upgrade(req, socket, head) {
    const { name, base } = linkOf(req) ?? {};
    if (!name) return false;
    const refuse = (code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    const share = await lookup(name);
    if (!share) { refuse(404, 'Not Found'); return true; }
    if (share.conflict) { refuse(409, 'Conflict'); return true; }
    if (!unlocked(req, share, base)) { refuse(401, 'Unauthorized'); return true; }
    let stream;
    try { stream = await openTcp(share.env, share.port); }
    catch { refuse(502, 'Bad Gateway'); return true; }
    // The visitor can leave while the machine is still opening its port.
    if (socket.destroyed) { stream.destroy(); return true; }
    const headers = upstreamHeaders(req, share);
    headers.Connection = 'Upgrade';
    headers.Upgrade = req.headers.upgrade || 'websocket';
    const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
    stream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) stream.write(head);
    stream.pipe(socket);
    socket.pipe(stream);
    const end = () => { socket.destroy(); stream.destroy(); };
    socket.on('error', end); socket.on('close', end);
    stream.on('error', end); stream.on('close', end);
    return true;
  }

  /** Caddy's question before it gets a certificate: is this a live link? */
  async function ask(req, res) {
    const domain = new URL(req.url, 'http://localhost').searchParams.get('domain') || '';
    const name = nameFor({ headers: { host: domain } });
    const share = name ? await lookup(name) : null;
    const ok = !!share && !share.conflict;
    res.writeHead(ok ? 200 : 404, { 'content-type': 'text/plain' });
    res.end(ok ? 'ok' : 'no');
  }

  return { route, upgrade, ask, owns: (req) => !!nameFor(req) };
}
