import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const workerSource = readFileSync(new URL('../apps/web/public/sw.js', import.meta.url), 'utf8');

function response(body, { ok = true, type = 'basic' } = {}) {
  return { body, ok, type, status: ok ? 200 : 500, clone() { return response(body, { ok, type }); } };
}

function setup({ fetch, shell } = {}) {
  const listeners = new Map();
  const entries = new Map(shell ? [['/index.html', shell]] : []);
  const timers = new Map();
  const lifetime = [];
  const notifications = [];
  let timerId = 0;
  const cache = {
    add: async () => {},
    put: async (key, value) => { entries.set(typeof key === 'string' ? key : new URL(key.url).pathname, value); },
    match: async (key) => entries.get(typeof key === 'string' ? key : new URL(key.url).pathname),
    keys: async () => [...entries.keys()],
    delete: async (key) => entries.delete(key),
  };
  const caches = {
    open: async () => cache,
    match: async (key) => cache.match(key),
    keys: async () => ['helm-shell-v9', 'helm-assets'],
    delete: async () => true,
  };
  const self = {
    location: { origin: 'https://helm.test' },
    addEventListener: (name, handler) => listeners.set(name, handler),
    skipWaiting: async () => {},
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} },
    registration: { getNotifications: async () => [], showNotification: async (title, options) => { notifications.push({ title, options }); } },
  };
  class TestResponse {
    static error() { return response('network error', { ok: false, type: 'error' }); }
  }
  const context = {
    self, caches, fetch, URL, Map, Promise,
    Response: TestResponse,
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(workerSource, context, { filename: 'sw.js' });
  return {
    entries, listeners, lifetime, timers, notifications,
    async dispatchPush(payload) {
      let result;
      listeners.get('push')({ data: { json: () => payload }, waitUntil(promise) { result = promise; } });
      await result;
    },
    dispatchNavigation() {
      let result;
      const event = {
        request: { method: 'GET', url: 'https://helm.test/agent/abc', mode: 'navigate' },
        respondWith(promise) { result = Promise.resolve(promise); },
        waitUntil(promise) { lifetime.push(Promise.resolve(promise)); },
      };
      listeners.get('fetch')(event);
      return result;
    },
    fireDeadline() {
      const [id, timer] = [...timers.entries()].find(([, t]) => t.delay === 250) ?? [];
      assert.ok(timer, 'navigation deadline was scheduled');
      timers.delete(id);
      timer.callback();
    },
  };
}

test('a stalled navigation serves the cached shell and late network response refreshes it', async () => {
  let resolveFetch;
  const network = new Promise((resolve) => { resolveFetch = resolve; });
  const worker = setup({ fetch: () => network, shell: response('old shell') });
  const page = worker.dispatchNavigation();

  worker.fireDeadline();
  assert.equal((await page).body, 'old shell');

  resolveFetch(response('new shell'));
  await Promise.all(worker.lifetime);
  assert.equal(worker.entries.get('/index.html').body, 'new shell');
});

test('a fast network response clears the pending fallback timer', async () => {
  const worker = setup({ fetch: async () => response('fresh shell') });
  const page = worker.dispatchNavigation();

  assert.equal((await page).body, 'fresh shell');
  assert.equal(worker.timers.size, 0);
  await Promise.all(worker.lifetime);
});

test('a temporary gateway error still opens the saved app', async () => {
  const worker = setup({ fetch: async () => response('gateway error', {ok:false}), shell: response('saved app') });
  assert.equal((await worker.dispatchNavigation()).body, 'saved app');
  await Promise.all(worker.lifetime);
  assert.equal(worker.entries.get('/index.html').body, 'saved app');
});

test('entry bundle caching is included in the worker lifetime', async () => {
  const worker = setup({ fetch: async () => response('entry script') });
  let result;
  worker.listeners.get('fetch')({
    request:{method:'GET',url:'https://helm.test/assets/index-hash.js',mode:'cors'},
    respondWith(promise){result=promise;}, waitUntil(promise){worker.lifetime.push(promise);},
  });
  assert.equal((await result).body,'entry script');
  assert.equal(worker.lifetime.length,1);
  await Promise.all(worker.lifetime);
  assert.equal(worker.entries.get('/assets/index-hash.js').body,'entry script');
});

test('a cold cache keeps waiting past the deadline for the network shell', async () => {
  let resolveFetch;
  const network = new Promise((resolve) => { resolveFetch = resolve; });
  const worker = setup({ fetch: () => network });
  const page = worker.dispatchNavigation();
  let settled = false;
  page.finally(() => { settled = true; });

  worker.fireDeadline();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false, 'no cached shell means no early offline error');

  resolveFetch(response('first shell'));
  assert.equal((await page).body, 'first shell');
  await Promise.all(worker.lifetime);
});

test('a rejected fetch uses a good cached shell and never returns a cached error', async () => {
  const worker = setup({ fetch: () => Promise.reject(new Error('offline')), shell: response('last good shell') });
  assert.equal((await worker.dispatchNavigation()).body, 'last good shell');
  await Promise.all(worker.lifetime);

  let resolveFetch;
  const pending = new Promise((resolve) => { resolveFetch = resolve; });
  const badShell = setup({ fetch: () => pending, shell: response('cached error', { ok: false, type: 'error' }) });
  const page = badShell.dispatchNavigation();
  badShell.fireDeadline();
  await Promise.resolve();
  await Promise.resolve();
  resolveFetch(response('network shell'));
  assert.equal((await page).body, 'network shell');
});

test('completion previews can dismiss naturally, while approvals stay available', async () => {
  const worker = setup();
  const target = { envId: 'e1', sessionId: 's1' };
  await worker.dispatchPush({ ...target, title: 'Helm · Codex finished', body: 'Fix login', tag: 'helm-done-s1-123' });
  await worker.dispatchPush({ ...target, title: 'Helm · Codex needs approval', body: 'Fix login', tag: 'helm-s1-r1' });
  assert.equal(worker.notifications[0].title, 'Helm · Codex finished');
  assert.equal(worker.notifications[0].options.requireInteraction, false);
  assert.equal(worker.notifications[1].options.requireInteraction, true);
  assert.equal(worker.notifications[1].options.data.sessionId, 's1');
  assert.equal(worker.notifications[1].options.icon, '/icon-192.png');
});
