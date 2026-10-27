import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const directory = await mkdtemp(join(tmpdir(), 'helm-browser-identity-'));
process.env.HELM_DIR = directory;
process.env.HELM_NO_SERVICE = '1';
delete process.env.DISPLAY; delete process.env.WAYLAND_DISPLAY;
const { chromeIdentity } = await import('../packages/connect/src/browser-identity.js');
const { BrowserManager } = await import('../packages/connect/src/browser.js');
test.after(() => rm(directory, { recursive: true, force: true }));

test('the hidden browser uses one Chromium version in its user agent and client hints', () => {
  assert.equal(chromeIdentity({ userAgent: 'Chrome/152.0.0.0', product: 'Chrome/152.0.1.2' }), null);
  const identity = chromeIdentity({ userAgent: 'Mozilla/5.0 HeadlessChrome/153.0.1.2 Safari/537.36', product: 'Chrome/153.0.1.2' }, 'linux', 'arm64');
  assert.equal(identity.userAgent, 'Mozilla/5.0 Chrome/153.0.0.0 Safari/537.36');
  assert.deepEqual(identity.userAgentMetadata.fullVersionList[0], { brand: 'Chromium', version: '153.0.1.2' });
  assert.equal(identity.userAgentMetadata.architecture, 'arm');
  assert.equal(identity.userAgentMetadata.bitness, '64');
});

test('native browser details agree in requests, pages, frames and workers; console reading is explicit', { timeout: 30000 }, async t => {
  const headers = [];
  const server = createServer((req, res) => {
    headers.push(req.headers);
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Native browser</title><button onclick="window.open(\'/popup\')">Test</button><script>window.firstUA=navigator.userAgent; window.siteValue=42; console.log("browser-ready",42)</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const manager = new BrowserManager({ directory, session: id => ({ id }), canWindow: false });
  t.after(async () => { await manager.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const { tab: { id } } = await manager.open('identity', { url });
  const script = `async () => {
    const frame = document.createElement('iframe'); frame.src = '${url}/frame';
    await new Promise(resolve => { frame.onload = resolve; document.body.append(frame); });
    const worker = new Worker(URL.createObjectURL(new Blob(['postMessage({ua:navigator.userAgent,languages:navigator.languages})'], {type:'text/javascript'})));
    const data = await new Promise(resolve => { worker.onmessage = event => resolve(event.data); }); worker.terminate();
    return { ua:navigator.userAgent, webdriver:navigator.webdriver, chrome:!!window.chrome, plugins:navigator.plugins.length,
      pluginArray:navigator.plugins instanceof PluginArray, languages:navigator.languages, frame:frame.contentWindow.navigator.webdriver,
      worker:data, siteValue:window.siteValue, brands:navigator.userAgentData.brands };
  }`;
  const { value } = await manager.run('identity', id, { evaluate: `(${script})()` });
  assert.equal(value.webdriver, false); assert.equal(value.frame, false); assert.equal(value.chrome, true);
  assert.ok(value.plugins > 0); assert.equal(value.pluginArray, true); assert.ok(value.languages.length > 0);
  assert.doesNotMatch(value.ua, /HeadlessChrome/); assert.equal(value.worker.ua, value.ua);
  assert.deepEqual(value.worker.languages, value.languages); assert.equal(value.siteValue, 42, 'evaluate can read the site’s own variables');
  const major = /Chrome\/(\d+)/.exec(value.ua)[1];
  assert.ok(value.brands.some(brand => brand.brand === 'Chromium' && brand.version === major));
  assert.equal(headers[0]['user-agent'], value.ua);
  assert.match(headers[0]['sec-ch-ua'], new RegExp(`"Chromium";v="${major}"`));
  const page = manager.get('identity', id).page, popupOpened = page.waitForEvent('popup');
  await manager.run('identity', id, { kind: 'click', selector: 'button' });
  const popup = await popupOpened;
  await popup.waitForLoadState('domcontentloaded');
  const child = [...manager.tabs.values()].find(tab => tab.page === popup);
  const first = await manager.run('identity', child.id, { evaluate: 'window.firstUA' });
  assert.equal(first.value, value.ua, 'a popup starts with the normal user agent before its first script');
  assert.ok(headers.every(header => !header['user-agent'].includes('HeadlessChrome')));
  const consoleResult = await manager.run('identity', id, { kind: 'console' });
  assert.ok(consoleResult.entries.some(entry => entry.text === 'browser-ready 42'));
  const again = await manager.run('identity', id, { kind: 'console' });
  assert.equal(again.entries.length, consoleResult.entries.length, 'buffered messages are not repeated');
});

test('pointer actions do not wait for unrelated background requests, and navigation needs no second quiet wait', async () => {
  const manager = new BrowserManager({ directory, session: id => ({ id }) });
  const tab = { id: 'tab', sessionId: 'one', engine: 'chromium', downloads: [], fetching: new Set(['background']),
    page: { mouse: { move: async () => {} }, url: () => 'http://example.test', viewportSize: () => ({ width: 1280, height: 800 }), waitForLoadState: async () => {} } };
  manager.aim = async () => {}; manager.look = async () => ({ text: 'Ready' });
  manager.settle = async () => { throw new Error('unrelated fetch must not hold a pointer move'); };
  assert.equal((await manager.perform(tab, { kind: 'hover', x: 10, y: 10 })).text, 'Ready');
  let quietCalls = 0; manager.quiet = () => { quietCalls++; return new Promise(() => {}); };
  await BrowserManager.prototype.settle.call(manager, tab, { navigation: true });
  assert.equal(quietCalls, 1, 'a completed load does not wait again for background fetches');
  await manager.stop();
});
