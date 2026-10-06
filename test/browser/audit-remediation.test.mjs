import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

let browser;
let script;

before(async () => {
  const bundle = await build({
    stdin: { contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { DrivenSession } from './apps/web/src/session/DrivenSession';
      import { Composer } from './apps/web/src/session/Composer';
      import * as auth from './apps/web/src/store';
      import { txn, idb } from './apps/web/src/idb';

      const root = createRoot(document.getElementById('root'));
      const client = {
        subscribe: () => {}, on: () => () => {},
        rpc: (env, method, params) => {
          if (window.customRpc) return window.customRpc(env, method, params);
          if (method === 'session.input') return new Promise((resolve, reject) => {
            window.rejectSend = reject;
            window.lastSent = params.data;
          });
          if (method === 'session.events') return Promise.resolve({ events: [], pending: [], last: 0, session: { status: 'idle' } });
          if (method === 'session.watch') return Promise.resolve({ last: 0 });
          if (method === 'session.commands') return Promise.resolve({ commands: [] });
          if (method === 'model.list') return Promise.resolve({ models: [], default: null });
          if (method === 'git.status') return Promise.resolve({ repo: false });
          return Promise.resolve({});
        },
      };
      const session = { id: 'chat', title: 'Chat', cwd: '/tmp', engine: 'codex', driver: 'codex', profileId: 'codex', status: 'idle', turns: 1 };
      window.sessionFixture = session;
      function DrivenProbe() {
        return <DrivenSession client={client} env={{ id: 'machine', name: 'Laptop', online: true, info: {} }} session={session}
          onBack={() => {}} onClosed={() => {}} onArchived={() => {}} onSession={() => {}} />;
      }
      function ImeProbe() {
        const [draft, setDraft] = useState('漢字');
        return <Composer draft={draft} setDraft={setDraft} onSend={() => { window.sends = (window.sends || 0) + 1; }} engine="codex" keys={false} />;
      }
      window.mountDriven = () => root.render(<DrivenProbe />);
      window.mountIme = () => root.render(<ImeProbe />);
      Object.assign(window, { auth, txn, idb });
    `, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
  });
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}),
  });
});

after(async () => { await browser?.close(); });

async function pageFor(t) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route('http://helm-audit/**', (route) => route.fulfill({
    contentType: 'text/html', body: '<div id="root"></div>',
  }));
  await page.goto('http://helm-audit/');
  await page.addScriptTag({ content: script });
  return page;
}

test('a failed send does not overwrite a newer draft or its saved copy', async (t) => {
  const page = await pageFor(t);
  await page.evaluate(() => window.mountDriven());
  const area = page.locator('textarea');
  await area.waitFor();
  await area.fill('first prompt');
  await area.press('Enter');
  await page.waitForFunction(() => window.rejectSend);
  await area.fill('new unsent draft');
  await page.evaluate(() => window.rejectSend(new Error('simulated connection loss')));
  await page.getByText('simulated connection loss', { exact: true }).waitFor();
  assert.equal(await area.inputValue(), 'new unsent draft');
  assert.equal(await page.evaluate(() => localStorage.getItem('helm-draft:machine:chat')), 'new unsent draft');
});

for (const width of [1280, 390]) test(`recovery notice is compact and hidden for a live turn at ${width}px`, async t => {
  const page = await pageFor(t);
  await page.setViewportSize({ width, height: 844 });
  await page.addStyleTag({ content: (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '') });
  await page.evaluate(() => {
    window.sessionFixture.recovery = { kind: 'restart', message: 'This task was interrupted when its agent stopped. Its conversation is saved.', at: Date.now() };
    window.mountDriven();
  });
  const notice = page.locator('.recovery');
  await notice.getByText('Task paused', { exact: true }).waitFor();
  await notice.getByRole('button', { name: 'Resume', exact: true }).waitFor();
  const box = await notice.boundingBox();
  assert.ok(box.height < (width > 500 ? 130 : 170), `height ${box.height}`);
  assert.ok(box.x >= 0 && box.x + box.width <= width);
  await page.screenshot({ path: `/tmp/helm-recovery-thread-${width}.png` });
  await page.evaluate(() => {
    window.sessionFixture.status = 'working';
    window.customRpc = (_env, method) => method === 'session.events'
      ? Promise.resolve({ events: [{ seq: 1, type: 'status', status: 'working', at: Date.now() }], pending: [], last: 1, session: { status: 'working' } })
      : Promise.resolve({});
    window.dispatchEvent(new Event('focus'));
    window.mountDriven();
  });
  await notice.waitFor({ state: 'detached' });
});

test('durable auth restoration yields to a re-pairing during the IDB read', async (t) => {
  const page = await pageFor(t);
  const result = await page.evaluate(async () => {
    window.auth.saveAuth({ token: 'old-pairing', endpoints: ['http://old-network'] });
    await window.txn('kv', 'readonly', (s) => s.get('helm.auth'));
    localStorage.removeItem('helm.auth');
    const db = await window.idb();
    const tx = db.transaction('kv', 'readwrite');
    const store = tx.objectStore('kv');
    let hold = true;
    const loop = () => {
      const request = store.get('blocker');
      request.onsuccess = () => { if (hold) loop(); };
    };
    loop();
    const reading = window.auth.loadAuthDurable();
    await new Promise((resolve) => setTimeout(resolve, 30));
    window.auth.saveAuth({ token: 'new-pairing', endpoints: ['http://new-network'] });
    hold = false;
    const loaded = await reading;
    const durable = await window.txn('kv', 'readonly', (s) => s.get('helm.auth'));
    const sync = window.auth.loadAuthSync()?.token;
    window.auth.clearAuth();
    return { loaded: loaded?.token, sync, durable: durable?.token };
  });
  assert.deepEqual(result, { loaded: 'new-pairing', sync: 'new-pairing', durable: 'new-pairing' });
});

test('IME composition Enter is ignored while ordinary Enter still sends', async (t) => {
  const page = await pageFor(t);
  await page.evaluate(() => window.mountIme());
  const area = page.locator('textarea');
  await area.waitFor();
  await area.evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true,
  })));
  await area.evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true, cancelable: true,
  })));
  assert.equal(await page.evaluate(() => window.sends || 0), 0);
  await area.press('Enter');
  assert.equal(await page.evaluate(() => window.sends || 0), 1);
});
