import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Start a hub.
 *
 * Every machine in a network runs one of these. There is no designated
 * server: a phone can connect to whichever machine it can currently reach,
 * and that machine can authenticate it on its own, because membership is
 * proved by a signature against the shared network key rather than by a row
 * in some particular database. Losing any one machine costs you that machine,
 * not the network.
 */
export async function startRelay({
  port = 8787,
  password,
  dbFile,
  webRoot = null,
  host = '0.0.0.0',
  passwordTtlMs,
  openLogin = true,
} = {}) {
  // The data layer reads its location once, at import; set it before loading.
  if (dbFile) process.env.CON_DB = dbFile;

  const http = await import('./http.js');
  const {
    makeHttpHandler, clientTokenFrom, identify, rotatePassword, ROLE, SECURITY_HEADERS,
  } = http;
  const { createWsLayer } = await import('./ws.js');

  // Starting up opens a fresh login window so there is always a way in from a
  // new device. It does not disturb devices that are already members - they
  // hold durable tokens and have no further use for a password.
  const auth = openLogin
    ? rotatePassword(password, passwordTtlMs)
    : { password: null, expiresAt: 0 };

  const { wss, online, kick } = createWsLayer();
  const api = makeHttpHandler({ online, kick });

  const serveStatic = async (req, res) => {
    if (!webRoot) return false;
    const url = new URL(req.url, 'http://localhost');
    // Any unknown path is an app route, not a missing file.
    let rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (rel === '/' || !extname(rel)) rel = '/index.html';

    const file = join(webRoot, rel);
    if (!file.startsWith(webRoot)) return false;
    try {
      if (!(await stat(file)).isFile()) return false;
      res.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': rel === '/index.html' ? 'no-cache' : 'public, max-age=3600',
        ...SECURITY_HEADERS,
      });
      res.end(await readFile(file));
      return true;
    } catch {
      return false;
    }
  };

  // What the app checks against its own bundle: the hashed asset this hub's
  // index.html points at. An installed PWA resumes the page it loaded rather
  // than reloading, so without this an old bundle runs until it happens to
  // die. The answer is just a filename - nothing worth hiding behind auth.
  const version = async (req, res) => {
    try {
      const html = await readFile(join(webRoot, 'index.html'), 'utf8');
      const m = /src="([^"]*assets\/[^"]+)"/.exec(html);
      res.writeHead(200, {
        'content-type': 'application/json', 'cache-control': 'no-store', ...SECURITY_HEADERS,
      });
      res.end(JSON.stringify({ build: m?.[1] ?? null }));
    } catch {
      res.writeHead(404, { 'content-type': 'application/json', ...SECURITY_HEADERS });
      res.end('{}');
    }
  };

  // `/con/...` is the app's own prefix, kept because clients send it: the
  // web app opens `/con/ws` and older ones open `/ws`. It used to matter
  // more - everything outside it belonged to the machine's T3 - and now it
  // is simply stripped.
  const conPath = (req) => {
    if (req.url === '/con' || req.url.startsWith('/con/')) {
      req.url = req.url.slice(5) || '/';
      return true;
    }
    return false;
  };

  const routeCon = (req, res) =>
    req.url === '/api/version'
      ? version(req, res)
      : req.url.startsWith('/api/')
      ? api(req, res)
      : serveStatic(req, res).then((served) => {
          if (served) return null;
          // Not an api path and not a file: con's own 404. Falling through
          // to api() here would 401 an unknown page, which reads as auth, not
          // absence.
          res.writeHead(404, { 'content-type': 'application/json', ...SECURITY_HEADERS });
          res.end(JSON.stringify({ error: 'not found' }));
          return null;
        });

  const server = createServer((req, res) => {
    conPath(req);
    Promise.resolve(routeCon(req, res)).catch((err) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message || err) }));
    });
  });

  // Browsers cannot set an Authorization header on a WebSocket, so the web
  // app smuggles its token through the subprotocol list ("con", <token>).
  // Reading it here keeps the credential out of Caddy and tunnel access logs,
  // which is where a ?token= query string would end up.
  const tokenFromProtocols = (header) =>
    String(header || '')
      .split(',')
      .map((p) => p.trim())
      .find((p) => p.startsWith('helm1.')) || null;

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    // /con/ws is con's protocol by any name; /ws is the same endpoint for
    // older clients.
    if (url.pathname !== '/con/ws' && url.pathname !== '/ws') return socket.destroy();

    // Header or subprotocol only. `?token=` used to be accepted here for older
    // clients, which undid the reason the subprotocol trick exists three lines
    // above: a query string is exactly what Caddy and every tunnel write to
    // their access logs, and a device token does not expire, so one log line
    // is a permanent credential. Nothing has sent one since the web app moved
    // to the subprotocol and the daemon to the header.
    const token =
      tokenFromProtocols(req.headers['sec-websocket-protocol']) ||
      clientTokenFrom(req.headers.authorization);
    const reject = () => {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
    };
    if (!token) return reject();

    const who = identify(token);
    if (!who) return reject();
    const { net, claims } = who;

    // Membership is proved by the signature, not by whether we happen to have
    // heard of this machine yet. A machine that joined via another hub will
    // reach us before any gossip does, and turning it away - or quietly
    // demoting it to a client, which is what a roster lookup used to do -
    // would leave it permanently invisible as somewhere you can run agents.
    const machine = net.machines[claims.sub] ?? (
      claims.role === ROLE.MACHINE
        ? { id: claims.sub, name: url.searchParams.get('name') || claims.sub.slice(0, 8) }
        : null
    );

    // A machine attaches to exactly one hub as *itself*: its own, over
    // loopback, which is what lets a phone reach this machine through the hub
    // this machine is running. The daemon marks that link `role=self`.
    //
    // Any *other* self-attach is refused. It can only be a machine that dialled
    // an address which turned out to be its own (its public or LAN endpoint) -
    // a second env attachment for the same id, which supersedes the loopback
    // one, so the two knock each other down forever (invariant #2). The daemon
    // already excludes its own endpoints from what it dials; this is the
    // backstop for when it does not.
    const role = url.searchParams.get('role');
    if (machine && claims.sub === net.self && claims.role === ROLE.MACHINE
        && role !== 'client' && role !== 'proxy' && role !== 'self') {
      socket.write('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }

    const asClient = () =>
      wss.handleUpgrade(req, socket, head, (ws) =>
        // `sub` is who this socket authenticated as, kept so a revocation can
        // cut the live connection instead of only refusing the next one.
        wss.emit('connection', ws, req, { role: 'client', sub: claims.sub })
      );

    // A machine attaches as an environment - unless it is asking to drive
    // one. `con proxy` and the desktop app both use the machine's own
    // credential as a client; registering them as the environment would evict
    // the daemon actually serving it.
    if (machine && url.searchParams.get('role') !== 'client'
                && url.searchParams.get('role') !== 'proxy') {
      let info = {};
      try { info = JSON.parse(url.searchParams.get('info') || '{}'); } catch {}
      return wss.handleUpgrade(req, socket, head, (ws) =>
        wss.emit('connection', ws, req, {
          role: 'env', env: { id: machine.id, name: machine.name }, info,
        })
      );
    }
    return asClient();
  });

  // Surface listen failures as a rejection rather than letting the server's
  // unhandled 'error' event take the whole process down with a stack trace.
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return {
    server, port, online,
    password: auth.password,
    expiresAt: auth.expiresAt,
    stop: () => server.close(),
  };
}
