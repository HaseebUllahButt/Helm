import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

// The owner reads whole chats on the phone to learn from them: after the
// latest screen, the rest of the chat arrives on its own and stays saved.
let browser, script, css;
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { useSessionLog } from './apps/web/src/session/useSessionLog';
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

test('the rest of a chat follows the latest screen without a tap', async t => {
  const { page, calls } = await open(t);
  await whole(page);
  assert.ok(calls[0].tail, 'the latest screen is read first');
  const pages = calls.filter(c => c.before);
  assert.equal(pages.length, Math.ceil((TURNS - 1) / 2));
  assert.ok(pages.every(c => c.pageBytes === 1_000_000), 'background pages are big ones');
  assert.equal(await page.locator('.turn.user').count(), TURNS);
  assert.equal(await page.getByRole('button', { name: 'Earlier in this chat' }).count(), 0);
});

test('a failed background page shows no error, and a tap on the button carries on to the start', async t => {
  const { page, calls } = await open(t, { fail: 1 });
  await page.waitForFunction(() => window.state?.log.loaded && window.state.earlier && !window.state.loadingEarlier);
  assert.equal(await page.locator('.error, [role="alert"]').count(), 0);
  assert.equal(calls.filter(c => c.before).length, 1);
  await page.getByRole('button', { name: 'Earlier in this chat', exact: true }).click();
  await whole(page);
});

test('a whole chat saved on the device is not fetched again', async t => {
  const first = await open(t);
  await whole(first.page);
  // Let the save land, then come back to the chat in a fresh page.
  await first.page.waitForTimeout(500);
  await first.page.close();
  const again = await open(t, { context: first.context });
  await whole(again.page);
  await again.page.waitForTimeout(500);
  assert.equal(again.calls.filter(c => c.before).length, 0);
  assert.equal(await again.page.locator('.turn.user').count(), TURNS);
  t.after(() => first.context.close());
});

test('older pages arriving above keep the reader on the same words', async t => {
  const { page } = await open(t, { slow: 400 });
  await page.waitForFunction(() => window.state?.log.loaded && document.querySelectorAll('.turn').length);
  const where = () => page.evaluate(() => {
    const chat = document.querySelector('.chat'), top = chat.getBoundingClientRect().top;
    const node = [...chat.querySelectorAll('.turn.user')].at(-1);
    return { text: node.innerText.slice(0, 12), y: Math.round(node.getBoundingClientRect().top - top) };
  });
  await page.evaluate(() => { const chat = document.querySelector('.chat'); chat.scrollTop = Math.max(0, chat.scrollHeight - chat.clientHeight - 300); });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.state.loadingEarlier || window.state.earlier), true, 'older pages are still on their way');
  const before = await where();
  await whole(page);
  await page.waitForTimeout(100);
  assert.deepEqual(await where(), before);
});

test('a catch-up read that brings nothing new leaves every message as it was', async t => {
  const { page } = await open(t);
  await whole(page);
  await page.evaluate(() => { window.kept = window.state.log.turns.slice(); });
  await page.evaluate(() => window.state.refresh());
  await page.waitForFunction(() => !window.state.syncing);
  const same = await page.evaluate(() => window.state.log.turns.every((turn, i) => turn === window.kept[i]) && window.state.log.turns.length === window.kept.length);
  assert.equal(same, true, 'no message was rebuilt, so none is redrawn');
});
