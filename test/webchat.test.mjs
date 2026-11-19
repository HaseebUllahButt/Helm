import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-webchat-'));
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));

const { SITES, siteFor } = await import('../packages/connect/src/webchat/sites/index.js');
const { webchatProfile, addWebchat, listWebchat, removeWebchat } = await import('../packages/connect/src/webchat/accounts.js');
const { webchatConfig, webchatModels } = await import('../packages/connect/src/webchat/config.js');
const { askSite, withHistory, sameConversation } = await import('../packages/connect/src/webchat/turn.js');
const { browserFor, runWebchatWorker } = await import('../packages/connect/src/webchat/worker.js');
const { WebchatDriver, siteText } = await import('../packages/connect/src/drivers/webchat.js');
const { runWebchatCommand } = await import('../packages/connect/src/webchat-cli.js');
const { accountKey } = await import('../packages/connect/src/settings.js');
const { materialize } = await import('../packages/connect/src/profiles.js');
const { ENGINES } = await import('../packages/connect/src/engines.js');
const { DRIVERS } = await import('../packages/connect/src/session-wire.js');
const { webchatNote } = await import('../packages/connect/src/delegation.js');
const { USAGE, commandHelp } = await import('../packages/connect/src/help.js');

const FIXTURES = new URL('./fixtures/webchat/', import.meta.url);
const store = () => { let saved = { profiles: [{ id: 'claude', engine: 'claude', env: {} }] }; return { load: () => saved, save: (profiles) => { saved = { profiles }; } }; };

test('a web chat account is a Helm account with its own key, model and settings', () => {
  const p = webchatProfile('neon', { site: 'gemini', profile: 'test', model: 'Neon', temporary: true, machine: 'Laptop' });
  assert.equal(p.engine, 'webchat');
  assert.equal(p.source, 'custom');
  assert.deepEqual(webchatConfig(materialize(p).env), { site: 'gemini', profile: 'test', model: 'Neon', machine: 'Laptop', temporary: true });
  assert.deepEqual(webchatModels(materialize(p).env), { default: 'Neon', models: ['Neon'] });
  assert.deepEqual(webchatModels({}), { default: null, models: [] });
  // Two web chat accounts are two accounts, not aliases of one.
  assert.notEqual(accountKey(p), accountKey(webchatProfile('gpt', { site: 'chatgpt', profile: 'test' })));
  assert.equal(ENGINES.webchat.driver, 'webchat');
  assert.equal(DRIVERS.webchat, WebchatDriver);
  assert.throws(() => webchatProfile('bad name', { site: 'gemini', profile: 'test' }), /letters, digits/);
  assert.throws(() => webchatProfile('x', { site: 'bing', profile: 'test' }), /Unknown site "bing"/);
  assert.throws(() => webchatProfile('x', { site: 'gemini' }), /--profile/);
});

test('add, list and remove keep other accounts as they are', () => {
  const s = store();
  assert.equal(addWebchat('neon', { site: 'gemini', profile: 'test' }, s).replaced, false);
  assert.equal(addWebchat('neon', { site: 'gemini', profile: 'test', model: 'Neon' }, s).replaced, true);
  assert.deepEqual(listWebchat(s).map((a) => [a.id, a.model]), [['neon', 'Neon']]);
  assert.throws(() => addWebchat('claude', { site: 'gemini', profile: 'test' }, s), /not a web chat/);
  assert.throws(() => removeWebchat('claude', s), /not a web chat account/);
  assert.equal(removeWebchat('neon', s).id, 'neon');
  assert.deepEqual(s.load().profiles.map((p) => p.id), ['claude']);
  assert.throws(() => removeWebchat('neon', s), /no account "neon"/);
});

test('helm webchat add, list and remove on this machine', async () => {
  const lines = [];
  const print = (l) => lines.push(l);
  await runWebchatCommand(['add', 'neon', '--site', 'gemini', '--profile', 'test', '--model', 'Neon', '--temporary'], { print, machine: (n) => n });
  await runWebchatCommand(['list', '--json'], { print });
  assert.deepEqual(JSON.parse(lines.at(-1)).accounts[0], { id: 'neon', site: 'gemini', siteLabel: 'Gemini', profile: 'test', model: 'Neon', machine: null, temporary: true });
  await runWebchatCommand(['remove', 'neon'], { print });
  await runWebchatCommand(['list'], { print });
  assert.match(lines.at(-1), /No web chat accounts/);
  await assert.rejects(runWebchatCommand(['add', 'neon', '--profile', 'test'], { print }), /--site/);
  assert.match(commandHelp('webchat', USAGE), /helm webchat add <account>/);
  assert.match(commandHelp('webchat', USAGE), /cannot use tools, files or commands/);
});

test('agents learn about web chat accounts only when there are some', () => {
  assert.equal(webchatNote([]), '');
  assert.match(webchatNote([webchatProfile('neon', { site: 'gemini', profile: 'test' })]), /neon are signed-in web chats\. They only answer questions/);
});

test('small helpers: history, conversation addresses and agent message headers', () => {
  assert.equal(withHistory('Q2', []), 'Q2');
  assert.match(withHistory('Q2', [{ q: 'Q1', a: 'A1' }]), /^Earlier in this conversation:\n\nQuestion: Q1\nAnswer: A1\n\nNow answer this:\nQ2$/);
  assert.ok(sameConversation('https://gemini.google.com/app/abc?hl=en', 'https://gemini.google.com/app/abc/'));
  assert.ok(!sameConversation('https://gemini.google.com/app', 'https://gemini.google.com/app/abc'));
  for (const site of Object.values(SITES)) assert.ok(new RegExp(site.conversation).test(site.id === 'gemini' ? 'https://gemini.google.com/app/1f2e' : site.id === 'chatgpt' ? 'https://chatgpt.com/c/68a-1' : 'https://claude.ai/chat/9a-b'), site.id);
  assert.equal(siteText('[Helm agent message 0af3]\nFrom Lead (m/x).\nThis is a message.\nIf a reply is needed, send it.\n\nAnd in French?'), 'And in French?');
  assert.equal(siteText('plain question'), 'plain question');
});

// ---------------------------------------------------------------- saved pages in a real browser

async function fixtureBrowser(t) {
  const { BrowserManager } = await import('../packages/connect/src/browser.js');
  const { createBrowserRoutes } = await import('../packages/connect/src/browser-routes.js');
  const { systemChromium } = await import('../packages/connect/src/browser-window.js');
  const { chromium } = await import('playwright');
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const file = path === '/fake-chat.js' ? 'fake-chat.js' : path.startsWith('/signed-out') ? 'signed-out.html' : `${path.split('/')[1]}.html`;
    try {
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/html');
      res.end(readFileSync(new URL(file, FIXTURES)));
    } catch { res.statusCode = 404; res.end('missing'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const launch = async () => { const path = process.env.HELM_TEST_CHROMIUM || systemChromium(); return chromium.launch({ headless: true, ...(path ? { executablePath: path } : {}) }); };
  const manager = new BrowserManager({ directory: join(process.env.HELM_DIR, 'browser'), session: (id) => ({ id }), launch, canWindow: false });
  const routes = createBrowserRoutes({ manager, sessions: { get: (id) => ({ id }) } });
  t.after(async () => { await manager.stop(); await new Promise((resolve) => server.close(resolve)); });
  const rpc = (_env, method, params) => routes.dispatch(method, params);
  const browser = (chat) => browserFor({ rpc, self: () => 'here', findSession: async () => null, machine: (n) => n, sessionId: chat });
  const local = (id) => {
    const site = siteFor(id);
    const at = (u) => u && u.replace(/^https:\/\/[^/]+\/?/, `${base}/${id}/`);
    return { ...site, home: id === 'gemini' ? `${base}/gemini/app` : at(site.home), temporaryUrl: at(site.temporaryUrl),
      conversation: `^${base}/${id}/${{ gemini: 'app', chatgpt: 'c', claude: 'chat' }[id]}/[\\w-]+` };
  };
  const page = async (chat, tab, script) => (await routes.dispatch('browser.action', { id: chat, tabId: tab, action: { kind: 'evaluate', script, look: false } })).value;
  return { base, browser, local, page, manager };
}

const quick = { pollMs: 150, retryMs: 2000 };

test('each site file asks, chooses the model and continues the same conversation', { timeout: 120_000 }, async (t) => {
  const f = await fixtureBrowser(t);
  const models = { gemini: 'Neon', chatgpt: 'GPT-5 Thinking', claude: 'Opus 5.5' };
  for (const id of ['gemini', 'chatgpt', 'claude']) {
    const chat = `chat-${id}`, site = f.local(id), b = await f.browser(chat);
    const progress = [];
    const first = await askSite(b, { site, question: `Hello from ${id}`, model: models[id], ...quick, onProgress: (p) => progress.push(p) });
    assert.equal(first.text, `Turn 1. Model ${models[id]}. You said: Hello from ${id}`, id);
    assert.match(first.conversation, new RegExp(site.conversation), id);
    assert.match(first.model, new RegExp(models[id]), id);
    assert.ok(progress[0].sent && progress[0].tab === first.tab, id);
    // The follow-up goes to the same tab and the same conversation.
    const second = await askSite(b, { site, question: 'And again?', model: models[id], conversation: first.conversation, tabId: first.tab, ...quick });
    assert.equal(second.text, `Turn 2. Model ${models[id]}. You said: And again?`, id);
    assert.equal(second.tab, first.tab);
    // With the tab gone, the saved address opens the conversation again.
    await f.manager.close(chat, first.tab);
    const third = await askSite(b, { site, question: 'Third', conversation: first.conversation, ...quick });
    assert.notEqual(third.tab, first.tab);
    assert.equal(await f.page(chat, third.tab, 'location.href'), first.conversation, id);
  }
});

test('a long question goes in pieces and arrives whole', { timeout: 60_000 }, async (t) => {
  const f = await fixtureBrowser(t);
  const b = await f.browser('long');
  const question = Array.from({ length: 900 }, (_, i) => `word${i} "quoted"\n`).join('');
  const r = await askSite(b, { site: f.local('chatgpt'), question, ...quick });
  assert.equal((await f.page('long', r.tab, 'window.asked[0]')).replace(/\s+/g, ' '), question.trim().replace(/\s+/g, ' '));
});

test('temporary chats: on before sending, kept in the same tab, and sent with history when the tab is gone', { timeout: 90_000 }, async (t) => {
  const f = await fixtureBrowser(t);
  for (const id of ['gemini', 'chatgpt', 'claude']) {
    const chat = `temp-${id}`, site = f.local(id), b = await f.browser(chat);
    const first = await askSite(b, { site, question: 'Secret one', temporary: true, ...quick });
    assert.equal(first.conversation, 'temporary', id);
    if (id === 'gemini') assert.equal(await f.page(chat, first.tab, 'window.temporary'), true);
    else assert.match(await f.page(chat, first.tab, 'location.href'), new RegExp(site.temporaryParam));
    const second = await askSite(b, { site, question: 'Secret two', temporary: true, conversation: 'temporary', tabId: first.tab, ...quick });
    assert.equal(second.restarted, false);
    assert.match(second.text, /^Turn 2\./, id);
    await f.manager.close(chat, first.tab);
    const third = await askSite(b, { site, question: 'Secret three', temporary: true, conversation: 'temporary', history: [{ q: 'Secret one', a: first.text }], ...quick });
    assert.equal(third.restarted, true, id);
    assert.match(third.text, /^Turn 1\. .*Earlier in this conversation: Question: Secret one/, id);
  }
});

test('a temporary chat that does not turn on sends nothing', { timeout: 60_000 }, async (t) => {
  const f = await fixtureBrowser(t);
  const b = await f.browser('no-temp');
  const site = { ...f.local('gemini'), temporaryButton: 'button[aria-label="No such button"]', temporaryOn: null };
  await assert.rejects(askSite(b, { site, question: 'x', temporary: true, ...quick }), /Could not turn on a temporary chat in Gemini\. Nothing was sent\./);
  const tabs = await b.tabs();
  assert.deepEqual(await f.page('no-temp', tabs[0].id, 'window.asked'), []);
});

test('a missing model and a signed-out profile are told plainly', { timeout: 60_000 }, async (t) => {
  const f = await fixtureBrowser(t);
  const b = await f.browser('errors');
  await assert.rejects(askSite(b, { site: f.local('gemini'), question: 'x', model: 'Ultra', ...quick }),
    /Could not choose the model "Ultra" in Gemini\. It offers: flash, neon\. Nothing was sent\./);
  const out = await f.browser('signed-out');
  await assert.rejects(askSite(out, { site: { ...f.local('gemini'), home: `${f.base}/signed-out` }, question: 'x', profile: null, ...quick }),
    /Gemini is signed out\. Sign in there, then send the question again\./);
});

test('a part of the answer shows while it is written; stop presses the site stop button', { timeout: 60_000 }, async (t) => {
  const f = await fixtureBrowser(t);
  const b = await f.browser('stop');
  let stop = false;
  const parts = [];
  const result = await askSite(b, { site: f.local('claude'), question: 'HOLD and write a long answer', ...quick,
    onProgress: (p) => { if (p.text) { parts.push(p.text); stop = true; } }, stopped: () => stop });
  assert.equal(result.stopped, true);
  // The part written so far was shown before the answer ended.
  assert.ok(parts.length && 'Turn 1.'.startsWith(parts[0]), parts[0]);
  assert.equal(await f.page('stop', result.tab, 'window.stopped'), true);
});

// ---------------------------------------------------------------- worker and driver

test('the worker uses another machine\'s browser as a guest of this chat', async () => {
  const calls = [];
  const b = await browserFor({ rpc: async (env, method, params) => { calls.push([env, method, params]); return { tabs: [] }; },
    self: () => 'me', findSession: async () => ({ session: { id: 'c1', title: 'Lead' } }), machine: () => 'laptop', sessionId: 'c1', machineName: 'Laptop' });
  await b.tabs();
  assert.equal(calls[0][0], 'laptop');
  assert.equal(calls[0][2].id, 'guest-me-c1');
  assert.deepEqual(calls[0][2].guest, { chat: 'c1', from: 'me', mode: null, title: 'Lead' });
});

test('the worker answers each ask in order and stops on request', async () => {
  const input = new PassThrough(), lines = [];
  const asks = [];
  let release;
  const ask = async (_b, o) => {
    asks.push(o);
    o.onProgress({ sent: true, tab: 't1' });
    o.onProgress({ text: 'part' });
    if (o.question === 'slow') { await new Promise((r) => { release = r; }); return { stopped: true, text: 'part', tab: 't1' }; }
    return { text: `answer to ${o.question}`, conversation: 'https://x/c/1', tab: 't1', model: 'M', restarted: false };
  };
  const env = { HELM_SESSION_ID: 'c1', HELM_WEBCHAT_SITE: 'gemini', HELM_WEBCHAT_PROFILE: 'test', HELM_WEBCHAT_MODEL: 'Neon', HELM_WEBCHAT_TEMPORARY: '1' };
  const done = runWebchatWorker({ rpc: async () => ({ tabs: [] }), self: () => 'me', findSession: async () => null, machine: (n) => n, env, input, write: (l) => lines.push(JSON.parse(l)), ask, stop: async () => true });
  input.write(`${JSON.stringify({ type: 'ask', turnId: 'turn-1', text: 'one', conversation: null })}\n`);
  input.write(`${JSON.stringify({ type: 'ask', turnId: 'turn-2', text: 'slow', conversation: 'https://x/c/1' })}\n`);
  await waitFor(() => release);
  input.write(`${JSON.stringify({ type: 'stop' })}\n`);
  release();
  input.end();
  await done;
  assert.deepEqual(lines.map((l) => `${l.type}:${l.turnId ?? ''}`), ['ready:', 'sent:turn-1', 'progress:turn-1', 'answer:turn-1', 'sent:turn-2', 'progress:turn-2', 'stopped:turn-2']);
  assert.equal(asks[0].model, 'Neon');
  assert.equal(asks[0].temporary, true);
  assert.equal(asks[1].tabId, 't1');
  assert.equal(asks[1].conversation, 'https://x/c/1');
});

/** A process host that holds one fake worker, like terminals.js does. */
function fakeHost({ alive = false } = {}) {
  const host = new EventEmitter();
  host.written = [];
  let onData = () => {}, onExit = () => {};
  host.live = alive;
  host.hasProc = () => host.live;
  let backlog = '';
  host.openProc = async () => { host.live = true; backlog = `${JSON.stringify({ type: 'ready' })}\n`; };
  // Output from before a driver binds is replayed first, as the real host does.
  host.procPipe = () => ({ write: (d) => host.written.push(JSON.parse(d)), end: () => onExit({ code: 0 }), kill: () => onExit({ code: null, signal: 'SIGTERM' }),
    onData: (cb) => { onData = cb; if (backlog) { const b = backlog; backlog = ''; queueMicrotask(() => cb(b)); } }, onExit: (cb) => { onExit = cb; }, detach: () => {} });
  host.say = (m) => onData(`${JSON.stringify(m)}\n`);
  host.exit = (r) => onExit(r);
  return host;
}
const waitFor = async (check) => { for (let i = 0; i < 200; i++) { const v = check(); if (v) return v; await new Promise((r) => setTimeout(r, 5)); } throw new Error('timed out'); };

function driver(host, extra = {}) {
  const env = materialize(webchatProfile('neon', { site: 'gemini', profile: 'test', model: 'Neon', temporary: extra.temporary })).env;
  const d = new WebchatDriver({ cmd: 'helm', env, cwd: '/nowhere', procHost: host, procId: 'chat1', ...extra });
  const events = [];
  d.on('event', (e) => events.push(e));
  d.on('init', (i) => events.push({ type: 'init', ...i }));
  return { d, events };
}

test('the driver streams the answer, keeps the conversation and sends follow-ups to it', async () => {
  const host = fakeHost();
  const { d, events } = driver(host);
  await d.send('What is 2+2?');
  assert.deepEqual(host.written[0], { type: 'ask', turnId: host.written[0].turnId, text: 'What is 2+2?', conversation: null, tab: null, history: [] });
  // Helm needs an id at once; the site's address replaces it after the first answer.
  assert.match(d.engineSessionId, /^webchat-new-/);
  const turnId = host.written[0].turnId;
  host.say({ type: 'sent', turnId, tab: 'tab-1' });
  host.say({ type: 'progress', turnId, text: 'It is' });
  host.say({ type: 'progress', turnId, text: 'It' }); // a redraw: skipped
  host.say({ type: 'answer', turnId, text: 'It is 4.', conversation: 'https://gemini.google.com/app/abc', tab: 'tab-1', model: 'Neon' });
  d.flush();
  const text = events.filter((e) => e.type === 'item.delta').map((e) => e.text).join('');
  assert.equal(text, 'It is 4.');
  assert.deepEqual(events.filter((e) => e.type === 'turn.done').map((e) => e.status), ['ok']);
  assert.equal(d.engineSessionId, 'https://gemini.google.com/app/abc');
  assert.equal(events.at(-1).status, 'idle');
  await d.send('And 3+3?');
  assert.equal(host.written[1].conversation, 'https://gemini.google.com/app/abc');
  assert.equal(host.written[1].tab, 'tab-1');
  host.say({ type: 'error', turnId: host.written[1].turnId, message: 'Gemini is signed out.' });
  assert.equal(events.filter((e) => e.type === 'turn.done').at(-1).error, 'Gemini is signed out.');
});

test('the driver sends earlier answers when a temporary chat must start again', async () => {
  const host = fakeHost();
  const old = [
    { type: 'turn.start', turnId: 'turn-a', text: 'Q1' }, { type: 'item.start', id: 'i1', kind: 'text', turnId: 'turn-a' },
    { type: 'item.delta', id: 'i1', text: 'A' }, { type: 'item.delta', id: 'i1', text: '1' }, { type: 'turn.done', turnId: 'turn-a', status: 'ok' },
    { type: 'turn.start', turnId: 'turn-b', text: 'Q2' }, { type: 'turn.done', turnId: 'turn-b', status: 'error' },
  ];
  const { d, events } = driver(host, { temporary: true, engineSessionId: 'temporary', resumeEvents: () => old });
  await d.send('Q3');
  assert.equal(host.written[0].conversation, 'temporary');
  assert.deepEqual(host.written[0].history, [{ q: 'Q1', a: 'A1' }]);
  const turnId = host.written[0].turnId;
  host.say({ type: 'sent', turnId, tab: 't', restarted: true });
  host.say({ type: 'answer', turnId, text: 'A3', conversation: 'temporary', restarted: true });
  d.flush();
  assert.match(events.filter((e) => e.type === 'item.delta').map((e) => e.text).join(''), /^\(The temporary chat was gone\. .*\)\n\nA3$/);
});

test('stop, a worker that dies, and a Helm restart in the middle of an answer', async () => {
  const host = fakeHost();
  const { d, events } = driver(host);
  await d.send('long');
  await d.interrupt();
  assert.deepEqual(host.written.at(-1), { type: 'stop' });
  host.say({ type: 'stopped', turnId: host.written[0].turnId });
  assert.equal(events.filter((e) => e.type === 'turn.done').at(-1).status, 'interrupted');

  await d.send('again');
  host.exit({ code: 1, stderr: 'boom' });
  assert.equal(events.filter((e) => e.type === 'turn.done').at(-1).error, 'The web chat worker stopped: boom.');

  // The worker outlives a restart: the new driver binds it and reads on.
  const kept = fakeHost({ alive: true });
  const next = driver(kept, { openTurn: () => 'turn-kept' });
  await next.d.start();
  assert.equal(next.events.find((e) => e.type === 'status').status, 'working');
  kept.say({ type: 'answer', turnId: 'turn-kept', text: 'Done after restart.' });
  next.d.flush();
  assert.equal(next.events.filter((e) => e.type === 'turn.done')[0].status, 'ok');
  assert.equal(next.events.filter((e) => e.type === 'item.delta').map((e) => e.text).join(''), 'Done after restart.');
  // A message Helm had not yet handed over is closed, not left open.
  const lost = driver(fakeHost({ alive: true }), { openTurn: () => 'local-123' });
  await lost.d.start();
  assert.match(lost.events.find((e) => e.type === 'turn.done').error, /restarted before this message reached the web chat/);
});
