import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { ActionDelivery } from '../../packages/connect/src/action-delivery.js';
import { InputDelivery } from '../../packages/connect/src/input-delivery.js';

test('blocked live connections recover lost chat and approval replies, including a page reload', async t => {
  const root = mkdtempSync(join(tmpdir(), 'helm-browser-actions-'));
  let answers = 0, inputs = 0, drop = true, checking = false;
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const finish = new Promise(resolve => { release = resolve; });
  const sessions = {
    get: () => ({ driver: 'fake' }), turnState: () => null,
    input: async () => { inputs++; return { ok: true }; },
    answer: async () => {
      answers++;
      if (checking) { entered(); await finish; }
      return { ok: true };
    },
  };
  const approvals = new ActionDelivery(sessions, { dir: join(root, 'answers') });
  const messages = new InputDelivery(sessions, { dir: join(root, 'messages') });
  const writes = [];
  const server = createServer(async (req, res) => {
    if (req.url !== '/api/action') { res.end('<!doctype html><title>Private action check</title>'); return; }
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    let result;
    if (body.method === 'session.action-status') {
      result = body.params.kind === 'input' ? messages.status(body.params.actionId, 'phone') : approvals.status(body.params.actionId, 'phone');
    } else {
      writes.push(body);
      result = body.method === 'session.deliver' ? await messages.deliver(body.params, 'phone') : await approvals.deliver(body.params, 'phone');
      if (drop) { drop = false; res.destroy(); return; }
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ result }));
  });
  server.on('upgrade', (req, socket) => socket.destroy());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true,
    ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
  t.after(async () => { release(); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }); });
  const bundle = await build({ stdin: { contents: "import { Client } from './apps/web/src/client'; window.Client = Client;", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'iife' });
  const page = await browser.newPage();
  const url = 'http://127.0.0.1:' + server.address().port;
  const load = async () => {
    await page.goto(url);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.evaluate(() => { window.client = new window.Client([location.origin], 'phone'); });
  };
  await load();
  assert.deepEqual(await page.evaluate(() => window.client.input('pc', { id: 'chat', data: 'once' })), { ok: true });
  assert.equal(inputs, 1);
  drop = true;
  assert.deepEqual(await page.evaluate(() => window.client.rpc('pc', 'session.answer', { id: 'chat', requestId: 'first', decision: { option: 'allow' } })), { ok: true });
  assert.equal(answers, 1);
  checking = true;
  await page.evaluate(() => { window.pending = window.client.rpc('pc', 'session.answer', { id: 'chat', requestId: 'second', decision: { option: 'allow' } }); });
  await started;
  await page.waitForFunction(() => window.client.pendingActions().length === 1);
  await page.evaluate(() => window.client.close());
  await load();
  await page.evaluate(() => { window.restored = window.client.resumeActions('pc', 'chat'); });
  await page.waitForFunction(() => window.client.delivering.size === 1);
  assert.equal(answers, 2);
  assert.match(await page.evaluate(() => window.client.rpc('pc', 'session.answer', { id: 'chat', requestId: 'second', decision: { option: 'deny' } }).catch(e => e.message)), /previous answer/);
  release();
  await page.evaluate(() => window.restored);
  assert.equal(await page.evaluate(() => window.client.pendingActions().length), 0);
  assert.equal(answers, 2);
  assert.equal(new Set(writes.map(body => body.params.messageId ?? body.params.actionId)).size, 3, 'all attempts retain their action identity');
  await page.evaluate(() => window.client.close());
});
