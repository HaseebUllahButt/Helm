import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

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

const event = (seq, type, fields = {}) => ({ seq, type, at: Date.now() - 30_000 + seq, ...fields });
const start = event(1, 'turn.start', { turnId: 'long', text: 'One long request' });
const tools = Array.from({ length: 12 }, (_, index) => [
  event(2 + index * 2, 'item.start', { id: 'step-' + index, turnId: 'long', kind: 'tool', name: 'Read', input: { path: '/repo/older-' + index + '.ts' } }),
  event(3 + index * 2, 'item.done', { id: 'step-' + index, status: 'ok' }),
]).flat();

async function device(t, { width = 390, done = false, text = false, fail = false, previousTurn = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 650 } });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route('http://helm-test/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="root" style="height:100vh;display:flex;flex-direction:column;min-height:0"></div>' }));
  await page.goto('http://helm-test/');
  const answer = text ? [event(2, 'item.start', { id: 'answer', turnId: 'long', kind: 'text' }), event(3, 'item.delta', { id: 'answer', text: 'Older text. '.repeat(150) })] : [];
  const latest = text ? [event(100, 'item.delta', { id: 'answer', text: 'Recent answer. '.repeat(80) })] : tools.slice(-6);
  const end = done ? [...(text ? [] : [
    event(99, 'item.start', { id: 'final', turnId: 'long', kind: 'text' }),
    event(100, 'item.delta', { id: 'final', text: 'Finished the work.' }),
  ]), event(101, 'turn.done', { turnId: 'long', status: 'ok' })] : [];
  let failed = false;
  const calls = [];
  const shift = previousTurn ? 10 : 0;
  const older = previousTurn ? [
    event(1, 'turn.start', { turnId: 'previous', text: 'Previous question' }),
    event(2, 'item.start', { id: 'previous-answer', turnId: 'previous', kind: 'text' }),
    event(3, 'item.delta', { id: 'previous-answer', text: 'Previously hidden answer. '.repeat(100) }),
    event(4, 'turn.done', { turnId: 'previous', status: 'ok' }),
  ] : [];
  const last = (end.at(-1) ?? latest.at(-1)).seq + shift;
  await page.exposeFunction('rpc', async (_env, method, params = {}) => {
    if (method === 'session.watch') return { last };
    if (method === 'session.unwatch') return { ok: true };
    assert.equal(method, 'session.events');
    calls.push(params);
    if (params.before && fail && !failed) { failed = true; throw new Error('History disconnected'); }
    const earlier = params.before > 0;
    const pageEvents = params.since ? [] : earlier ? text ? [start, ...answer] : [start, ...tools.slice(0, -6)] : [start, ...answer.slice(0, 1), ...latest, ...end];
    const events = [...(earlier ? older : []), ...pageEvents.map(event => ({ ...event, seq: event.seq + shift }))];
    return { events, firstSeq: earlier ? 1 : (text ? 100 : 20) + shift, logFirst: 1, last, pending: [], session: { status: done ? 'idle' : 'working' } };
  });
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await page.waitForFunction(() => window.state?.log.loaded && !window.state.syncing);
  return { page, calls };
}

for (const done of [false, true]) for (const width of [390, 1280]) test(`loading earlier steps reveals them within the same ${done ? 'completed' : 'working'} turn at ${width}px`, async t => {
  const { page, calls } = await device(t, { done, width });
  await page.getByRole('button', { name: 'Earlier in this conversation', exact: true }).click();
  await page.waitForFunction(() => !window.state.loadingEarlier && !window.state.earlier);
  assert.equal(calls.filter(call => call.before).length, 1);
  const step = page.locator('[data-item-id="step-0"]');
  await step.waitFor({ state: 'visible', timeout: 1500 });
  const visible = await step.evaluate(el => {
    const box = el.closest('.chat').getBoundingClientRect(), rect = el.getBoundingClientRect();
    return rect.bottom > box.top && rect.top < box.bottom;
  });
  assert.ok(visible, 'the newly read step should be in the viewport');
});

test('loading the missing beginning of a long answer shows its older text', async t => {
  const { page } = await device(t, { text: true });
  await page.getByRole('button', { name: 'Earlier in this conversation', exact: true }).click();
  await page.waitForFunction(() => !window.state.loadingEarlier && !window.state.earlier);
  const chat = await page.locator('.chat').evaluate(el => ({ top: el.scrollTop, height: el.clientHeight }));
  assert.ok(chat.top < chat.height, 'the older beginning should be visible, rather than staying pinned to the recent ending');
  assert.match(await page.locator('.prose').innerText(), /^Older text/);
});

test('loading a previous exchange shows the new question at the top', async t => {
  const { page } = await device(t, { previousTurn: true });
  await page.getByRole('button', { name: 'Earlier in this conversation', exact: true }).click();
  await page.waitForFunction(() => !window.state.loadingEarlier && !window.state.earlier);
  assert.equal(await page.locator('.chat').evaluate(el => el.scrollTop), 0);
  assert.match(await page.locator('.turn.user').first().innerText(), /Previous question/);
});

test('a failed earlier read can be retried and clears its error after revealing history', async t => {
  const { page, calls } = await device(t, { fail: true });
  const button = page.getByRole('button', { name: 'Earlier in this conversation', exact: true });
  await button.click();
  await page.waitForFunction(() => window.state.error === 'History disconnected' && !window.state.loadingEarlier);
  assert.equal(await button.isEnabled(), true);
  await button.click();
  await page.locator('[data-item-id="step-0"]').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => window.state.error), '');
  assert.equal(calls.filter(call => call.before).length, 2);
});
