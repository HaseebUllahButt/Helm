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
    const client = { subscribe() {}, on(fn) { window.emit = fn; return () => {}; }, rpc: window.rpc };
    function App() {
      const state = useSessionLog(client, 'machine', 'chat', { wholeChat: window.wholeChat ?? false });
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

async function chat(t, { page: pageSize = Infinity, wholeChat = false, initialReplies = 1 } = {}) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route('http://helm-test/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://helm-test/');
  const log = Array.from({ length: initialReplies }, (_, i) => reply(1 + i * 4, i + 1)).flat();
  await page.evaluate(value => { window.wholeChat = value; }, wholeChat);
  const calls = [];
  let hold;
  let olderHold;
  if (wholeChat) { let release, started; const gate = new Promise(r => { release = r; }); const waiting = new Promise(r => { started = r; }); olderHold = { gate, release, started, waiting }; t.after(release); }
  const holdNext = (pending = [], fail = false) => {
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const waiting = new Promise(resolve => { started = resolve; });
    hold = { gate, started, pending, fail };
    t.after(release);
    return { release, waiting };
  };
  const firstOlderHold = olderHold;
  await page.exposeFunction('rpc', async (_env, method, params = {}) => {
    const snapshot = [...log];
    const last = snapshot.at(-1).seq;
    if (method === 'session.watch') return { last };
    if (method === 'session.unwatch') return { ok: true };
    calls.push(params);
    if (params.before && olderHold) { const held = olderHold; olderHold = undefined; held.started(); await held.gate; }
    const held = hold; hold = undefined;
    if (held) { held.started(); await held.gate; if (held.fail) throw new Error('read failed'); }
    const shape = events => ({ events, last, pending: held?.pending ?? [], session: { status: 'idle' }, logFirst: 1 });
    if (params.tail) { const events = snapshot.slice(-params.tail); return { ...shape(events), firstSeq: events[0].seq }; }
    if (params.before) { const events = snapshot.filter(event => event.seq < params.before).slice(-200); return { ...shape(events), firstSeq: events[0]?.seq ?? 0 }; }
    const after = snapshot.filter(event => event.seq > params.since);
    // pageSize stands in for the machine's byte budget per page.
    const size = Math.min(params.limit, pageSize);
    return { ...shape(after.slice(0, size)), hasMore: after.length > size, firstSeq: after[0]?.seq ?? 0 };
  });
  await page.addScriptTag({ content: script });
  const texts = () => page.evaluate(() => window.state.log.turns.map(turn => turn.items.map(item => item.text).join('')));
  const settle = async () => page.waitForFunction(() => !window.state.syncing);
  await page.waitForFunction(() => window.state?.log.loaded);
  await settle();
  return { page, log, calls, texts, settle, holdNext, olderHold: firstOlderHold };
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

test('a gap of several pages is read page by page and keeps the chat behind it', async t => {
  const { page, log, calls, texts, settle } = await chat(t, { page: 50 });
  for (let n = 0; n < 60; n++) log.push(...reply(5 + n * 4, n + 2));
  const seen = calls.length;
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  await page.waitForFunction(last => window.state.log.last === last, log.at(-1).seq);
  await settle();
  const reads = calls.slice(seen);
  assert.ok(reads.every(call => !call.tail), JSON.stringify(reads));
  assert.ok(reads.filter(call => call.since).length >= 5, 'it read each page');
  const shown = await texts();
  assert.equal(shown.length, 61);
  assert.equal(shown[0], 'Answer 1', 'the first reply is still there');
});

test('a very long gap, or a reset log, opens at the end again', async t => {
  const { page, log, calls, settle } = await chat(t, { page: 10 });
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


test('live replies appear while a history check waits, and its old reply cannot erase them', async t => {
  const { page, calls, texts, settle, holdNext } = await chat(t);
  const held = holdNext();
  await page.evaluate(() => { void window.state.refresh(); });
  await held.waiting;
  const events = reply(5, 2);
  await page.evaluate(events => window.emit('machine', 'session.event', { id: 'chat', events }), events);
  await page.waitForFunction(() => window.state.log.last === 8, undefined, { timeout: 2000 });
  assert.deepEqual(await texts(), ['Answer 1', 'Answer 2']);
  held.release();
  await settle();
  assert.deepEqual(await texts(), ['Answer 1', 'Answer 2']);
  assert.equal(calls.length, 2);
});

test('repeated online notices do not queue more history reads behind a slow read', async t => {
  const { page, calls, settle, holdNext } = await chat(t);
  const held = holdNext();
  await page.evaluate(() => { void window.state.refresh(); });
  await held.waiting;
  for (let n = 0; n < 4; n++) {
    await page.evaluate(() => window.emit('machine', 'presence', { online: true }));
  }
  held.release();
  await settle();
  assert.equal(calls.length, 2);
});


const visibility = (page, hidden) => page.evaluate(hidden => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
  document.dispatchEvent(new Event('visibilitychange'));
}, hidden);

test('showing an idle chat again finishes a history check hidden mid-flight', async t => {
  const { page, holdNext, settle } = await chat(t);
  const held = holdNext();
  await page.evaluate(() => { void window.state.refresh(); });
  await held.waiting;
  await visibility(page, true); await visibility(page, false);
  held.release();
  await settle();
  assert.equal(await page.evaluate(() => window.state.error), '');
});

test('showing an idle chat retries a failed history check', async t => {
  const { page, holdNext, settle } = await chat(t);
  const held = holdNext([], true);
  await page.evaluate(() => { void window.state.refresh(); });
  await held.waiting; held.release();
  await page.waitForFunction(() => !!window.state.error);
  await visibility(page, true); await visibility(page, false);
  await settle();
  assert.equal(await page.evaluate(() => window.state.error), '');
});

test('an older history reply keeps its unanswered question and does not restore a resolved one', async t => {
  const { page, holdNext, settle } = await chat(t);
  const held = holdNext([{ requestId: 'open', text: 'Approve?' }, { requestId: 'done', text: 'Already answered' }]);
  await page.evaluate(() => { void window.state.refresh(); });
  await held.waiting;
  await page.evaluate(() => window.emit('machine', 'session.event', { id: 'chat', events: [
    { seq: 5, type: 'permission.resolved', requestId: 'done' },
    { seq: 6, type: 'status', status: 'working' },
  ] }));
  await page.waitForFunction(() => window.state.log.last === 6);
  held.release(); await settle();
  assert.deepEqual(await page.evaluate(() => window.state.log.pending.map(p => p.requestId)), ['open']);
  assert.equal(await page.evaluate(() => window.state.log.status), 'working');
});


test('showing a chat publishes a final event hidden before its redraw', async t => {
  const { page, log, texts } = await chat(t);
  await page.clock.install();
  const events = [
    { seq: 5, type: 'item.delta', id: 'a1', text: ' final' },
    { seq: 6, type: 'status', status: 'working' },
    { seq: 7, type: 'permission.request', requestId: 'question', title: 'Approve?', kind: 'command' },
  ];
  log.push(...events);
  await page.evaluate(events => {
    window.emit('machine', 'session.event', { id: 'chat', events });
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, events);
  await visibility(page, false);
  await page.waitForFunction(() => window.state.log.last === 7);
  assert.deepEqual(await page.evaluate(() => window.state.log.pending.map(p => p.requestId)), ['question']);
  assert.deepEqual(await texts(), ['Answer 1 final']);
  assert.equal(await page.evaluate(() => window.state.log.status), 'working');
});

test('showing an idle chat resumes older pages stopped while hidden', async t => {
  const { page, olderHold: held, calls } = await chat(t, { initialReplies: 110, wholeChat: true });
  await held.waiting;
  await visibility(page, true); held.release();
  await page.waitForFunction(() => !window.state.loadingEarlier);
  await visibility(page, false);
  await page.waitForFunction(() => window.state.log.turns.length === 110);
  assert.ok(calls.filter(p => p.before).length >= 2);
});
