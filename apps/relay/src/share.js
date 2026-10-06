import http from 'node:http';
import { loadNetwork } from '@helm/protocol/network';
import {
  checkSharePassword, shareCookie, checkShareCookie, publicHosts,
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
 */

const COOKIE = '__Host-helm-share';
const COOKIE_DAYS = 30;
const CACHE_MS = 5000;
const MISS_MS = 2000;
// What must not survive a proxy hop, per the HTTP spec.
const HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade',
  'te', 'trailer', 'proxy-authorization', 'proxy-authenticate',
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
button{width:100%;font:inherit;font-weight:600;padding:11px;border:0;border-radius:11px;background:var(--acc);color:var(--on);cursor:pointer}
.e{color:var(--bad);font-size:14px;margin:-4px 0 12px}.f{margin-top:18px;font-size:12px;color:var(--dim);text-align:center}
</style><div class="c">${body}<div class="f">Shared with Helm</div></div></html>`);
}

const signIn = (res, name, next, error = '', status = 401) => page(res, status, `${name} - password`, `
<h1>This link has a password</h1><p>Ask whoever sent you <b>${esc(name)}</b> for it.</p>
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

/** The Cookie header minus ours: the shared app has no business seeing it. */
function withoutOurCookie(header) {
  const kept = String(header || '').split(';').map((p) => p.trim()).filter((p) => p && !p.startsWith(`${COOKIE}=`));
  return kept.length ? kept.join('; ') : null;
}

const clientIp = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';

function readForm(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > limit) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(new URLSearchParams(body)));
    req.on('error', reject);
  });
}

export function createShareRoute({ online, callEnv, openTcp }) {
  let cache = { at: 0, map: new Map() };
  let loading = null;
  const tries = new Map(); // ip|name -> { n, until }

  const refresh = () => (loading ??= (async () => {
    const map = new Map();
    await Promise.all([...online.keys()].map(async (env) => {
      try {
        const { shares } = await callEnv(env, 'share.list', { forHub: true }, { timeout: 4000 });
        for (const s of shares ?? []) if (!map.has(s.name)) map.set(s.name, { ...s, env });
      } catch { /* an older daemon, or one that is going away */ }
    }));
    cache = { at: Date.now(), map };
  })().finally(() => { loading = null; }));

  async function lookup(name) {
    const age = Date.now() - cache.at;
    // A known name is answered from memory and checked again behind the
    // request: asking every machine costs a round trip, which on a slow link
    // was most of a page load. A stopped share can be served once more from
    // memory - and then its machine refuses the tunnel anyway.
    if (cache.map.has(name)) {
      if (age > CACHE_MS) refresh().catch(() => {});
      return cache.map.get(name);
    }
    // A name not seen yet is looked for again, but not on every request: a
    // stranger guessing names must not turn into an RPC storm.
    if (age > MISS_MS) await refresh();
    return cache.map.get(name) ?? null;
  }

  // One connection pool per shared port. Opening a tunnel is a round trip
  // to the machine; a page with thirty files paid it thirty times.
  const agents = new Map();
  function agentFor(share) {
    const key = `${share.env}:${share.port}`;
    let agent = agents.get(key);
    if (agent) return agent;
    agent = new http.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4, timeout: 30_000 });
    agent.createConnection = (_options, done) => {
      openTcp(share.env, share.port).then((stream) => {
        // The machine closing its end must free the slot, or the pool would
        // hand the next request a tunnel nobody is reading.
        stream.once('end', () => stream.destroy());
        done(null, stream);
      }, (err) => done(err));
    };
    agents.set(key, agent);
    return agent;
  }

  /** `mockups` from mockups.130-210-33-163.sslip.io, if that is one of ours. */
  function nameFor(req) {
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    const bases = [...publicHosts(loadNetwork()), ...(process.env.HELM_SHARE_DOMAIN ? [process.env.HELM_SHARE_DOMAIN] : [])];
    for (const base of bases) {
      if (!host.endsWith(`.${base}`)) continue;
      const label = host.slice(0, -base.length - 1);
      if (label && !label.includes('.')) return label;
    }
    return null;
  }

  const unlocked = (req, share) =>
    !share.lock || checkShareCookie(cookies(req.headers.cookie)[COOKIE], share.name, share.lock);

  /** The request as the shared app should see it. */
  function upstreamHeaders(req, share) {
    const out = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i], lk = k.toLowerCase();
      if (HOP.has(lk) || lk === 'host' || lk === 'cookie') continue;
      out[k] = out[k] != null ? `${out[k]}, ${req.rawHeaders[i + 1]}` : req.rawHeaders[i + 1];
    }
    const cookie = withoutOurCookie(req.headers.cookie);
    if (cookie) out.Cookie = cookie;
    // Dev servers (Vite, Next, webpack) refuse a Host they do not know; to
    // the app, this is a local visit. Where it really came from is below.
    out.Host = `localhost:${share.port}`;
    out['X-Forwarded-Host'] = req.headers.host || '';
    out['X-Forwarded-Proto'] = 'https';
    out['X-Forwarded-For'] = clientIp(req);
    return out;
  }

  async function unlock(req, res, share) {
    const key = `${clientIp(req)}|${share.name}`;
    const now = Date.now();
    const seen = tries.get(key);
    if (seen && seen.until > now && seen.n >= 8) {
      return signIn(res, share.name, '/', 'Too many tries. Wait a few minutes and try again.', 429);
    }
    let form;
    try { form = await readForm(req); } catch { return signIn(res, share.name, '/', 'That did not arrive. Try again.', 400); }
    const next = String(form.get('next') || '/');
    const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';
    if (!checkSharePassword(form.get('password') || '', share.lock)) {
      tries.set(key, { n: (seen && seen.until > now ? seen.n : 0) + 1, until: now + 10 * 60_000 });
      return signIn(res, share.name, safeNext, 'That is not the password.');
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
    ? 'The computer sharing this link is offline.'
    : `Nothing answered on that computer's port ${share.port}. Is the app still running?`}</p>`);

  /** Handle a request if it is for a share. Returns false when it is not. */
  async function route(req, res) {
    const name = nameFor(req);
    if (!name) return false;
    const share = await lookup(name);
    if (!share) {
      page(res, 404, 'No such link', `<h1>No link called “${esc(name)}”</h1><p>It may have been stopped, or the computer sharing it is offline.</p>`);
      return true;
    }
    const path = req.url || '/';
    if (share.lock && path.startsWith('/.helm-share/unlock')) {
      if (req.method === 'POST') await unlock(req, res, share);
      else signIn(res, share.name, '/');
      return true;
    }
    if (!unlocked(req, share)) {
      // A page load gets the sign-in; anything else (a fetch, an image) just
      // a plain refusal, which is what a script can understand.
      if (req.method === 'GET' && /text\/html/.test(req.headers.accept || '')) signIn(res, share.name, path);
      else { res.writeHead(401, { 'content-type': 'text/plain' }); res.end('password required'); }
      return true;
    }
    const up = http.request({ method: req.method, path, headers: upstreamHeaders(req, share), agent: agentFor(share) });
    up.on('response', (ur) => {
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
    const name = nameFor(req);
    if (!name) return false;
    const refuse = (code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    const share = await lookup(name);
    if (!share) { refuse(404, 'Not Found'); return true; }
    if (!unlocked(req, share)) { refuse(401, 'Unauthorized'); return true; }
    let stream;
    try { stream = await openTcp(share.env, share.port); }
    catch { refuse(502, 'Bad Gateway'); return true; }
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
    const ok = !!name && !!(await lookup(name));
    res.writeHead(ok ? 200 : 404, { 'content-type': 'text/plain' });
    res.end(ok ? 'ok' : 'no');
  }

  return { route, upgrade, ask, owns: (req) => !!nameFor(req) };
}
