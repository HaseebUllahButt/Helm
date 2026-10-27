import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

// An open chat catches up with what came after it, not the last 200 events again.
let browser, script;
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import { createRoot } from 'react-dom/client';
    import { useSessionLog } from './apps/web/src/session/useSessionLog';
    const client = { subscribe() {}, on() { return () => {}; }, rpc: window.rpc };
    function App() {
      const state = useSessionLog(client, 'machine', 'chat', { wholeChat: false });
      window.state = state;
      return null;
    }
    createRoot(document.getElementById('root')).render(<App />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
});
after(async () => browser?.close());

const reply = (seq, n) => [
  { seq, type: 'turn.start', turnId: `t${seq}`, text: `Question ${n}`, at: seq },
  { seq: seq + 1, type: 'item.start', id: `a${seq}`, turnId: `t${seq}`, kind: 'text', at: seq + 1 },
  { seq: seq + 2, type: 'item.delta', id: `a${seq}`, text: `Answer ${n}`, at: seq + 2 },
  { seq: seq + 3, type: 'turn.done', turnId: `t${seq}`, status: 'ok', at: seq + 3 },
];

async function chat(t) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route('http://helm-test/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://helm-test/');
  const log = [...reply(1, 1)];
  const calls = [];
  await page.exposeFunction('rpc', async (_env, method, params = {}) => {
    const last = log.at(-1).seq;
    if (method === 'session.watch') return { last };
    if (method === 'session.unwatch') return { ok: true };
    calls.push(params);
    const shape = events => ({ events, last, pending: [], session: { status: 'idle' }, logFirst: 1 });
    if (params.tail) { const events = log.slice(-params.tail); return { ...shape(events), firstSeq: events[0].seq }; }
    const after = log.filter(event => event.seq > params.since);
    return { ...shape(after.slice(0, params.limit)), hasMore: after.length > params.limit, firstSeq: after[0]?.seq ?? 0 };
  });
  await page.addScriptTag({ content: script });
  const texts = () => page.evaluate(() => window.state.log.turns.map(turn => turn.items.map(item => item.text).join('')));
  const settle = async () => page.waitForFunction(() => !window.state.syncing);
  await page.waitForFunction(() => window.state?.log.loaded);
  await settle();
  return { page, log, calls, texts, settle };
}

test('a focus after new replies asks only for the events after the last one shown', async t => {
  const { page, log, calls, texts, settle } = await chat(t);
  assert.ok(calls[0].tail, 'the first open reads the end of the chat');
  log.push(...reply(5, 2));
  const seen = calls.length;
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  await page.waitForFunction(() => window.state.log.last === 8);
  await settle();
  const reads = calls.slice(seen);
  assert.ok(reads.length >= 1);
  assert.ok(reads.every(call => call.since === 4 && !call.tail), JSON.stringify(reads));
  assert.deepEqual(await texts(), ['Answer 1', 'Answer 2']);
});

test('a gap wider than one page, or a reset log, opens at the end again', async t => {
  const { page, log, calls, settle } = await chat(t);
  for (let n = 0; n < 60; n++) log.push(...reply(5 + n * 4, n + 2));
  let seen = calls.length;
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  await page.waitForFunction(last => window.state.log.last === last, log.at(-1).seq);
  await settle();
  assert.ok(calls.slice(seen).some(call => call.since === 4), 'it tried what is new first');
  assert.ok(calls.slice(seen).some(call => call.tail), 'then read the end of the chat');

  const next = log.at(-1).seq + 1;
  log.push({ seq: next, type: 'history.reset', at: next }, ...reply(next + 1, 99));
  seen = calls.length;
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  await page.waitForFunction(last => window.state.log.last === last, log.at(-1).seq);
  await settle();
  assert.ok(calls.slice(seen).some(call => call.tail), 'a reset log is read from its end');
});
