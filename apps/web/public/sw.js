/**
 * helm service worker.
 *
 * The shell is cached so the app opens instantly and survives a dead network;
 * everything that talks to a machine is left alone. Caching an API response
 * here would mean showing you a session state that is no longer true, which is
 * worse than showing you nothing.
 */
const CACHE = 'helm-shell-v3';
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

/**
 * A push arrives when the app is closed, which is the only time it matters.
 *
 * The payload is helm's own JSON, encrypted end to end - the push service
 * that carried it could not read it. `tag` collapses repeats of the same
 * request, so a retry does not stack three copies of one question on the
 * lock screen, and `renotify` still buzzes for a genuinely new one.
 */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* not ours */ }
  const title = data.title || 'A session needs you';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    tag: data.tag || 'helm',
    renotify: true,
    requireInteraction: true,
    icon: '/icon-192.png',
    badge: '/favicon-32.png',
    data,
  }));
});

/**
 * Tapping it should land on the session that asked, not on a home screen you
 * then have to navigate from - being one tap from answered is the point.
 * An app already open is focused and told where to go rather than reloaded.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { envId, sessionId } = event.notification.data ?? {};
  const target = envId && sessionId ? `/#open=${envId}/${sessionId}` : '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      client.postMessage({ type: 'helm:open', envId, sessionId });
      return client.focus();
    }
    return self.clients.openWindow(target);
  })());
});
