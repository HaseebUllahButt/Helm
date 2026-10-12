import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { join } from 'node:path';

let browser;
const capture = (target, name) => process.env.HELM_TEST_SCREENSHOT_DIR && target.screenshot({ path: join(process.env.HELM_TEST_SCREENSHOT_DIR, name) });
before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) }); });
after(async () => browser?.close());

// A chat always shows how full its context is, next to the account limits,
// and the figure follows the chat as it grows. It stays out of the way when
// the CLI has said nothing.
test('a chat shows a calm context meter that grows amber and red, and is absent without data', async () => {
  const bundle = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { DrivenSession } from './apps/web/src/session/DrivenSession';
    const env = { id:'ctx-test', name:'Laptop', online:true, info:{} };
    const base = { id:'chat', title:'Context chat', cwd:'/project', engine:'claude', profileId:'claudes', status:'idle', driver:true };
    const soon = Math.floor(Date.now() / 1000) + 115 * 60;
    const client = {
      on: () => () => {}, subscribe: () => {},
      rpc: async (env, method) => {
        if (method === 'usage.limits') return { unsupported:0, accounts:[
          { account:'claude|~/.claude-personal|s', engine:'claude', label:'personal', aliases:['claudes'], windows:[{label:'5h',used:4,resetsAt:soon,at:1},{label:'7d',used:59,resetsAt:soon,at:1}] },
        ] };
        if (method === 'model.list') return { models:[], modes:[] };
        if (method === 'agent.list') return { agents:[] };
        if (method === 'session.list') return { sessions:[] };
        if (method === 'session.watch') return { last:0 };
        if (method === 'session.events') return { session:base, events:[], pending:[], last:0 };
        if (method === 'git.status') return { repo:false };
        return { ok:true };
      },
    };
    function Chat() {
      const [context, setContext] = useState(undefined);
      window.setContext = setContext;
      const session = context === undefined ? base : { ...base, context };
      return <DrivenSession client={client} env={env} session={session} onBack={()=>{}} onClosed={()=>{}}
        onArchived={()=>{}} onSession={()=>{}} onOpenSession={()=>{}} />;
    }
    createRoot(document.getElementById('root')).render(<Chat />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  const css = (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '');
  for (const [width, label] of [[1280, 'wide'], [390, 'phone']]) {
    const view = await browser.newPage({ viewport: { width, height: 844 } });
    view.setDefaultTimeout(10_000);
    try {
      await view.route('http://helm-ctx-test/**', route => route.fulfill({ contentType: 'text/html', body: '<div class="session" id="root"></div>' }));
      await view.goto('http://helm-ctx-test/');
      await view.addStyleTag({ content: css });
      await view.addScriptTag({ content: bundle.outputFiles[0].text });
      const line = view.locator('.limits-line');
      await line.getByText('7d', { exact: false }).waitFor();
      assert.equal(await view.locator('.ctx-meter').count(), 0, 'nothing to show until the CLI reports');

      const show = (used, window = 383_000) => view.evaluate(([u, w]) => window.setContext({ used: u, window: w, at: 1 }), [used, window]);
      const meter = view.locator('.ctx-meter');

      await show(148_500);
      await meter.waitFor();
      assert.equal(await meter.getAttribute('title'), '148.5k of 383k used');
      assert.equal((await meter.locator('.ctx-pct').textContent()), '39%');
      assert.ok(!/warn|bad/.test(await meter.getAttribute('class')));
      // The phone keeps the ring and the percent; the numbers are for the hover.
      assert.equal(await meter.locator('.ctx-detail').isVisible(), width > 600);
      if (width > 600) assert.equal(await meter.locator('.ctx-detail').textContent(), '148.5k of 383k');
      assert.ok((await meter.boundingBox()).height < 24, 'a small mark, not a bar');
      await capture(line, `context-meter-${label}-calm.png`);

      await show(321_000);
      await view.locator('.ctx-meter.warn').waitFor();
      assert.equal((await meter.locator('.ctx-pct').textContent()), '84%');
      await capture(view.locator('.slab-status'), `context-meter-${label}-warn.png`);

      await show(372_000);
      await view.locator('.ctx-meter.bad').waitFor();
      assert.equal((await meter.locator('.ctx-pct').textContent()), '97%');
      await capture(view, `context-meter-${label}-full-page.png`);
      await capture(view.locator('.slab-status'), `context-meter-${label}-bad.png`);

      // After a compaction the next reply reports a smaller number.
      await show(40_000, 1_000_000);
      await view.locator('.ctx-meter:not(.warn):not(.bad)').waitFor();
      assert.equal(await meter.getAttribute('title'), '40k of 1M used');
      assert.equal(await view.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
    } finally { await view.close(); }
  }
});

test('a chat with a context figure but no account limits still shows the meter alone', async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { DrivenSession } from './apps/web/src/session/DrivenSession';
    const env = { id:'ctx-test', name:'Laptop', online:true, info:{} };
    const chat = { id:'chat', title:'Context chat', cwd:'/project', engine:'codex', profileId:'', status:'idle', driver:true, context:{ used:60000, window:258400, at:1 } };
    const client = {
      on: () => () => {}, subscribe: () => {},
      rpc: async (env, method) => {
        if (method === 'usage.limits') return { unsupported:0, accounts:[] };
        if (method === 'model.list') return { models:[], modes:[] };
        if (method === 'agent.list') return { agents:[] };
        if (method === 'session.list') return { sessions:[] };
        if (method === 'session.watch') return { last:0 };
        if (method === 'session.events') return { session:chat, events:[], pending:[], last:0 };
        if (method === 'git.status') return { repo:false };
        return { ok:true };
      },
    };
    createRoot(document.getElementById('root')).render(<DrivenSession client={client} env={env} session={chat} onBack={()=>{}} onClosed={()=>{}}
      onArchived={()=>{}} onSession={()=>{}} onOpenSession={()=>{}} />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  const view = await browser.newPage({ viewport: { width: 390, height: 844 } });
  view.setDefaultTimeout(10_000);
  try {
    await view.route('http://helm-ctx-test/**', route => route.fulfill({ contentType: 'text/html', body: '<div class="session" id="root"></div>' }));
    await view.goto('http://helm-ctx-test/');
    await view.addStyleTag({ content: (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '') });
    await view.addScriptTag({ content: bundle.outputFiles[0].text });
    await view.locator('.ctx-meter').waitFor();
    assert.equal(await view.locator('.ctx-pct').textContent(), '23%');
    assert.equal(await view.locator('.limits-caption').count(), 0, 'no empty "Account limits" label beside it');
    await capture(view.locator('.slab-status'), 'context-meter-phone-alone.png');
  } finally { await view.close(); }
});
