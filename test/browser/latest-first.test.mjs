import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

let browser, script;
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { useSessionLog } from './apps/web/src/session/useSessionLog';
    import * as cache from './apps/web/src/session/logCache';
    const listeners = new Set();
    const client = { subscribe() {}, on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      rpc: async (_env, method, params) => { window.calls.push({ method, params }); return window.reply(method, params); } };
    window.emit = events => listeners.forEach(fn => fn('machine', 'session.event', { id: 'chat', events }));
    window.renders = 0;
    function Probe() {
      const state = useSessionLog(client, 'machine', 'chat', { wholeChat: window.wholeChat === true });
      window.state = state; window.renders++;
      return <><output>{state.log.turns.flatMap(t => t.items).filter(i => i.kind === 'text').map(i => i.text).join('')}</output>
        <button onClick={state.loadEarlier}>Earlier</button></>;
    }
    const root = createRoot(document.getElementById('root'));
    window.mount = () => root.render(<Probe />); window.unmount = () => root.render(null);
    window.cache = cache;
  `, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
});
after(async () => browser?.close());

async function device(t) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.route('http://helm-test/**', r => r.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://helm-test/');
  await page.evaluate(() => {
    window.calls = []; window.hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.hidden ? 'hidden' : 'visible' });
    window.visible = value => { window.hidden = !value; document.dispatchEvent(new Event('visibilitychange')); };
    window.events = (from, text) => [
      { seq: from, at: from, type: 'turn.start', turnId: 'turn-' + from, text: 'Question' },
      { seq: from + 1, at: from + 1, type: 'item.start', turnId: 'turn-' + from, id: 'answer-' + from, kind: 'text' },
      { seq: from + 2, at: from + 2, type: 'item.delta', id: 'answer-' + from, text },
    ];
    window.latest = { events: window.events(1, 'Current reply'), firstSeq: 1, logFirst: 1, last: 3, pending: [], session: { status: 'working' } };
    window.reply = async method => method === 'session.events' ? window.latest : { last: window.latest.last, status: window.latest.session.status };
  });
  await page.addScriptTag({ content: script });
  return page;
}
const ready = page => page.waitForFunction(() => window.state?.log.loaded && !window.state.syncing);

test('a saved chat opens at the latest reply without replaying missed events', async t => {
  const page = await device(t);
  await page.evaluate(async () => {
    await window.cache.saveCached('machine', 'chat', 3, window.events(1, 'Saved reply'), 1);
    window.latest = { ...window.latest, events: window.events(10000, 'Latest finished reply'), firstSeq: 10000, last: 10002, session: { status: 'idle' } };
    window.reply = async method => method === 'session.events' ? new Promise(resolve => { window.release = () => resolve(window.latest); }) : { last: 10002 };
    window.mount();
  });
  await page.waitForFunction(() => window.release && document.querySelector('output').textContent === 'Saved reply');
  await page.evaluate(() => window.release());
  await ready(page);
  assert.equal(await page.locator('output').innerText(), 'Latest finished reply');
  const reads = await page.evaluate(() => window.calls.filter(c => c.method === 'session.events'));
  assert.equal(reads.length, 1);
  assert.equal(reads[0].params.tail, 200);
  assert.ok(reads.every(c => !c.params.since));
  assert.equal(await page.evaluate(() => window.state.earlier), true);
});

test('hidden chats release their stream and resume with one latest read and current questions', async t => {
  const page = await device(t);
  await page.evaluate(() => window.mount()); await ready(page);
  await page.evaluate(() => {
    window.visible(false);
    window.emit(Array.from({ length: 10000 }, (_, i) => ({ seq: i + 4, at: i, type: 'item.delta', id: 'answer-1', text: 'unattended' })));
    window.latest = { ...window.latest, events: window.events(20000, 'Now waiting for you'), firstSeq: 20000, last: 20002,
      pending: [{ requestId: 'ask-now', kind: 'question', title: 'Choose now' }], session: { status: 'blocked' } };
  });
  assert.equal(await page.evaluate(() => window.state.log.last), 3);
  assert.equal(await page.evaluate(() => window.calls.filter(c => c.method === 'session.unwatch').length), 1);
  await page.evaluate(() => window.visible(true)); await ready(page);
  assert.equal(await page.locator('output').innerText(), 'Now waiting for you');
  assert.deepEqual(await page.evaluate(() => ({ status: window.state.log.status, asks: window.state.log.pending.map(p => p.requestId) })), { status: 'blocked', asks: ['ask-now'] });
  const reads = await page.evaluate(() => window.calls.filter(c => c.method === 'session.events'));
  assert.equal(reads.length, 2);
  assert.ok(reads.every(c => c.params.tail === 200 && !c.params.since));
});

test('returning during delayed watch and history replies renews the stream and rejects stale text', async t => {
  const page = await device(t);
  await page.evaluate(() => {
    const stale = window.latest;
    let watches = 0, reads = 0;
    window.reply = async method => {
      if (method === 'session.watch' && ++watches === 1) return new Promise(resolve => {
        window.releaseWatch = () => resolve({ last: stale.last });
      });
      if (method === 'session.events' && ++reads === 1) return new Promise(resolve => {
        window.releaseHistory = () => resolve(stale);
      });
      return method === 'session.events' ? window.latest : { last: window.latest.last };
    };
    window.mount();
  });
  await page.waitForFunction(() => window.releaseWatch && window.releaseHistory);
  await page.evaluate(() => {
    window.visible(false);
    window.latest = { ...window.latest, events: window.events(10000, 'Current work'), firstSeq: 10000, last: 10002 };
    window.visible(true);
    window.releaseHistory(); window.releaseWatch();
  });
  await ready(page);
  assert.equal(await page.locator('output').innerText(), 'Current work');
  const counts = await page.evaluate(() => ({
    watches: window.calls.filter(c => c.method === 'session.watch').length,
    releases: window.calls.filter(c => c.method === 'session.unwatch').length,
    reads: window.calls.filter(c => c.method === 'session.events').length,
  }));
  assert.deepEqual(counts, { watches: 2, releases: 1, reads: 2 });
});

test('older details load only on request while live reply order stays intact', async t => {
  const page = await device(t);
  await page.evaluate(() => {
    window.latest = { ...window.latest, events: window.events(100, 'Recent reply'), firstSeq: 100, last: 102 };
    window.reply = async (method, p) => method !== 'session.events' ? { last: 102 } : p.before
      ? { ...window.latest, events: window.events(1, 'Older reply'), firstSeq: 1 } : window.latest;
    window.mount();
  });
  await ready(page);
  assert.equal(await page.locator('output').innerText(), 'Recent reply');
  assert.equal(await page.evaluate(() => window.calls.some(c => c.params.before)), false);
  await page.getByRole('button', { name: 'Earlier' }).click();
  await page.waitForFunction(() => !window.state.loadingEarlier && !window.state.earlier);
  await page.evaluate(() => window.emit([{ seq: 103, at: 103, type: 'item.delta', id: 'answer-100', text: ' and live' }]));
  await page.waitForFunction(() => document.querySelector('output').textContent.includes('and live'));
  assert.equal(await page.locator('output').innerText(), 'Older replyRecent reply and live');
});

test('real React batches a reply burst and saves pending text when the chat closes', async t => {
  const page = await device(t);
  await page.evaluate(() => window.mount()); await ready(page);
  const before = await page.evaluate(() => window.renders);
  await page.evaluate(() => window.emit(Array.from({ length: 100 }, (_, i) => ({ seq: i + 4, at: i, type: 'item.delta', id: 'answer-1', text: 'x' }))));
  await page.waitForFunction(() => window.state.log.last === 103);
  assert.equal((await page.locator('output').innerText()).length, 'Current reply'.length + 100);
  assert.ok(await page.evaluate(() => window.renders) - before < 10, 'React must not draw each token separately');
  await page.evaluate(() => { window.emit([{ seq: 104, at: 104, type: 'item.delta', id: 'answer-1', text: 'saved on close' }]); window.unmount(); });
  await page.waitForFunction(async () => (await window.cache.loadCached('machine', 'chat'))?.last === 104);
  const cached = await page.evaluate(() => window.cache.loadCached('machine', 'chat'));
  assert.equal(cached.events.at(-1).text, 'saved on close');
});

test('text replaces a waiting tool redraw without changing event order', async t => {
  const page = await device(t);
  await page.evaluate(() => window.mount()); await ready(page);
  await page.clock.install(); await page.clock.pauseAt(new Date());
  const before = await page.evaluate(() => window.renders);
  await page.evaluate(() => window.emit([{ seq: 4, at: 4, type: 'item.start', turnId: 'turn-1', id: 'tool', kind: 'command', command: 'pwd' }]));
  await page.clock.runFor(20);
  assert.equal(await page.evaluate(() => window.renders), before);
  await page.evaluate(() => window.emit([{ seq: 5, at: 5, type: 'item.delta', id: 'answer-1', text: ' Read this now.' }]));
  await page.clock.runFor(20);
  assert.equal(await page.locator('output').innerText(), 'Current reply Read this now.');
  assert.deepEqual(await page.evaluate(() => window.state.log.turns[0].items.map(i => i.id)), ['answer-1', 'tool']);
});

test('a history reset drops old events from the saved device copy', async t => {
  const page = await device(t);
  await page.evaluate(() => window.mount()); await ready(page);
  await page.evaluate(() => { window.emit([{ seq: 4, at: 4, type: 'history.reset' }, ...window.events(5, 'Kept after rewind')]); window.unmount(); });
  await page.waitForFunction(async () => (await window.cache.loadCached('machine', 'chat'))?.last === 7);
  const cached = await page.evaluate(() => window.cache.loadCached('machine', 'chat'));
  assert.deepEqual(cached.events.map(e => e.seq), [4, 5, 6, 7]);
  assert.equal(cached.first, 4);
});
