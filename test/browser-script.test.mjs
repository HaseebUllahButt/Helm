import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-browser-script-'));
process.env.HELM_NO_SERVICE = '1';
// No real windows on the screen of the machine running the tests.
delete process.env.WAYLAND_DISPLAY; delete process.env.DISPLAY;
for (const [key, file] of Object.entries({ HELM_DB: 'test.db', HELM_SSH_DIR: 'ssh', HELM_TERMINALS_SOCKET: 'term.sock', HELM_PROCS_SOCKET: 'proc.sock', HELM_NATIVE_SOCKET: 'native.sock' })) process.env[key] = join(process.env.HELM_DIR, file);
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
const { BrowserManager } = await import('../packages/connect/src/browser.js');
const { createBrowserRoutes } = await import('../packages/connect/src/browser-routes.js');
const { runBrowserCommand } = await import('../packages/connect/src/browser-cli.js');

const scripts = mkdtempSync(join(process.env.HELM_DIR, 'scripts-'));
let named = 0;
const file = (source, ext = 'js') => { const path = join(scripts, `script-${++named}.${ext}`); writeFileSync(path, source); return path; };
// The CLI as an agent runs it, with the Helm service's routes behind its calls.
const cli = (routes, chat, extra = {}) => async args => {
  const printed = [], exits = [];
  const result = await runBrowserCommand(args, { env: { HELM_SESSION_ID: chat }, self: () => 'local', print: text => printed.push(text), exit: (...a) => exits.push(a), rpc: (env, method, params) => routes.dispatch(method, params), ...extra });
  assert.deepEqual(JSON.parse(printed.at(-1)), JSON.parse(JSON.stringify(result)), 'the CLI prints the answer as JSON');
  return { result, exits };
};

const prices = { 1: [80, 95], 2: [70, 60], 3: [45, 99] };
async function shop(t, mode = {}) {
  const server = createServer((req, res) => {
    const n = Number(/^\/page\/(\d)$/.exec(req.url)?.[1] || 1);
    res.setHeader('Content-Type', 'text/html');
    res.end(`<title>Page ${n}</title><h1>Results ${n}</h1><ul>${prices[n].map(p => `<li class=price>$${p}</li>`).join('')}</ul>${n < 3 ? `<a href="/page/${n + 1}">Next</a>` : ''}`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const manager = new BrowserManager({ directory: mkdtempSync(join(process.env.HELM_DIR, 'shop-')), session: id => ({ id, mode: mode[id] || 'default' }), canWindow: false });
  t.after(async () => { await manager.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  try { await manager.start(); } catch { t.skip('no Chromium here'); return null; }
  // Count full page reads: finding a control by name reads only controls (budget 0).
  const reads = { count: 0 }, look = manager.look.bind(manager);
  manager.look = (tab, budget = 6000, options) => { if (budget !== 0) reads.count++; return look(tab, budget, options); };
  return { manager, routes: createBrowserRoutes({ manager }), url: `http://127.0.0.1:${server.address().port}/page/1`, reads };
}

test('a script loops over result pages and stops when a price is under $50, with no page read per step', { timeout: 60000 }, async t => {
  const env = await shop(t); if (!env) return;
  const { tab } = await env.manager.open('one', { url: env.url });
  const path = file(`
    const seen = [];
    for (;;) {
      const prices = await browser.evaluate(() => [...document.querySelectorAll('.price')].map(e => Number(e.textContent.slice(1))));
      seen.push(...prices);
      const cheap = prices.find(p => p < Number(args.under));
      if (cheap != null) { log('found', cheap); return { page: await browser.evaluate('location.pathname'), cheap, seen }; }
      log('none under', args.under, 'on', await browser.evaluate('document.title'));
      await browser.click('Next');
    }`);
  env.reads.count = 0;
  const { result, exits } = await cli(env.routes, 'one')(['script', tab.id, path, 'under=50']);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.value, { page: '/page/3', cheap: 45, seen: [80, 95, 70, 60, 45, 99] });
  assert.deepEqual(result.log, ['none under 50 on Page 1', 'none under 50 on Page 2', 'found 45']);
  assert.equal(result.steps, 8, 'three price reads, two titles, two clicks and one path');
  assert.ok(result.ms >= 0); assert.deepEqual(exits, [[0, false]]);
  assert.equal(env.reads.count, 0, 'no step read the whole page');
  // The same steps by hand read the page after each one.
  assert.ok((await env.manager.run('one', tab.id, { evaluate: '1' })).text);
  assert.equal(env.reads.count, 1);
});

test('"look": false skips the page read after a step, a batch and a failed check; the default still reads', { timeout: 60000 }, async t => {
  const env = await shop(t); if (!env) return;
  const { tab } = await env.manager.open('one', { url: env.url });
  env.reads.count = 0;
  const quiet = await env.manager.run('one', tab.id, { click: 'Next', look: false });
  assert.equal(quiet.text, undefined); assert.equal(quiet.tab.title, 'Page 2');
  const batch = await env.manager.run('one', tab.id, { actions: [{ check: 'Results 2' }, { click: 'Next' }], look: false });
  assert.equal(batch.text, undefined); assert.equal(batch.results.length, 2);
  const missed = await env.manager.run('one', tab.id, { check: 'Sold out', timeout: 300, look: false });
  assert.equal(missed.check.pass, false); assert.equal(missed.text, undefined);
  const passed = await env.manager.run('one', tab.id, { check: 'Results 3', look: false });
  assert.equal(passed.pass, true); assert.equal(passed.text, undefined);
  assert.equal(env.reads.count, 0);
  assert.match((await env.manager.run('one', tab.id, { check: 'Results 3' })).text, /Results 3/, 'without the option a step still reads the page');
  assert.match((await env.manager.run('one', tab.id, { actions: [{ check: 'Results 3' }] })).text, /Results 3/);
});

test('a failing step stops the script and says which step failed, with candidates and a page read', { timeout: 60000 }, async t => {
  const env = await shop(t); if (!env) return;
  const { tab } = await env.manager.open('one', { url: env.url });
  const path = file(`
    log('before');
    if (await browser.check('Results 1')) await browser.click('Next');
    await browser.click('the Buy button');
    log('never');`);
  const { result, exits } = await cli(env.routes, 'one')(['script', tab.id, path]);
  assert.equal(result.ok, false);
  assert.match(result.error, /no matching target "the Buy button"/);
  assert.deepEqual(result.step, { number: 3, call: 'click', tab: tab.id, action: { click: 'the Buy button', look: false } });
  assert.ok(Array.isArray(result.candidates));
  assert.match(result.page.text, /Results 2/, 'the read shows where the script stopped');
  assert.deepEqual(result.log, ['before']); assert.equal(result.steps, 3); assert.deepEqual(exits, [[1, false]]);
  // The script's own error names the last step it took.
  const own = (await cli(env.routes, 'one')(['script', tab.id, file(`await browser.check('Results 2'); throw new Error('no cheap price')`)])).result;
  assert.equal(own.ok, false); assert.equal(own.error, 'no cheap price'); assert.equal(own.afterStep.call, 'check'); assert.match(own.page.text, /Results 2/);
});

test('a read-only chat runs reads in a script but refuses a click before it reaches the page', { timeout: 60000 }, async t => {
  const env = await shop(t, { reader: 'readonly' }); if (!env) return;
  const { tab } = await env.manager.open('reader', { url: env.url });
  const path = file(`
    const page = await browser.look();
    log(page.elements.length ? 'read' : 'empty');
    log(await browser.check('Results 1'));
    await browser.click('Next');`);
  const { result } = await cli(env.routes, 'reader')(['script', tab.id, path]);
  assert.equal(result.ok, false);
  assert.match(result.error, /read-only/);
  assert.equal(result.step.number, 3); assert.equal(result.step.call, 'click');
  assert.deepEqual(result.log, ['read', 'true']);
  assert.equal(env.manager.tabs.get(tab.id).page.url(), env.url, 'the page did not change');
  assert.match(result.page.text, /Results 1/);
});

test('a module script reads from input, opens more tabs, and a timeout stops later steps', async () => {
  const calls = [], answers = {
    'browser.open': p => ({ tab: { id: 'second', url: p.url }, text: 'Second page', elements: [] }),
    'browser.list': () => ({ tabs: [{ id: 'first' }, { id: 'second' }] }),
    'browser.action': p => p.action.kind === 'look' ? { text: `look ${p.tabId}`, elements: [] } : { tab: { id: p.tabId } },
  };
  const routes = { dispatch: async (method, params) => { calls.push([method, params]); return answers[method](params); } };
  const source = `import { strict as assert } from 'node:assert';
export default async function (browser, { log, args }) {
  const second = await browser.open('http://localhost:1/');
  assert.equal(second.text, 'Second page');
  await second.click({ ref: 4, role: 'button', name: 'Go' });
  await browser.tab('first').type('Name', args.name, { enter: true, look: true });
  log((await browser.tabs()).length, 'tabs');
  return second.id;
}`;
  const { result } = await cli(routes, 'one', { readInput: async () => source })(['script', 'first', '-', 'name=Ada']);
  assert.equal(result.ok, true, result.error); assert.equal(result.value, 'second'); assert.deepEqual(result.log, ['2 tabs']); assert.equal(result.steps, 4);
  assert.deepEqual(calls.map(([method, params]) => [method, params.tabId ?? null, params.action ?? null]), [
    ['browser.open', null, null],
    ['browser.action', 'second', { click: 4, look: false }],
    ['browser.action', 'first', { type: 'Ada', into: 'Name', enter: true, look: true }],
    ['browser.list', null, null],
  ]);
  assert.ok(calls.every(([, params]) => params.id === 'one'), 'every call names the chat');
  // A module file on disk works too.
  assert.equal((await cli(routes, 'one')(['script', 'first', file('export default async browser => browser.id;')])).result.value, 'first');

  // --timeout ends the script; a step it sends later is refused.
  let release, late; const lateDone = new Promise(resolve => { late = resolve; });
  globalThis.scriptGate = new Promise(resolve => { release = resolve; });
  globalThis.scriptLate = late;
  calls.length = 0;
  const { result: stopped, exits } = await cli(routes, 'one')(['script', 'first', file(`
    await browser.look();
    await globalThis.scriptGate;
    try { await browser.click('Next'); } catch (error) { globalThis.scriptLate(error.message); }`), '--timeout', '200']);
  assert.equal(stopped.ok, false); assert.equal(stopped.error, 'The script timed out after 200 ms.'); assert.equal(stopped.afterStep.call, 'look');
  assert.equal(stopped.page.text, 'look first'); assert.deepEqual(exits, [[1, true]]);
  release();
  assert.equal(await lateDone, 'the script timed out after 200 ms, so this step was not sent');
  assert.deepEqual(calls.map(([, params]) => params.action.kind), ['look', 'look'], 'the click never left the CLI');

  // A script that does not load says so, and sends nothing.
  calls.length = 0;
  const broken = (await cli(routes, 'one')(['script', 'first', file('if (')])).result;
  assert.equal(broken.ok, false); assert.match(broken.error, /^The script did not load: /); assert.equal(broken.steps, 0); assert.equal(calls.length, 0);
  await assert.rejects(runBrowserCommand(['script', 'first'], { env: { HELM_SESSION_ID: 'one' }, self: () => 'local', rpc: async () => ({}) }), /needs a tab and a file/);
  await assert.rejects(runBrowserCommand(['script', 'first', 'x.js', '--timeout', 'soon'], { env: { HELM_SESSION_ID: 'one' }, self: () => 'local', rpc: async () => ({}) }), /whole number/);
});

test('browser.captcha() in a script waits for the owner in short calls until the CAPTCHA is solved', async () => {
  const calls = []; let polls = 0;
  const routes = { dispatch: async (method, params) => { calls.push([method, params]); return ++polls < 3 ? { waiting: true, vendor: 'recaptcha', seconds: polls } : { solved: true, vendor: 'recaptcha', seconds: 3 }; } };
  const { result } = await cli(routes, 'one')(['script', 'first', file('const answer = await browser.captcha({ timeout: 250000 }); return answer.solved;')]);
  assert.equal(result.ok, true, result.error); assert.equal(result.value, true); assert.equal(result.steps, 3);
  assert.deepEqual(calls.map(([method, params]) => [method, params.tabId, params.wait <= 100000, params.id]), Array(3).fill(['browser.captcha', 'first', true, 'one']));
  assert.equal(calls.at(-1)[1].last, false, 'a later call is still to come while time is left');
});
