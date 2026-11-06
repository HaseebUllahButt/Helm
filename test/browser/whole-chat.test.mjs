import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

// Older history stays on the machine until the reader asks for it.
// Saved pages remain readable on the next visit.
let browser, script, css;
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { useSessionLog } from './apps/web/src/session/useSessionLog';
    import * as cache from './apps/web/src/session/logCache';
    window.cache = cache;
    import { Transcript } from './apps/web/src/session/Transcript';
    const client = { subscribe() {}, on() { return () => {}; }, rpc: window.rpc };
    function App() {
      const state = useSessionLog(client, 'machine', 'chat');
      window.state = state;
      return <Transcript turns={state.log.turns} status={state.log.status} loaded={state.log.loaded}
        earlier={state.earlier} loadingEarlier={state.loadingEarlier} onEarlier={state.loadEarlier} />;
    }
    createRoot(document.getElementById('root')).render(<App />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  script = bundle.outputFiles[0].text;
  css = (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '');
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
});
after(async () => browser?.close());

const TURNS = 12;
const events = Array.from({ length: TURNS }, (_, i) => {
  const at = i * 4 + 1, turnId = `turn-${i}`;
  return [
    { seq: at, at, type: 'turn.start', turnId, text: `Question ${i}` },
    { seq: at + 1, at, type: 'item.start', id: `answer-${i}`, turnId, kind: 'text' },
    { seq: at + 2, at, type: 'item.delta', id: `answer-${i}`, text: `Answer ${i}. `.repeat(150) },
    { seq: at + 3, at, type: 'turn.done', turnId, status: 'ok' },
  ];
}).flat();
const last = events.at(-1).seq;

async function open(t, { fail = 0, context, slow = 0 } = {}) {
  context ??= await browser.newContext({ viewport: { width: 390, height: 650 } });
  const page = await context.newPage();
  t.after(() => page.close());
  await page.route('http://helm-test/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="root" style="height:100vh;display:flex;flex-direction:column;min-height:0"></div>' }));
  await page.goto('http://helm-test/');
  const calls = [];
  let failures = fail;
  await page.exposeFunction('rpc', async (_env, method, params = {}) => {
    if (method === 'session.watch') return { last };
    if (method === 'session.unwatch') return { ok: true };
    assert.equal(method, 'session.events');
    calls.push(params);
    const reply = (list) => ({ events: list, firstSeq: list[0]?.seq ?? 0, logFirst: 1, last, pending: [], session: { status: 'idle' } });
    if (params.tail) return reply(events.slice(-4));
    if (params.before) {
      if (slow) await new Promise(r => setTimeout(r, slow));
      if (failures > 0) { failures--; throw new Error('History disconnected'); }
      return reply(events.filter(e => e.seq < params.before).slice(-8));
    }
    return reply([]);
  });
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  return { page, calls, context };
}
const whole = (page) => page.waitForFunction(() => window.state?.log.loaded && !window.state.earlier && !window.state.loadingEarlier
  && document.body.innerText.includes('Question 0'));

const ready = page => page.waitForFunction(() => window.state?.log.loaded && !window.state.syncing);
async function readAll(page) {
  while (await page.evaluate(() => window.state.earlier)) {
    await page.evaluate(() => window.state.loadEarlier());
    await page.waitForFunction(() => !window.state.loadingEarlier);
  }
}

test('opening a chat reads only its latest window; scrolling up reads one older page', async t => {
  const { page, calls } = await open(t);
  await ready(page);
  assert.ok(calls[0].tail);
  assert.equal(calls.filter(c => c.before).length, 0);
  await page.locator('.chat').evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 })); });
  await page.waitForFunction(() => window.state.log.turns.length > 1 && !window.state.loadingEarlier);
  assert.equal(calls.filter(c => c.before).length, 1);
  assert.equal(calls.find(c => c.before).pageBytes, undefined);
  await readAll(page);
  await whole(page);
  assert.equal(await page.locator('.turn.user').count(), TURNS);
});

test('a failed older page can be retried without downloading the rest of the chat', async t => {
  const { page, calls } = await open(t, { fail: 1 });
  await ready(page);
  await page.getByRole('button', { name: 'Earlier in this chat', exact: true }).click();
  await page.waitForFunction(() => window.state.error && !window.state.loadingEarlier);
  await page.getByRole('button', { name: 'Earlier in this chat', exact: true }).click();
  await page.waitForFunction(() => !window.state.error && window.state.log.turns.length === 3);
  assert.equal(calls.filter(c => c.before).length, 2);
});

test('older pages saved on the device do not need another network read', async t => {
  const first = await open(t);
  await ready(first.page);
  await readAll(first.page);
  await first.page.waitForFunction(async () => (await window.cache.loadCached('machine', 'chat'))?.first === 1);
  await first.page.close();
  const again = await open(t, { context: first.context });
  await whole(again.page);
  assert.equal(again.calls.filter(c => c.before).length, 0);
  assert.equal(await again.page.locator('.turn.user').count(), TURNS);
  t.after(() => first.context.close());
});

test('a catch-up read that brings nothing new leaves every message as it was', async t => {
  const { page } = await open(t);
  await ready(page);
  await readAll(page);
  await page.evaluate(() => { window.kept = window.state.log.turns.slice(); });
  await page.evaluate(() => window.state.refresh());
  await page.waitForFunction(() => !window.state.syncing);
  assert.equal(await page.evaluate(() => window.state.log.turns.every((turn, i) => turn === window.kept[i])
    && window.state.log.turns.length === window.kept.length), true);
});
