import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

test('opening the website and installed app inherits the terminal join without pairing or redirect', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'helm-browser-join-'));
  process.env.HELM_DIR = root;
  process.env.HELM_DB = join(root, 'hub.sqlite');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const N = await import('@helm/protocol/network');
  const net = N.createNetwork({ name: 'joined laptop' });
  const { startRelay } = await import('@helm/relay');
  const hub = await startRelay({ port: 0, host: '127.0.0.1', dbFile: process.env.HELM_DB });
  const hubPort = hub.server.address().port;
  t.after(() => hub.stop());
  const bundle = await build({
    stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { Login, AddMachine } from './apps/web/src/App';
      import { Client } from './apps/web/src/client';
      import { loadAuthSync, saveAuth } from './apps/web/src/store';
      const root = createRoot(document.getElementById('root'));
      const show = auth => {
        saveAuth(auth);
        root.render(<div>Signed in to the joined network</div>);
        window.auth = auth;
      };
      const stored = loadAuthSync();
      if (stored) show(stored); else root.render(<Login onDone={show} />);
      const local = 'http://127.0.0.1:${hubPort}';
      window.localClient = () => {
        const c = new Client([location.origin, local], window.auth.token);
        c.relay = local;
        return c;
      };
      window.showAdd = () => root.render(<AddMachine client={window.localClient()} />);
    `, resolveDir: process.cwd(), loader: 'tsx' },
    plugins: [{ name: 'login-test-exports', setup(b) {
      b.onLoad({ filter: /\/App\.tsx$/ }, async ({ path }) => ({
        contents: (await readFile(path, 'utf8')).replace("'http://127.0.0.1:8787'", `'http://127.0.0.1:${hubPort}'`)
          + '\nexport { Login, AddMachine };', loader: 'tsx',
      }));
    }}],
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
  });
  const script = bundle.outputFiles[0].text;
  const key = join(root, 'key.pem'), cert = join(root, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
    '-out', cert, '-days', '1', '-subj', '/CN=helm.test'], { stdio: 'ignore' });
  const requests = [];
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (req, res) => {
    requests.push(req.url);
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, network: net.id }));
    }
    if (req.url.startsWith('/api/')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const response = await fetch(`http://127.0.0.1:${hubPort}${req.url}`, {
        method: req.method,
        headers: { 'content-type': 'application/json', authorization: req.headers.authorization || '' },
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      res.writeHead(response.status, { 'content-type': 'application/json' });
      return res.end(await response.text());
    }
    if (req.url === '/app.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      return res.end(script);
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<div id="root"></div><script src="/app.js"></script>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  // localhost counts as local in Login. Use an explicit remote-looking name
  // mapped only in this isolated browser, so the real CORS bridge is exercised.
  const remoteOrigin = `https://helm.test:${server.address().port}`;
  N.describeSelf(N.loadNetwork(), { endpoints: [remoteOrigin] });
  const browser = await chromium.launch({ headless: true,
    args: ['--host-resolver-rules=MAP helm.test 127.0.0.1', '--no-proxy-server'],
    ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}),
  });
  t.after(() => browser.close());
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.grantPermissions(['local-network-access'], { origin: remoteOrigin });
  const page = await context.newPage();
  await page.goto(remoteOrigin);
  await page.getByText('Signed in to the joined network', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).origin, remoteOrigin, 'website keeps its install scope');
  const auth = await page.evaluate(() => window.auth);
  assert.ok(N.authenticate(N.loadNetwork(), auth.token));
  assert.equal(await page.getByText('pairing code', { exact: true }).count(), 0);
  await page.reload();
  await page.getByText('Signed in to the joined network', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.auth.deviceId), auth.deviceId);
  const app = await context.newPage();
  await app.goto(remoteOrigin);
  await app.getByText('Signed in to the joined network', { exact: true }).waitFor();
  assert.equal(await app.evaluate(() => window.auth.deviceId), auth.deviceId);

  await page.evaluate(() => window.showAdd());
  await page.getByLabel('Computer kind').selectOption('nas');
  await page.getByRole('button', { name: 'Make join command' }).click();
  await page.locator('pre.snippet').waitFor();
  const command = await page.locator('pre.snippet').innerText();
  assert.ok(command.startsWith(`helm join '${remoteOrigin}/#join=`));
  assert.ok(requests.includes('/api/invite'), 'local desktop mints at the reachable public home');
  const code = new URL(command.slice(11, -1)).hash.slice(6);
  const { q } = await import('@helm/relay/db');
  assert.equal(q.inviteGet.get(code).role, 'nas');
  const phoneLink = await page.evaluate(() => window.localClient().newPassword());
  assert.equal(phoneLink.base, remoteOrigin, 'phone links also use the home that minted them');
  await page.evaluate(base => window.localClient().closePairing(base), phoneLink.base);
  assert.equal(q.authGet.get().expires_at, 0, 'closing a remote link closes the right pairing window');
});
