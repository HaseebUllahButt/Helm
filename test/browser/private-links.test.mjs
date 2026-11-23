import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

/**
 * The browser half of a private link: the Helm app gets a pass from its hub
 * and posts it to the link as a form, and the Public links screen opens a
 * private link the same way. The hub and the link are
 * played by Playwright routes on made-up https origins; the server half is
 * test/share-private.test.mjs.
 */

const bundle = await build({ stdin: { contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { App, ShareHop, shareHopTarget } from './apps/web/src/App';
  import { PublicLinks } from './apps/web/src/PublicLinks';
  import { Client } from './apps/web/src/client';
  import { browserProofKey } from './apps/web/src/hubAuth';
  const root = createRoot(document.getElementById('root'));
  window.showApp = () => {
    Client.prototype.connect = async () => {};
    root.render(<App />);
  };
  window.makeAuth = async () => ({ token: 'helm1.' + btoa(JSON.stringify({ net: 'test-network', sub: 'phone', proofKey: await browserProofKey() })) + '.fixture',
    endpoints: ['https://home.test'] });
  window.showHop = async () => {
    const auth = await window.makeAuth();
    const client = new Client([location.origin], auth.token);
    root.render(<ShareHop client={client} target={shareHopTarget()} onDone={() => { window.done = true; }} />);
  };
  window.showLinks = () => {
    const shares = [
      { name: 'secret', port: 3000, password: false, private: true, url: 'https://secret.home.test', createdAt: Date.now(), expiresAt: Date.now() + 3 * 3600e3 },
    ];
    const client = {
      rpc: async (env, method) => method === 'share.list' ? { shares, features: ['private'] } : {},
      shareGrant: async () => {
        return { action: 'https://secret.home.test/.helm-share/enter', grant: 'PASS-2', next: '/' };
      },
    };
    root.render(<div className="app"><PublicLinks client={client} env={{ id: 'laptop', name: 'laptop', online: true }} /></div>);
  };
`, resolveDir: process.cwd(), loader: 'tsx' },
plugins: [{ name: 'hop-exports', setup(b) {
  b.onLoad({ filter: /\/App\.tsx$/ }, async ({ path }) => ({
    contents: (await readFile(path, 'utf8')) + '\nexport { ShareHop, shareHopTarget };', loader: 'tsx',
  }));
} }],
bundle: true, write: false, format: 'iife', jsx: 'automatic' });
const script = bundle.outputFiles[0].text;
const css = (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '');

async function setup(t) {
  const hub = generateKeyPairSync('ed25519');
  const hubKey = hub.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  const browser = await chromium.launch({ headless: true,
    ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const entered = [];
  const grants = [];
  await context.route('https://home.test/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === '/api/health') return route.fulfill({ json: { ok: true } });
    if (url.pathname === '/api/hub/identity') {
      const proof = { network: 'test-network', issuer: 'hub', key: hubKey,
        nonce: JSON.parse(req.postData()).nonce, challenge: 'private-link-check', exp: Date.now() + 60_000 };
      const payload = ['helm-proof-v3', proof.network, 'hub-identity', Object.entries(proof).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)];
      return route.fulfill({ json: { ...proof, signature: sign(null, Buffer.from(JSON.stringify(payload)), hub.privateKey).toString('base64url') } });
    }
    if (url.pathname === '/api/share/grant') {
      const claims = JSON.parse(Buffer.from(req.headers().authorization.split('.')[1], 'base64url'));
      const proof = JSON.parse(Buffer.from(req.headers()['x-helm-proof'], 'base64url'));
      assert.equal(proof.aud, 'hub');
      assert.equal(proof.sub, 'phone');
      assert.equal(proof.path, '/api/share/grant');
      assert.equal(verify(null, Buffer.from(JSON.stringify(['helm-device-request-v1', claims.net,
        proof.aud, proof.sub, proof.ch, proof.method, proof.path, proof.exp])),
        createPublicKey({ key: Buffer.from(claims.proofKey, 'base64url'), format: 'der', type: 'spki' }),
        Buffer.from(proof.signature, 'base64url')), true);
      grants.push({ auth: req.headers().authorization, body: JSON.parse(req.postData() || '{}') });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        action: 'https://secret.home.test/.helm-share/enter', grant: 'PASS-1', next: JSON.parse(req.postData() || '{}').next,
      }) });
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: `<style>${css}</style><div id="root"></div><script>${script}</script>` });
  });
  await context.route('https://secret.home.test/**', (route) => {
    const req = route.request();
    entered.push({ method: req.method(), path: new URL(req.url()).pathname, body: req.postData() });
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>inside the shared app</h1>' });
  });
  return { context, entered, grants };
}

test('signed in, the app turns a private link\'s visit into a pass posted back to it', async (t) => {
  const { context, entered, grants } = await setup(t);
  const page = await context.newPage();
  await page.goto('https://home.test/#share=secret&host=home.test&next=%2Finside');
  await page.evaluate(() => window.showHop());
  await page.waitForURL('https://secret.home.test/**');
  await page.getByText('inside the shared app').waitFor();

  assert.equal(grants.length, 1);
  assert.equal(JSON.parse(Buffer.from(grants[0].auth.split('.')[1], 'base64url')).sub, 'phone');
  assert.deepEqual(grants[0].body, { name: 'secret', host: 'home.test', next: '/inside' });
  assert.equal(entered.length, 1);
  assert.equal(entered[0].method, 'POST', 'the pass travels in a form body, not the address');
  assert.equal(entered[0].path, '/.helm-share/enter');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(entered[0].body)), { grant: 'PASS-1', next: '/inside' });
});

test('a spin fragment arriving in an open signed-in Helm tab opens immediately', async (t) => {
  const { context, grants } = await setup(t);
  const page = await context.newPage();
  await page.goto('https://home.test/');
  await page.evaluate(async () => {
    localStorage.setItem('helm.auth', JSON.stringify(await window.makeAuth()));
    window.showApp();
  });
  // Signed in and on screen: the app is listening for the link's fragment.
  await page.waitForFunction(() => document.getElementById('root').childElementCount > 0);
  await page.evaluate(() => { location.hash = 'share=secret&host=home.test&next=%2Finside%3Fx%3D1'; });
  await page.getByText('inside the shared app').waitFor();
  assert.equal(grants.length, 1);
  assert.equal(grants[0].body.next, '/inside?x=1');
});

test('the Public links screen opens a private link with a posted pass, cut off from Helm', async (t) => {
  const { context, entered } = await setup(t);
  const page = await context.newPage();
  await page.goto('https://home.test/');
  await page.evaluate(() => window.showLinks());
  await page.getByRole('button', { name: 'Open secret' }).waitFor();

  // Opening the private one: a new tab, posted the pass, cut off from Helm.
  const [tab] = await Promise.all([
    context.waitForEvent('page'),
    page.getByRole('button', { name: 'Open secret' }).click(),
  ]);
  await tab.getByText('inside the shared app').waitFor();
  assert.equal(entered.at(-1).method, 'POST');
  assert.equal(new URLSearchParams(entered.at(-1).body).get('grant'), 'PASS-2');
  assert.equal(await tab.evaluate(() => window.opener), null, 'the shared page cannot reach back into Helm');
});
