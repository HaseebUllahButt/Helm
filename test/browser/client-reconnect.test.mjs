import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import { build } from 'esbuild';

let browser, script;
before(async () => {
  browser = await chromium.launch({ headless: true,
    ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}),
  });
  const bundle = await build({ stdin: { contents: `
    import { Client } from './apps/web/src/client';
    window.Client = Client;
  `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'iife' });
  script = bundle.outputFiles[0].text;
});
after(async () => { await browser?.close(); });

async function hub(context, reach = 1) {
  const state = { delay: 0, upgradeDelay: 0, sockets: [], calls: [] };
  const timers = new Set();
  const later = (callback, delay) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay);
    timers.add(timer);
  };
  const server = createServer((request, response) => {
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-headers', 'authorization');
    if (request.method === 'OPTIONS') { response.end(); return; }
    if (request.url.startsWith('/api/')) {
      later(() => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ machines: Array.from({ length: reach }, (_, index) => ({ id: `machine-${index}`, online: true })), endpoints: [] }));
      }, state.delay);
    } else response.end('<!doctype html><title>Connection test</title>');
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => later(() => {
    sockets.handleUpgrade(request, socket, head, connection => sockets.emit('connection', connection));
  }, state.upgradeDelay));
  sockets.on('connection', socket => {
    state.sockets.push(socket);
    socket.on('message', raw => {
      const frame = JSON.parse(raw);
      if (frame.t === 'ping') socket.send(JSON.stringify({ t: 'pong' }));
      if (frame.t === 'rpc') state.calls.push({ socket, frame });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  context.after(() => {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets.clients) socket.terminate();
    sockets.close(); server.closeAllConnections(); server.close();
  });
  return Object.assign(state, { url: `http://127.0.0.1:${server.address().port}` });
}

async function pageFor(context, home) {
  const page = await browser.newPage();
  context.after(() => page.close());
  await page.goto(home.url);
  await page.addScriptTag({ content: script });
  await page.evaluate(async url => {
    window.client = new window.Client([url], 'test-token');
    await window.client.connect();
  }, home.url);
  return page;
}

test('real browser reconnect skips a six-second HTTP discovery delay', async context => {
  const home = await hub(context);
  const page = await pageFor(context, home);
  home.delay = 6000;
  const started = Date.now();
  home.sockets[0].terminate();
  await page.waitForFunction(() => !window.client.connected);
  await page.waitForFunction(() => window.client.connected, undefined, { timeout: 3000 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3000);
  context.diagnostic(`Reconnected in ${elapsed}ms with HTTP discovery delayed 6000ms`);
  assert.equal(home.sockets.length, 2);
  await page.evaluate(() => window.client.close());
});

test('real browser keeps pending writes on the old socket during a slow hub upgrade', async context => {
  const local = await hub(context);
  const remote = await hub(context, 3);
  remote.upgradeDelay = 1500;
  const page = await pageFor(context, local);
  await page.evaluate(url => {
    window.result = window.client.rpc('vm', 'session.input', { data: 'once' });
    window.client.learn([location.origin, url]);
  }, remote.url);
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.client.connected), true);
  assert.equal(await page.evaluate(() => window.client.relay), local.url);
  await page.waitForFunction(url => window.client.relay === url, remote.url);
  assert.equal(local.calls.length, 1);
  assert.equal(remote.calls.length, 0);
  const { socket, frame } = local.calls[0];
  assert.equal(socket.readyState, 1);
  socket.send(JSON.stringify({ t: 'rpcResult', id: frame.id, ok: true, result: 'accepted once' }));
  assert.equal(await page.evaluate(() => window.result), 'accepted once');
  await page.evaluate(() => window.client.close());
});
