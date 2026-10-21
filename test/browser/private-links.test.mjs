import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

/**
 * The browser half of a private link: the Helm app gets a pass from its hub
 * and posts it to the link as a form, and the Public links screen offers the
 * switch and opens a private link the same way. The hub and the link are
 * played by Playwright routes on made-up https origins; the server half is
 * test/share-private.test.mjs.
 */

const bundle = await build({ stdin: { contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { ShareHop, shareHopTarget } from './apps/web/src/App';
  import { PublicLinks } from './apps/web/src/PublicLinks';
  import { Client } from './apps/web/src/client';
  const root = createRoot(document.getElementById('root'));
  window.showHop = () => {
    const client = new Client([location.origin], 'helm1.device-token');
    root.render(<ShareHop client={client} target={shareHopTarget()} onDone={() => { window.done = true; }} />);
  };
  window.showLinks = () => {
    window.calls = [];
    const shares = [
      { name: 'secret', port: 3000, password: false, private: true, url: 'https://secret.home.test', createdAt: Date.now(), expiresAt: Date.now() + 3 * 3600e3 },
      { name: 'demo', port: 4000, password: false, url: 'https://demo.home.test', createdAt: Date.now() },
    ];
    const client = {
      rpc: async (env, method, params) => {
        window.calls.push({ method, params });
        if (method === 'share.list') return { shares, features: ['private'] };
        return {};
      },
      shareGrant: async (params) => {
        window.calls.push({ method: 'grant', params });
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
  const browser = await chromium.launch({ headless: true,
    ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const entered = [];
  const grants = [];
  await context.route('https://home.test/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.pathname === '/api/share/grant') {
      grants.push({ auth: req.headers().authorization, body: JSON.parse(req.postData() || '{}') });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        action: 'https://secret.home.test/.helm-share/enter', grant: 'PASS-1', next: '/inside',
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
  assert.equal(grants[0].auth, 'Bearer helm1.device-token');
  assert.deepEqual(grants[0].body, { name: 'secret', host: 'home.test', next: '/inside' });
  assert.equal(entered.length, 1);
  assert.equal(entered[0].method, 'POST', 'the pass travels in a form body, not the address');
  assert.equal(entered[0].path, '/.helm-share/enter');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(entered[0].body)), { grant: 'PASS-1', next: '/inside' });
});

test('the Public links screen offers private links and opens one with a pass', async (t) => {
  const { context, entered } = await setup(t);
  const page = await context.newPage();
  await page.goto('https://home.test/');
  await page.evaluate(() => window.showLinks());
  await page.getByText('only your Helm devices', { exact: false }).waitFor();
  assert.match(await page.locator('.link-row').first().innerText(), /port 3000 · only your Helm devices/);
  assert.match(await page.locator('.link-row').nth(1).innerText(), /open to anyone with the link/);

  // Opening the private one: a new tab, posted the pass, cut off from Helm.
  const [tab] = await Promise.all([
    context.waitForEvent('page'),
    page.getByRole('button', { name: 'Open secret' }).click(),
  ]);
  await tab.getByText('inside the shared app').waitFor();
  assert.equal(entered.at(-1).method, 'POST');
  assert.equal(new URLSearchParams(entered.at(-1).body).get('grant'), 'PASS-2');
  assert.equal(await tab.evaluate(() => window.opener), null, 'the shared page cannot reach back into Helm');

  // The switch: on, the password goes away and the add says private.
  await page.getByRole('button', { name: /Create a Spin/ }).click();
  await page.getByPlaceholder('3000').fill('5173');
  const toggle = page.getByRole('switch');
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  assert.equal(await page.getByText('Password').count(), 1);
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  assert.equal(await page.getByText('Password').count(), 0);
  await page.getByRole('button', { name: 'Create Spin', exact: true }).click();
  await page.waitForFunction(() => window.calls.some((c) => c.method === 'share.add'));
  const add = await page.evaluate(() => window.calls.find((c) => c.method === 'share.add').params);
  assert.equal(add.port, 5173);
  assert.equal(add.private, true);
  assert.ok(!('password' in add), 'a private link sends no password');
});
