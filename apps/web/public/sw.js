/**
 * helm service worker.
 *
 * The shell is cached so the app opens instantly and survives a dead network;
 * everything that talks to a machine is left alone. Caching an API response
 * here would mean showing you a session state that is no longer true, which is
 * worse than showing you nothing.
 */
const CACHE = 'helm-shell-v2';
const SHELL = [
  '/', '/index.html', '/manifest.webmanifest',
  '/icon.svg', '/icon-180.png', '/icon-192.png', '/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;

  // Navigations resolve to the app shell: this is a single-page app, so every
  // path is a route rather than a document on disk.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html').then((r) => r ?? Response.error()))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) =>
      hit ??
      fetch(request).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
    )
  );
});
