import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { connect } from 'node:net';
import { execFileSync } from 'node:child_process';
import { createServer as viteServer } from 'vite';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { WebSocket } from 'ws';

// Real Helm HTTP, sign-in, cookie checks, daemon tunnels and plain Vite.
// A private TLS gateway and Chromium's DNS map keep every request on
// loopback. No mocked browser redirects, owner network or production state.
const root = mkdtempSync(join(tmpdir(), 'helm-spin-e2e-'));
process.env.HELM_DIR = join(root, 'helm');
process.env.HELM_DB = join(root, 'hub.sqlite');
process.env.HELM_SSH_DIR = join(root, 'ssh');
process.env.HELM_NO_SERVICE = '1';
delete process.env.HELM_SHARE_DOMAIN;
delete process.env.INVOCATION_ID;
const N = await import('@helm/protocol/network');
const { mintToken } = await import('@helm/protocol/identity');
const { T, M } = await import('@helm/protocol');
const { startRelay } = await import('@helm/relay');
const { Daemon } = await import('../../packages/connect/src/agent.js');
const { addShare } = await import('../../packages/connect/src/shares.js');
const free = http.createServer();
await new Promise((resolve) => free.listen(0, '127.0.0.1', resolve));
const port = free.address().port;
await new Promise((resolve) => free.close(resolve));
const net = N.createNetwork({ name: 'Laptop', port });
N.advertise(net, ['https://home.test']);
const webRoot = join(root, 'web');
mkdirSync(webRoot);
const bundle = await build({ stdin: { contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { App } from './apps/web/src/App';
  createRoot(document.getElementById('root')).render(<App />);
`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
const css = readFileSync('apps/web/src/styles.css', 'utf8').replace(/^@import[^;]+;/gm, '');
writeFileSync(join(webRoot, 'app.js'), bundle.outputFiles[0].text);
writeFileSync(join(webRoot, 'icon.svg'), readFileSync('apps/web/public/icon.svg'));
writeFileSync(join(webRoot, 'index.html'), `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/app.js"></script>`);
const hub = await startRelay({ port, host: '127.0.0.1', webRoot, password: 'test-pairing-code' });
const daemon = new Daemon({ port, advertiseLan: false });
const machine = new WebSocket(`ws://127.0.0.1:${port}/helm/ws?name=Laptop&role=self`, {
  headers: { authorization: `Bearer ${mintToken(net.key, { net: net.id, sub: net.self, role: 'machine' })}` },
});
const link = { id: 'test-hub', send: (type, extra) => machine.send(JSON.stringify({ t: type, ...extra })) };
machine.on('message', async (raw) => {
  const msg = JSON.parse(raw);
  if (msg.t === T.RPC) {
    try { link.send(T.RPC_RESULT, { id: msg.id, ok: true, result: await daemon.dispatch(msg.method, msg.params, msg.caller) }); }
    catch (error) { link.send(T.RPC_RESULT, { id: msg.id, ok: false, error: error.message }); }
  } else if ([T.TUNNEL_OPEN, T.TUNNEL_DATA, T.TUNNEL_ACK, T.TUNNEL_CLOSE].includes(msg.t)) {
    await daemon.onFrame(link, msg);
  }
});
await new Promise((resolve, reject) => { machine.once('open', resolve); machine.once('error', reject); });
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem'), '-subj', '/CN=home.test', '-days', '1'], { stdio: 'ignore' });
const gateway = https.createServer({ key: readFileSync(join(root, 'key.pem')), cert: readFileSync(join(root, 'cert.pem')) }, (req, res) => {
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers }, (response) => {
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  });
  up.on('error', () => res.destroy()); req.pipe(up);
});
const gatewaySockets = new Set();
gateway.on('connection', (socket) => { gatewaySockets.add(socket); socket.on('close', () => gatewaySockets.delete(socket)); });
gateway.on('upgrade', (req, socket, head) => {
  const up = connect({ host: '127.0.0.1', port }, () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
    if (head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  socket.on('error', () => up.destroy()); socket.on('close', () => up.destroy());
  up.on('error', () => socket.destroy()); up.on('close', () => socket.destroy());
});
await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
const gatewayPort = gateway.address().port;
const browser = await chromium.launch({ headless: true,
  args: ['--no-proxy-server', `--host-resolver-rules=MAP *.home.test 127.0.0.1:${gatewayPort}, MAP home.test 127.0.0.1:${gatewayPort}`],
  ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
test.after(async () => { await browser.close(); for (const socket of gatewaySockets) socket.destroy(); gateway.close(); machine.terminate(); await daemon.stop(); hub.stop(); rmSync(root, { recursive: true, force: true }); });

async function contextFor(t) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true,
    isMobile: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' });
  t.after(() => context.close());
  return context;
}

for (const [index, host] of [undefined, '127.0.0.1', '::1', '0.0.0.0'].entries()) {
  test(`fresh sign-in returns to the exact private Vite URL and live reload works (${host || 'default localhost'})`, async (t) => {
    const appRoot = join(root, `vite-${index}`);
    mkdirSync(appRoot);
    writeFileSync(join(appRoot, 'index.html'), '<div id="message">Loading</div><script type="module" src="/main.js"></script>');
    const main = (text) => `document.querySelector('#message').textContent = '${text}'; if (import.meta.hot) import.meta.hot.accept();`;
    writeFileSync(join(appRoot, 'main.js'), main('Shared page ready'));
    const vite = await viteServer({ configFile: false, root: appRoot, logLevel: 'silent', server: { port: 0, ...(host ? { host } : {}) } });
    await vite.listen();
    t.after(() => vite.close());
    const appPort = vite.httpServer.address().port;
    const name = `vite-${index}`;
    await daemon.dispatch(M.SHARE_ADD, { name, port: appPort, private: true });
    const context = await contextFor(t);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const exact = `https://${name}.home.test/review?tab=cost&file=a%2Fb&tab=two`;
    await page.goto(exact);
    await page.getByText(`Sign in to open ${name}, shared from Laptop.`, { exact: true }).waitFor();
    if (process.env.HELM_SPIN_SHOT_DIR && index === 0) await page.screenshot({ path: join(process.env.HELM_SPIN_SHOT_DIR, 'spin-sign-in.png') });
    await page.locator('input[type=password]').fill('test-pairing-code');
    await page.getByRole('button', { name: 'Pair this device', exact: true }).click();
    await page.getByText('Shared page ready', { exact: true }).waitFor();
    assert.equal(page.url(), exact);
    const member = (await context.cookies(exact)).find((cookie) => cookie.name === '__Host-helm-member');
    assert.equal(member.domain, `${name}.home.test`);
    assert.equal(member.httpOnly, true);
    assert.equal(member.secure, true);
    await page.waitForTimeout(500);
    writeFileSync(join(appRoot, 'main.js'), main('Live reload works'));
    await page.getByText('Live reload works', { exact: true }).waitFor();
    // The spin's cookie opens it immediately, without returning to Helm.
    const homes = [];
    page.on('request', (request) => { if (request.isNavigationRequest() && new URL(request.url()).host === 'home.test') homes.push(request.url()); });
    await page.goto(exact);
    await page.getByText('Live reload works', { exact: true }).waitFor();
    assert.deepEqual(homes, []);
    if (index === 0) {
      // Signed into Helm but new to this spin: no sign-in or dashboard.
      await daemon.dispatch(M.SHARE_ADD, { name: 'another-private', port: appPort, private: true });
      await page.goto('https://another-private.home.test/next?keep=a%2Fb');
      await page.getByText('Live reload works', { exact: true }).waitFor();
      assert.equal(page.url(), 'https://another-private.home.test/next?keep=a%2Fb');
      assert.equal(await page.getByRole('button', { name: 'Pair this device' }).count(), 0);
    }
    assert.deepEqual(errors, []);
    if (process.env.HELM_SPIN_SHOT_DIR && index === 0) await page.screenshot({ path: join(process.env.HELM_SPIN_SHOT_DIR, 'spin-open.png') });
  });
}

test('a failed app retries by itself and opens when the port comes back', async (t) => {
  const app = http.createServer((_req, res) => res.end('<h1>The app is back</h1>'));
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const appPort = app.address().port;
  await new Promise((resolve) => app.close(resolve));
  // An existing share must survive its app going away and coming back.
  addShare({ name: 'returning-app', port: appPort });
  const page = await (await contextFor(t)).newPage();
  await page.goto('https://returning-app.home.test/inside?keep=this');
  await page.getByRole('heading', { name: 'Not reachable right now' }).waitFor();
  assert.match(await page.locator('body').innerText(), new RegExp(`127\\.0\\.0\\.1:${appPort} or \\[::1\\]:${appPort}`));
  await new Promise((resolve) => app.listen(appPort, '127.0.0.1', resolve));
  t.after(() => { app.closeAllConnections(); app.close(); });
  await page.getByRole('heading', { name: 'The app is back' }).waitFor();
  assert.equal(page.url(), 'https://returning-app.home.test/inside?keep=this');
});
