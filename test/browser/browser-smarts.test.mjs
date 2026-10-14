import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';

const directory = await mkdtemp(join(tmpdir(), 'helm-browser-smart-pages-'));
process.env.HELM_DIR = directory; process.env.HELM_NO_SERVICE = '1';
// No real windows on the screen of the machine running the tests.
delete process.env.WAYLAND_DISPLAY; delete process.env.DISPLAY;
for (const [key, file] of Object.entries({ HELM_DB: 'test.db', HELM_SSH_DIR: 'ssh', HELM_TERMINALS_SOCKET: 'term.sock', HELM_PROCS_SOCKET: 'proc.sock', HELM_NATIVE_SOCKET: 'native.sock' })) process.env[key] = join(directory, file);
const { BrowserManager } = await import('../../packages/connect/src/browser.js');
test.after(() => rm(directory, { recursive: true, force: true }));

async function fixture(t) {
  const server = createServer((req, res) => {
    if (req.url === '/data') { res.setHeader('Content-Type', 'text/plain'); const timer = setTimeout(() => res.end('Signed in as Ada'), 120); res.on('close', () => clearTimeout(timer)); return; }
    if (req.url === '/pending') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.flushHeaders(); return; }
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/frame') { res.end('<label>Frame name<input></label><button onclick="document.body.dataset.clicked=\'yes\'">Frame save</button>'); return; }
    if (req.url === '/states') { res.end('<label for=name>Name</label><input id=name value=Ada><label>Password<input type=PASSWORD value=private-password></label><input type=checkbox aria-label=Remember checked disabled><input type=radio aria-label=Choice checked><button aria-expanded=true>Menu</button><div role=tab aria-selected=true>Inbox</div><div role=menuitem>Archive</div><div role=switch aria-checked=true>Power</div><select size=2 aria-label=Country><option>Canada</option><option>US</option></select><details open><summary>More</summary></details><div onclick="this.textContent=\'Clicked\'">Clickable</div><div id=shadow></div><iframe src=/frame></iframe><script>document.getElementById("shadow").attachShadow({mode:"open"}).innerHTML="<label>Shadow name<input></label><button>Shadow save</button>"</script>'); return; }
    if (req.url === '/ambiguous') { res.end('<button onclick="window.clicked=true">Send</button><button onclick="window.clicked=true">Send</button><input aria-label=Search><div style="height:2000px"></div><button>Bottom</button>'); return; }
    res.end('<title>Login</title><form onsubmit="event.preventDefault();fetch(\'/data\').then(r=>r.text()).then(value=>document.querySelector(\'output\').textContent=value)"><label>Email<input name=email></label><label>Password<input type=password name=password></label><button>Sign in</button></form><output></output><button type=button onclick="document.querySelector(\'output\').textContent=\'Static done\'">Static</button><button onclick="fetch(\'/pending\')">Pending</button>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const manager = new BrowserManager({ directory: join(directory, String(server.address().port)), session: id => ({ id }) });
  t.after(async () => { await manager.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { manager, url: `http://127.0.0.1:${server.address().port}` };
}

test('plain words drive a login in one batch; fetch data and checks arrive in the reply; flows replay', { timeout: 20000 }, async t => {
  const { manager, url } = await fixture(t), opened = await manager.open('login', { url });
  const result = await manager.run('login', opened.tab.id, { actions: [{ goto: url }, { type: '{{email}}', into: 'the Email box', clear: true }, { type: '{{password}}', into: 'the Password field', clear: true }, { click: 'the Sign in button' }, { check: 'Signed in as Ada' }], with: { email: 'ada@example.test', password: 'private-password' }, save_as: 'sign-in', note: 'Sign in to the local test' });
  assert.equal(result.failedAt, undefined); assert.match(result.text, /Signed in as Ada/); assert.equal(result.results[4].pass, true); assert.equal(result.saved, 'sign-in'); assert.ok(!result.text.includes('private-password'));
  assert.deepEqual((await manager.listFlows('login')).flows[0].params, ['email', 'password']);
  const replay = await manager.runFlow('login', opened.tab.id, 'sign-in', { email: 'new@example.test', password: 'new-secret' });
  assert.equal(replay.failedAt, undefined); assert.match(replay.text, /new@example.test/); assert.ok(!replay.text.includes('new-secret'));
  const tab = manager.get('login', opened.tab.id), handle = await manager.target(tab, { target: 'the Email box', kind: 'type' });
  assert.ok(await handle.boundingBox()); await handle.dispose();
});

test('ambiguous targets return candidates, checks stop failed batches, and old targets still work', { timeout: 20000 }, async t => {
  const { manager, url } = await fixture(t), { tab: { id } } = await manager.open('ambiguity', { url: `${url}/ambiguous` });
  const result = await manager.run('ambiguity', id, { actions: [{ click: 'the Send button' }, { type: 'Never', into: 'Search' }] });
  assert.equal(result.failedAt, 0); assert.equal(result.candidates.filter(e => e.score > 0).length, 2); assert.match(result.error, /ambiguous/);
  assert.equal(await manager.get('ambiguity', id).page.evaluate(() => window.clicked), undefined);
  const direct = await manager.run('ambiguity', id, { kind: 'click', target: 'the Send button' }); assert.equal(direct.candidates.filter(e => e.score > 0).length, 2);
  const fixed = await manager.run('ambiguity', id, { actions: [{ click: result.candidates[0].ref }, { check: 'Unknown text' }, { type: 'Never', into: 'Search' }], save_as: 'bad' });
  assert.equal(fixed.failedAt, 1); assert.equal(fixed.check.pass, false); assert.deepEqual((await manager.listFlows('ambiguity')).flows, []);
  await manager.run('ambiguity', id, { kind: 'type', selector: 'input', text: 'Old selector' });
  await manager.run('ambiguity', id, { kind: 'type', role: 'textbox', name: 'Search', text: 'Old role' });
  await manager.run('ambiguity', id, { kind: 'click', name: 'Bottom' });
  assert.equal((await manager.run('ambiguity', id, { check: 'the Search box' })).pass, true);
  assert.equal((await manager.run('ambiguity', id, { check: 'Missing', expect: false })).pass, true);
});

test('page reading includes state, same-origin frames and open shadow roots; budget and cap hold', { timeout: 20000 }, async t => {
  const { manager, url } = await fixture(t), opened = await manager.open('states', { url: `${url}/states` });
  const find = name => opened.elements.find(e => e.name === name);
  assert.equal(find('Remember').checked, true); assert.equal(find('Remember').disabled, true); assert.equal(find('Choice').role, 'radio');
  assert.equal(find('Menu').expanded, true); assert.equal(find('Inbox').selected, true); assert.equal(find('Power').checked, true); assert.equal(find('More').expanded, true);
  assert.equal(find('Name').value, undefined); assert.equal(opened.elements.find(e => e.role === 'textbox' && e.name === 'Name').value, 'Ada');
  assert.equal(find('Password').value, undefined); assert.ok(!opened.text.includes('private-password'));
  assert.ok(find('Shadow save')); assert.ok(find('Frame save')); assert.ok(find('Clickable')); assert.ok(opened.elements.some(e => e.role === 'option'));
  const actions = await manager.run('states', opened.tab.id, { actions: [{ type: 'Shadow', into: 'the Shadow name box', clear: true }, { type: 'Frame', into: 'the Frame name field', clear: true }, { click: 'the Frame save button' }] });
  assert.equal(actions.failedAt, undefined, actions.error);
  const tab = manager.get('states', opened.tab.id);
  assert.equal(await tab.page.frames()[1].evaluate(() => document.body.dataset.clicked), 'yes');
  const zero = await manager.look(tab, 0); assert.ok(zero.elements.length); assert.match(zero.text, /value="Shadow"/);
  await tab.page.evaluate(() => { document.body.innerHTML = '<p>' + 'x'.repeat(25000) + '</p>' + '<button>Extra</button>'.repeat(400); });
  const small = await manager.look(tab, 20); assert.equal(small.elements.length, 300); assert.ok(!small.text.includes('x'.repeat(21)));
});

test('type clear, append, enter, select, scroll and wait forms work on Chromium', { timeout: 20000 }, async t => {
  const { manager, url } = await fixture(t), { tab: { id } } = await manager.open('forms', { url: `${url}/states` });
  const result = await manager.run('forms', id, { actions: [{ type: 'Hello', into: 'the Name box', clear: true }, { type: ' world', into: 'the Name box' }, { select: 'the Country dropdown', option: 'US' }, { hover: 'the Menu button' }, { scroll: 'down', pages: 1 }, { scroll: 'up', pages: 1 }, { wait_for: 'Clickable' }, { check: 'the Inbox tab' }] });
  assert.equal(result.failedAt, undefined); assert.match(result.text, /value="Hello world"/); assert.match(result.text, /value="US"/);
  await manager.run('forms', id, { goto: url });
  const entered = await manager.run('forms', id, { actions: [{ type: 'Ada', into: 'the Email box', clear: true, enter: true }, { check: 'Signed in as Ada' }] });
  assert.equal(entered.failedAt, undefined); assert.match(entered.text, /Signed in as Ada/);
});

test('settling adds almost no time on a quiet static page and waits for fetched data; pending requests are capped', { timeout: 15000 }, async t => {
  const { manager, url } = await fixture(t), settle = manager.settle.bind(manager), times = [];
  manager.settle = async tab => { const before = performance.now(); await settle(tab); times.push(performance.now() - before); };
  const { tab: { id } } = await manager.open('timings', { url }), openMs = times.at(-1); times.length = 0;
  for (let i = 0; i < 5; i++) await manager.run('timings', id, { kind: 'click', selector: 'button[type=button]' });
  const staticMs = times.reduce((a, b) => a + b) / times.length; times.length = 0;
  const fetched = await manager.run('timings', id, { click: 'the Sign in button' }), fetchMs = times.at(-1);
  assert.match(fetched.text, /Signed in as Ada/); assert.ok(openMs < 50, `static open settle ${openMs}ms`); assert.ok(staticMs < 50, `static settle ${staticMs}ms`); assert.ok(fetchMs >= 150 && fetchMs < 1500, `fetch settle ${fetchMs}ms`);
  const before = performance.now(); await manager.run('timings', id, { click: 'the Pending button' }); const pendingMs = performance.now() - before;
  assert.ok(pendingMs >= 2900 && pendingMs < 4000, `pending request cap ${pendingMs}ms`);
  t.diagnostic(`settle timing: static open ${openMs.toFixed(1)} ms, static mean ${staticMs.toFixed(1)} ms (5 clicks), fetch ${fetchMs.toFixed(1)} ms (120 ms response + 150 ms quiet), pending cap ${pendingMs.toFixed(1)} ms`);
});
