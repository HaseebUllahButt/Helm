import { createHash } from 'node:crypto';
import { realpath, readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { brotliCompress, constants, gzip } from 'node:zlib';
import { promisify } from 'node:util';

const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const MIN_COMPRESS_BYTES = 512;
const DEFAULT_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 256;

const identity = (info) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;

const isWithin = (root, target) => {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

const etagFor = (body) => `"${createHash('sha256').update(body).digest('base64url')}"`;

const compressible = (contentType) => {
  const type = contentType.split(';', 1)[0].trim().toLowerCase();
  return type.startsWith('text/')
    || type === 'application/javascript'
    || type === 'application/json'
    || type === 'application/manifest+json'
    || type === 'application/xml'
    || type === 'image/svg+xml';
};

/**
 * Parse the request's content-coding preferences. An explicit coding always
 * overrides `*`; identity is acceptable by default unless explicitly excluded
 * or excluded by `*;q=0`.
 */
function encodingQuality(header, coding) {
  if (header == null) return coding === 'identity' ? 1 : 0;
  const values = new Map();
  for (const item of String(header).split(',')) {
    const [rawName, ...params] = item.trim().split(';');
    const name = rawName.trim().toLowerCase();
    if (!name || values.has(name)) continue;
    let q = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*(.*?)\s*$/i.exec(param);
      if (!match) continue;
      q = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(match[1])
        ? Number(match[1])
        : 0;
      break;
    }
    values.set(name, q);
  }

  if (values.has(coding)) return values.get(coding);
  const wildcard = values.get('*');
  if (coding === 'identity') return wildcard === 0 ? 0 : 1;
  return wildcard ?? 0;
}

function selectEncoding(header, canCompress) {
  const candidates = canCompress ? ['br', 'gzip', 'identity'] : ['identity'];
  const ranked = candidates
    .map((name, order) => ({ name, order, q: encodingQuality(header, name) }))
    .filter((item) => item.q > 0)
    .sort((a, b) => b.q - a.q || a.order - b.order);
  return ranked[0]?.name ?? null;
}

const matchesIfNoneMatch = (header, etag) => {
  if (!header) return false;
  return String(header).split(',').some((raw) => {
    const tag = raw.trim();
    return tag === '*' || (tag.replace(/^W\//i, '') === etag);
  });
};

/**
 * Build a static-file handler with a bounded in-memory representation cache.
 * Text assets are compressed on demand and each representation receives its
 * own strong ETag. The cache is invalidated when the file identity changes.
 */
export function createStaticHandler({
  webRoot,
  securityHeaders = {},
  maxCacheBytes = DEFAULT_CACHE_BYTES,
} = {}) {
  if (!webRoot) return async () => false;

  const requestedCacheLimit = Number(maxCacheBytes);
  const cacheLimit = Math.max(0, Number.isFinite(requestedCacheLimit)
    ? requestedCacheLimit
    : DEFAULT_CACHE_BYTES);
  const rootPromise = realpath(resolve(webRoot)).catch(() => null);
  const cache = new Map(); // canonical path -> LRU entry
  const inFlight = new Map();
  let cachedBytes = 0;

  const forget = (file, entry) => {
    if (cache.get(file) !== entry) return;
    cache.delete(file);
    cachedBytes -= entry.cacheBytes;
  };

  const trimCache = () => {
    while (cache.size > MAX_CACHE_ENTRIES || cachedBytes > cacheLimit) {
      const oldest = cache.entries().next().value;
      if (!oldest) break;
      forget(oldest[0], oldest[1]);
    }
  };

  const touch = (file, entry) => {
    if (cache.get(file) !== entry) return;
    cache.delete(file);
    cache.set(file, entry);
  };

  const readEntry = async (file, info) => {
    const key = identity(info);
    const cached = cache.get(file);
    if (cached?.identity === key) {
      touch(file, cached);
      return cached;
    }
    if (cached) forget(file, cached);

    const flightKey = `${file}\0${key}`;
    if (inFlight.has(flightKey)) return inFlight.get(flightKey);
    const flight = (async () => {
      const source = await readFile(file);
      const freshInfo = await stat(file, { bigint: true });
      // Atomic deploys can replace a file between stat and read. Retry against
      // the new identity so a response is never cached under stale metadata.
      if (identity(freshInfo) !== key) return readEntry(file, freshInfo);

      const entry = {
        identity: key,
        source,
        etag: etagFor(source),
        variants: new Map(),
        variantFlights: new Map(),
        cacheBytes: source.length,
      };
      if (source.length <= cacheLimit && cacheLimit > 0) {
        cache.set(file, entry);
        cachedBytes += entry.cacheBytes;
        trimCache();
      }
      return entry;
    })();
    inFlight.set(flightKey, flight);
    try {
      return await flight;
    } finally {
      inFlight.delete(flightKey);
    }
  };

  const representation = async (file, entry, encoding) => {
    if (encoding === 'identity') return { body: entry.source, etag: entry.etag };
    const cached = entry.variants.get(encoding);
    if (cached) return cached;
    if (entry.variantFlights.has(encoding)) return entry.variantFlights.get(encoding);

    const flight = (async () => {
      const body = encoding === 'br'
        ? await compressBrotli(entry.source, {
            params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
          })
        : await compressGzip(entry.source, { level: 6 });
      const result = { body, etag: etagFor(body) };
      entry.variants.set(encoding, result);
      const addedBytes = body.length;
      if (cache.get(file) === entry) {
        entry.cacheBytes += addedBytes;
        cachedBytes += addedBytes;
        touch(file, entry);
        trimCache();
      }
      return result;
    })();
    entry.variantFlights.set(encoding, flight);
    try {
      return await flight;
    } finally {
      entry.variantFlights.delete(encoding);
    }
  };

  return async function serveStatic(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    let url;
    let requestPath;
    try {
      url = new URL(req.url, 'http://localhost');
      requestPath = decodeURIComponent(url.pathname);
    } catch {
      return false;
    }
    if (!requestPath.startsWith('/') || requestPath.includes('\0') || requestPath.includes('\\')) {
      return false;
    }

    const root = await rootPromise;
    if (!root) return false;

    // Preserve SPA routing for paths without a file extension. Resolve from a
    // dot-prefixed URL path, then verify both lexical and symlink-resolved paths.
    const lexicalCandidate = resolve(root, `.${requestPath}`);
    if (!isWithin(root, lexicalCandidate)) return false;

    const normalizedPath = normalize(requestPath);
    const routePath = normalizedPath === '/' || !extname(normalizedPath)
      ? '/index.html'
      : normalizedPath;
    const candidate = resolve(root, `.${routePath}`);
    if (!isWithin(root, candidate)) return false;

    let file;
    let info;
    try {
      file = await realpath(candidate);
      if (!isWithin(root, file)) return false;
      info = await stat(file, { bigint: true });
      if (!info.isFile()) return false;
    } catch {
      return false;
    }

    const contentType = MIME[extname(routePath).toLowerCase()] ?? 'application/octet-stream';
    const canCompress = info.size >= BigInt(MIN_COMPRESS_BYTES) && compressible(contentType);
    const encoding = selectEncoding(req.headers['accept-encoding'], canCompress);
    const vary = canCompress ? { vary: 'Accept-Encoding' } : {};
    const cacheControl = routePath === '/index.html' || routePath === '/sw.js'
      ? 'no-cache'
      : routePath.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=3600';

    if (!encoding) {
      res.writeHead(406, {
        'cache-control': 'no-store',
        ...vary,
        ...securityHeaders,
      });
      res.end();
      return true;
    }

    let entry;
    try {
      entry = await readEntry(file, info);
    } catch {
      return false;
    }
    const current = await representation(file, entry, encoding);
    const headers = {
      'content-type': contentType,
      'content-length': current.body.length,
      'cache-control': cacheControl,
      etag: current.etag,
      'last-modified': new Date(Number(info.mtimeMs)).toUTCString(),
      ...vary,
      ...(encoding === 'identity' ? {} : { 'content-encoding': encoding }),
      ...securityHeaders,
    };

    if (matchesIfNoneMatch(req.headers['if-none-match'], current.etag)) {
      delete headers['content-length'];
      res.writeHead(304, headers);
      res.end();
      return true;
    }

    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : current.body);
    return true;
  };
}
