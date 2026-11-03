import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { build } from 'esbuild';

const root = mkdtempSync(join(tmpdir(), 'helm-browser-proof-'));
process.env.HELM_DIR = root;
process.env.HELM_DB = join(root, 'hub.sqlite');
process.env.HELM_NO_SERVICE = '1';
const N = await import('@helm/protocol/network');
const { startRelay } = await import('@helm/relay');
test.after(() => rmSync(root, { recursive: true, force: true }));

test('a real browser signs remote requests and refuses retired addresses', async t => {
  const net = N.createNetwork();
  const origin = 'https://hub.audit.invalid';
  N.advertise(net, [origin]);
  const hub = await startRelay({ port: 0, host: '127.0.0.1', dbFile: process.env.HELM_DB });
  t.after(() => hub.stop());
  const target = `http://127.0.0.1:${hub.server.address().port}`;
  const browser = await chromium.launch({ headless: true,
    ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const requests = [];
  // The secure browser origin is intercepted. No public host is contacted.
  await page.route('**/*', async route => {
    const request = route.request();
    requests.push(request.url());
    const url = new URL(request.url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Private device proof check</title>' });
    const res = await fetch(target + url.pathname, { method: request.method(), body: request.postData(),
      headers: { ...request.headers(), host: url.host, 'x-forwarded-for': '192.0.2.5', 'x-forwarded-proto': 'https' } });
    await route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() });
  });
  await page.goto(origin);
  const bundle = await build({ stdin: { contents: "import { HubAuth, browserProofKey } from './apps/web/src/hubAuth'; window.HubAuth = HubAuth; window.browserProofKey = browserProofKey;", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'iife' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const proofKey = await page.evaluate(() => window.browserProofKey());
  const phone = N.issueDevice(net, 'real browser', proofKey);
  const result = await page.evaluate(async ({ token, trust }) => {
    const auth = new window.HubAuth(token, trust);
    const request = proof => fetch('/api/network', { headers: { authorization: `Bearer ${token}`, ...proof } }).then(r => r.status);
    const bare = await request({});
    const proof = await auth.headers(location.origin, 'GET', '/api/network');
    const valid = await request(proof);
    const replay = await request(proof);
    auth.acceptTrust({ ...trust, machines: { ...trust.machines, retired: { key: Object.values(trust.machines)[0].key, endpoints: ['https://retired.audit.invalid'] } } });
    auth.acceptTrust(trust);
    let refused = false;
    try { await auth.headers('https://retired.audit.invalid', 'GET', '/api/network'); } catch { refused = true; }
    return { bare, valid, replay, refused };
  }, { token: phone.token, trust: N.hubTrust(net) });
  assert.deepEqual(result, { bare: 401, valid: 200, replay: 401, refused: true });
  assert.equal(requests.some(url => url.startsWith('https://retired.')), false);
  await page.reload();
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  assert.equal(await page.evaluate(() => window.browserProofKey()), proofKey, 'the private browser key survives a page reload');
});
