import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mediaRoots } from './roots.js';
import { listMedia, mediaMime } from './catalog.js';
import { resolveMedia, MediaError } from './resolve.js';

/**
 * The byte-stream half of the NAS role.
 *
 * This is a real HTTP media path, not RPC frames: a browser <video> element
 * sends GET and HEAD with Range headers, seeks by asking for the middle of
 * the file, and expects Content-Length, Content-Range and the right MIME
 * type back. The original file is streamed as it lies - no transcoding, no
 * preloading.
 *
 * Who may ask is not decided here. `authorize(req)` is plugged in by whoever
 * mounts the handler - on a machine in a network it is the network's device
 * tokens, which is what lets a phone reach the NAS without the network key
 * ever appearing in a URL. The default answers only loopback: a standalone
 * server that defaults to open would be a file server for the whole LAN.
 */
const isLoopback = (req) => {
  const addr = req.socket?.remoteAddress;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
    || addr?.startsWith('127.');
};

const json = (res, code, body) => {
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
};

const STATUS = {
  invalid: 400, outside: 403, hidden: 404, missing: 404,
  'not-dir': 400, 'not-file': 400,
};

/**
 * A (req, res) handler for mounting under `mount` in an existing server.
 *
 * Returns false for anything outside the mount point so a hub can compose it
 * with its own routes; inside the mount every request is answered, and every
 * one of them is authorised before a path is even looked at.
 */
export function mediaHandler({ authorize = isLoopback, file, mount = '/media' } = {}) {
  const fail = (res, err) =>
    json(res, err instanceof MediaError ? STATUS[err.code] ?? 400 : 500,
      { error: err instanceof MediaError ? err.message : 'internal error' });

  const rootOf = (url) => {
    const n = Number(url.searchParams.get('root'));
    const roots = mediaRoots({ file });
    return Number.isInteger(n) ? roots[n] : undefined;
  };

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (path !== mount && !path.startsWith(mount + '/')) return false;

    if (!(await authorize(req))) {
      json(res, 401, { error: 'unauthorized' });
      return true;
    }

    if (path === `${mount}/roots` && req.method === 'GET') {
      json(res, 200, { roots: mediaRoots({ file }) });
      return true;
    }

    const root = rootOf(url);
    const rel = url.searchParams.get('path') ?? '';
    if (path === `${mount}/list` && req.method === 'GET') {
      if (!root) {
        json(res, 404, { error: 'no such shared folder' });
        return true;
      }
      try {
        json(res, 200, { root: root.id, ...(await listMedia(root.path, rel)) });
      } catch (err) { fail(res, err); }
      return true;
    }

    if (path === `${mount}/stream` && (req.method === 'GET' || req.method === 'HEAD')) {
      if (!root) {
        json(res, 404, { error: 'no such shared folder' });
        return true;
      }
      let target;
      try {
        target = await resolveMedia(root.path, rel);
        if (!target.stat.isFile()) throw new MediaError('not-file', 'that is a folder, not a file');
      } catch (err) {
        fail(res, err);
        return true;
      }

      const { size, mtimeMs } = target.stat;
      const etag = `W/"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
      const base = {
        'content-type': mediaMime(target.path) ?? 'application/octet-stream',
        'accept-ranges': 'bytes',
        'last-modified': new Date(mtimeMs).toUTCString(),
        // private: an authenticated device's copy, revalidated by etag -
        // nothing between the NAS and the phone may keep it.
        'cache-control': 'private, max-age=0, must-revalidate',
        etag,
      };

      if (req.headers['if-none-match'] === etag && !req.headers.range) {
        res.writeHead(304, base);
        res.end();
        return true;
      }

      // One range, the only kind a media element sends. A well-formed but
      // impossible range is refused with 416; a malformed one is ignored
      // wholesale, which is what the spec asks of a server that does not do
      // multipart answers.
      let start = 0;
      let end = size - 1;
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      const ifRangeOk = !req.headers['if-range'] || req.headers['if-range'] === etag;
      const ranged = range && ifRangeOk && size > 0 && (range[1] !== '' || range[2] !== '');
      if (ranged) {
        if (range[1] === '') {
          const n = Number(range[2]);
          start = n > 0 ? Math.max(0, size - n) : size;   // '-0' refuses below
        } else {
          start = Number(range[1]);
          if (range[2] !== '') end = Math.min(Number(range[2]), size - 1);
        }
        if (start > end || start >= size) {
          res.writeHead(416, {
            'accept-ranges': 'bytes',
            'content-range': `bytes */${size}`,
            'cache-control': base['cache-control'],
          });
          res.end();
          return true;
        }
      }

      const headers = {
        ...base,
        'content-length': end - start + 1,
        ...(ranged ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
      };
      res.writeHead(ranged ? 206 : 200, headers);
      // A zero-byte file has no bytes to read; opening one with end < start
      // throws, and the headers are already gone by then.
      if (req.method === 'HEAD' || size === 0) {
        res.end();
        return true;
      }
      const stream = createReadStream(target.path, { start, end });
      // A file that dies mid-stream has already sent its status; the only
      // honest answer left is to drop the connection.
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return true;
    }

    json(res, 404, { error: 'not found' });
    return true;
  };
}

/**
 * The handler as its own HTTP server - the direct-LAN half of streaming. The
 * Helm-routed path mounts `mediaHandler` inside the hub instead, so a phone
 * that cannot see the NAS directly still reaches it through the network.
 */
export async function startMediaServer({ port = 0, host = '0.0.0.0', ...opts } = {}) {
  const handle = mediaHandler(opts);
  const server = createServer(async (req, res) => {
    try {
      if (!(await handle(req, res))) json(res, 404, { error: 'not found' });
    } catch (err) {
      if (res.headersSent) res.destroy();
      else json(res, 500, { error: 'internal error' });
    }
  });
  await new Promise((ok, no) => {
    server.once('error', no);
    server.listen(port, host, ok);
  });
  const { port: bound, address } = server.address();
  const shown = typeof address === 'string' ? address : '0.0.0.0';
  return { server, port: bound, url: `http://${shown}:${bound}` };
}
