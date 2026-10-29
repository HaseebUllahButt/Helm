import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { InputDelivery } from '../../packages/connect/src/input-delivery.js';

let browser, script;
before(async () => {
  const built = await build({ stdin: { contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {Client} from './apps/web/src/client';
    import {DrivenSession} from './apps/web/src/session/DrivenSession';
    import {DeliveryStatus} from './apps/web/src/session/DeliveryStatus';
    import {AppErrorBoundary} from './apps/web/src/AppErrorBoundary';
    class TestClient extends Client {
      input(env, params, timeout, id) { return super.input(env, params, window.sendTimeout ?? timeout, id); }
    }
    window.client = new TestClient([location.origin], 'phone');
    const root = createRoot(document.getElementById('root'));
    window.mount = (statusOnly = false) => root.render(<AppErrorBoundary>
      {statusOnly ? <><p>Chat remains open</p><DeliveryStatus client={window.client} env="pc" id="chat"/></> :
      <DrivenSession client={window.client} env={{id:'pc',name:'Laptop',online:true}}
        session={{id:'chat',engine:'codex',driver:'codex',status:'idle',cwd:'/project',title:'Chat'}}
        onBack={()=>{}} onClosed={()=>{}} onArchived={()=>{}} onSession={()=>{}} />}
      </AppErrorBoundary>);
    window.saveAction = (action) => localStorage.setItem('helm.pending-actions.phone.' + action.actionId, JSON.stringify(action));
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  script = built.outputFiles[0].text;
  browser = await chromium.launch({ headless: true,
    ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
});
after(() => browser?.close());

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'helm-delivery-ui-'));
  const state = { drop: false, reject: false, writeError: null, approvalError: null, inputs: 0, calls: [] };
  const delivery = new InputDelivery({ get: () => ({ driver: 'fake' }), turnState: () => null,
    input: async () => { state.inputs++; if (state.reject) throw Object.assign(new Error('The service refused this message.'), { code: 'delivery_failed' }); return { ok: true }; },
  }, { dir });
  const server = createServer(async (req, res) => {
    if (!req.url.startsWith('/api/')) { res.end('<div id="root"></div>'); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const call = body ? JSON.parse(body) : {};
    state.calls.push(call);
    res.setHeader('content-type', 'application/json');
    try {
      let result = {};
      if (req.url === '/api/action') {
        if (call.method === 'session.deliver' && state.writeError) throw Object.assign(new Error('Cannot accept this message.'), { code: state.writeError });
        if (call.method === 'session.answer-deliver' || call.params.kind === 'answer') result = { state:'done', error:state.approvalError };
        else result = call.method === 'session.deliver' ? await delivery.deliver(call.params, 'phone') : delivery.status(call.params.actionId, 'phone');
        if (state.drop) { res.destroy(); return; }
      } else if (call.method === 'session.events') result = { events: [], pending: [], last: 0, session: { status: 'idle' } };
      else if (call.method === 'session.messages') result = { messages: [], status: 'idle' };
      else if (call.method === 'model.list') result = { models: [] };
      res.end(JSON.stringify({ result }));
    } catch (error) {
      if (state.drop) { res.destroy(); return; }
      res.statusCode = 400; res.end(JSON.stringify({ error: error.message, code: error.code }));
    }
  });
  server.on('upgrade', (_req, socket) => socket.destroy());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = await browser.newPage(); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  t.after(async () => {
    await page.evaluate(() => window.client?.close()).catch(() => {});
    await page.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const load = async () => { await page.goto('http://127.0.0.1:' + server.address().port); await page.addScriptTag({ content: script }); };
  await load();
  return { page, state, load, delivery };
}

const action = (id = 'a'.repeat(32)) => ({ env: 'pc', method: 'session.deliver', actionId: id, started: true,
  params: { id: 'chat', data: 'Keep these words', references: [], attachments: [], messageId: id } });

test('real Client retries text with the original request after losing every receipt', async t => {
  const { page, state } = await fixture(t);
  state.drop = true;
  await page.evaluate(() => { window.sendTimeout = 600; window.mount(); });
  const box = page.locator('textarea'); await box.fill('Send exactly once');
  await page.getByRole('button', { name: 'send', exact: true }).click();
  const retry = page.locator('.failed-send').getByRole('button', { name: 'Retry send' });
  await retry.waitFor();
  const id = await page.evaluate(() => window.client.pendingActions()[0].actionId);
  state.drop = false;
  await page.evaluate(() => { window.sendTimeout = 120000; });
  await retry.click();
  await page.locator('.failed-send').waitFor({ state: 'detached' });
  assert.equal(await box.inputValue(), '');
  assert.equal(await page.evaluate(() => window.client.pendingActions().length), 0);
  assert.equal(state.inputs, 1);
  assert.equal(new Set(state.calls.filter(call => call.method === 'session.deliver').map(call => call.params.messageId)).size, 1);
  assert.match(id, /^[a-f0-9]{32}$/);
});

test('a final receipt after reload keeps the full failed message visible until dismissed', async t => {
  const { page, state, load, delivery } = await fixture(t);
  state.reject = true;
  const saved = action();
  saved.params.attachments = [{ filename: 'notes.txt', mime: 'text/plain', data: 'bm90ZXM=' }];
  await assert.rejects(delivery.deliver(saved.params, 'phone'));
  await page.evaluate(saved => window.saveAction(saved), saved);
  await load();
  await page.evaluate(() => window.mount(true));
  const failure = page.locator('.failed-delivery'); await failure.waitFor();
  assert.match(await failure.innerText(), /Keep these words/);
  assert.match(await failure.innerText(), /notes.txt/);
  assert.match(await failure.innerText(), /service refused/);
  assert.equal(await page.getByText('Checking delivery…', { exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.client.pendingActions().length), 0);
  assert.equal(await page.evaluate(() => window.client.failedActions()[0].params.attachments[0].data), 'bm90ZXM=');
  const calls = state.calls.length;
  await page.evaluate(() => window.client.resumeActions('pc', 'chat'));
  assert.equal(state.calls.length, calls, 'final failures do not replay');
  await load(); await page.evaluate(() => window.mount(true));
  await page.locator('.failed-delivery').waitFor();
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.locator('.failed-delivery').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.client.failedActions().length), 0);
});

test('an explicit initial rejection becomes a visible saved failure without a pending check', async t => {
  const { page, state } = await fixture(t); state.reject = true;
  await page.evaluate(() => { window.mount(true); window.result = window.client.input('pc', { id: 'chat', data: 'Rejected words' }).catch(error => ({code:error.code, retained:error.deliveryRetained})); });
  await page.locator('.failed-delivery').waitFor();
  assert.deepEqual(await page.evaluate(() => window.result), {code:'delivery_failed', retained:true});
  assert.equal(await page.evaluate(() => window.client.pendingActions().length), 0);
  const calls = state.calls.length;
  await page.evaluate(() => window.client.resumeActions('pc', 'chat'));
  assert.equal(state.calls.length, calls);
  assert.match(await page.locator('.failed-delivery').innerText(), /Rejected words/);
});

for (const damaged of ['json', 'shape', 'denied']) test(`saved storage ${damaged} keeps the chat open with a recovery message`, async t => {
  const { page } = await fixture(t);
  await page.evaluate(damaged => {
    if (damaged === 'json') localStorage.setItem('helm.pending-actions.phone.broken', '{');
    else if (damaged === 'shape') window.saveAction({env:'pc', method:'session.deliver', actionId:'a'.repeat(32), params:{id:'chat', data:{broken:true}, attachments:{broken:true}}});
    else Object.defineProperty(Storage.prototype, 'length', { configurable: true, get() { throw new DOMException('Denied', 'SecurityError'); } });
    window.mount(true);
  }, damaged);
  await page.getByText('Cannot read saved deliveries. Check this chat before sending again.', { exact: true }).waitFor();
  assert.equal(await page.getByText('Chat remains open', { exact: true }).count(), 1);
  assert.equal(await page.getByText('Helm cannot open this screen.', { exact: true }).count(), 0);
  if (damaged === 'json') assert.equal(await page.evaluate(() => localStorage.getItem('helm.pending-actions.phone.broken')), '{');
});

test('a late live turn still reaches the chat when saved receipt cleanup fails', async t => {
  const { page, state } = await fixture(t); state.drop = true;
  const saved = action();
  await page.evaluate(saved => {
    window.mount(true); window.received = [];
    window.client.on((_env, kind, payload) => { if (kind === 'session.event') window.received.push(payload); });
    window.delivery = window.client.input('pc', saved.params, 120000, saved.actionId);
  }, saved);
  await page.waitForFunction(() => window.client.pendingActions().length === 1);
  await page.evaluate(saved => {
    const original = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function(key) {
      if (key.startsWith('helm.pending-actions.')) throw new DOMException('Denied', 'SecurityError');
      return original.call(this, key);
    };
    const payload = { id: 'chat', events: [{ type: 'turn.start', messageId: saved.actionId, text: 'Keep these words' }] };
    window.client.deliver('pc', 'session.event', payload, 'late-receipt');
    window.client.deliver('pc', 'session.event', payload, 'late-receipt');
  }, saved);
  assert.equal((await page.evaluate(() => window.delivery)).confirmed, 'log');
  assert.equal(await page.evaluate(() => window.received.length), 1);
  assert.equal(await page.evaluate(() => window.client.pendingActions().length), 0);
  assert.equal(await page.evaluate(saved => JSON.parse(localStorage.getItem('helm.pending-actions.phone.' + saved.actionId)).params.data, saved), 'Keep these words');
  await page.getByText('Cannot clear saved deliveries. Check this chat before sending again.', { exact: true }).waitFor();
});

test('a full browser store keeps a final failure visible and recoverable after reload', async t => {
  const { page, state, delivery, load } = await fixture(t); state.reject = true;
  const saved = action();
  await assert.rejects(delivery.deliver(saved.params, 'phone'));
  await page.evaluate(saved => {
    window.saveAction(saved);
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('helm.pending-actions.')) throw new DOMException('Full', 'QuotaExceededError');
      return original.call(this, key, value);
    };
    window.mount(true);
  }, saved);
  await page.locator('.failed-delivery').waitFor();
  assert.match(await page.locator('.failed-delivery').innerText(), /Keep these words/);
  assert.equal(await page.evaluate(() => window.client.pendingActions().length), 0);
  await page.getByText('Cannot save the failed message. Keep this chat open to keep its words.', { exact: true }).waitFor();
  await load(); await page.evaluate(() => window.mount(true));
  await page.locator('.failed-delivery').waitFor();
  assert.match(await page.locator('.failed-delivery').innerText(), /Keep these words/);
  assert.equal(state.inputs, 1);
});

for (const code of ['invalid_argument', 'delivery_conflict']) test(`a final ${code} refusal keeps words without replay`, async t => {
  const { page, state } = await fixture(t); state.writeError = code;
  await page.evaluate(() => { window.mount(true); window.result = window.client.input('pc', { id: 'chat', data: 'Refused words' }).catch(error => ({ code:error.code, retained:error.deliveryRetained })); });
  await page.locator('.failed-delivery').waitFor();
  assert.deepEqual(await page.evaluate(() => window.result), { code, retained:true });
  assert.equal(await page.evaluate(() => window.client.pendingActions().length), 0);
  const calls = state.calls.length;
  await page.evaluate(() => window.client.resumeActions('pc', 'chat'));
  assert.equal(state.calls.length, calls);
  assert.match(await page.locator('.failed-delivery').innerText(), /Refused words/);
});

test('a receiver disk error stays uncertain until its saved receipt is known', async t => {
  const { page, state } = await fixture(t); state.writeError = 'ENOSPC';
  await page.evaluate(() => {
    window.mount(true);
    window.result = window.client.input('pc', { id:'chat', data:'Keep one delivery identity' }, 600).catch(error => ({ code:error.code, retained:!!error.deliveryRetained }));
  });
  assert.deepEqual(await page.evaluate(() => window.result), { code:'delivery_pending', retained:false });
  const id = await page.evaluate(() => window.client.pendingActions()[0].actionId);
  assert.equal(await page.evaluate(() => window.client.failedActions().length), 0);
  state.writeError = null;
  await page.evaluate(() => window.client.resumeActions('pc', 'chat'));
  assert.equal(await page.evaluate(() => window.client.pendingActions().length), 0);
  assert.equal(state.inputs, 1);
  assert.deepEqual([...new Set(state.calls.filter(call => call.method === 'session.deliver').map(call => call.params.messageId))], [id]);
});

for (const path of ['initial', 'saved']) test(`a final approval error from the ${path} path stays visible`, async t => {
  const { page, state } = await fixture(t);
  state.approvalError = { message:'This answer was refused.', code:'invalid_argument' };
  await page.evaluate(path => {
    window.mount(true);
    const params = { id:'chat', requestId:'ask', decision:{option:'allow'} };
    if (path === 'initial') window.answerResult = window.client.rpc('pc', 'session.answer', params).catch(error => ({message:error.message, retained:error.deliveryRetained, persisted:error.deliveryPersisted}));
    else {
      const actionId = 'b'.repeat(32);
      window.saveAction({ env:'pc', method:'session.answer-deliver', actionId, started:true, params:{...params, actionId} });
      window.answerResult = window.client.resumeActions('pc', 'chat').then(results => ({message:results[0].reason.message, retained:results[0].reason.deliveryRetained, persisted:results[0].reason.deliveryPersisted}));
    }
  }, path);
  assert.deepEqual(await page.evaluate(() => window.answerResult), {message:'This answer was refused.', retained:true, persisted:true});
  await page.getByText('Answer failed', { exact:true }).waitFor();
  assert.match(await page.locator('.failed-delivery').innerText(), /This answer was refused/);
  assert.equal(await page.evaluate(() => window.client.pendingActions().length), 0);
  assert.equal(state.calls.filter(call => call.method === 'session.answer-deliver').length, path === 'initial' ? 1 : 0);
});

test('a late turn clears a final failure held only in memory', async t => {
  const { page, state, delivery } = await fixture(t); state.reject = true;
  const saved = action(); await assert.rejects(delivery.deliver(saved.params, 'phone'));
  await page.evaluate(saved => {
    window.saveAction(saved);
    Storage.prototype.setItem = () => { throw new DOMException('Full', 'QuotaExceededError'); };
    window.mount(true);
  }, saved);
  await page.locator('.failed-delivery').waitFor();
  await page.evaluate(saved => window.client.deliver('pc', 'session.event', { id:'chat', events:[{type:'turn.start',messageId:saved.actionId}] }, 'late-memory'), saved);
  await page.locator('.failed-delivery').waitFor({ state:'detached' });
  assert.equal(await page.evaluate(() => window.client.failedActions().length), 0);
  assert.equal(await page.evaluate(() => window.client.pendingActions().length), 0);
});
