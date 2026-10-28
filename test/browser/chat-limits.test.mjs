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

// A browser that never saw this account's limits still shows them, with
// when each resets, because the machine remembers them for every device.
test('a chat on a fresh browser shows its account limits and reset times from the machine', async () => {
  const bundle = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { DrivenSession } from './apps/web/src/session/DrivenSession';
    const env = { id:'limits-test', name:'Laptop', online:true, info:{} };
    const chat = { id:'chat', title:'Limits chat', cwd:'/project', engine:'claude', profileId:'claudes', status:'idle', driver:true };
    const soon = Math.floor(Date.now() / 1000) + 115 * 60, later = Math.floor(Date.now() / 1000) + 4 * 86400;
    const listeners = new Set();
    window.quota = 4;
    window.emit = (kind, payload) => listeners.forEach(fn => fn('limits-test',kind,payload));
    const client = {pendingActions:()=>[],resumeActions:async()=>[],
      on: fn => {listeners.add(fn); return () => listeners.delete(fn)}, subscribe: () => {},
      rpc: async (env, method) => {
        if (method === 'usage.limits') return { unsupported:0, accounts:[
          { account:'claude|~/.claude-personal|a', engine:'claude', label:'personal', aliases:['claudea'], windows:[{label:'5h',used:50,resetsAt:soon,at:1}] },
          { account:'claude|~/.claude-personal|s', engine:'claude', label:'personal', aliases:['claudes'], windows:[{label:'5h',used:window.quota,resetsAt:soon,at:1},{label:'7d',used:59,resetsAt:later,at:1}] },
        ] };
        if (method === 'model.list') return { models:[], modes:[] };
        if (method === 'agent.list') return { agents:[] };
        if (method === 'session.list') return { sessions:[] };
        if (method === 'session.watch') return { last:0 };
        if (method === 'session.events') return { session:chat, events:[], pending:[], last:0 };
        if (method === 'git.status') return { repo:false };
        return { ok:true };
      },
    };
    function Chat() {
      const [session, setSession] = useState(chat);
      return <DrivenSession client={client} env={env} session={session} onBack={()=>{}} onClosed={()=>{}}
        onArchived={()=>{}} onSession={setSession} onOpenSession={setSession} />;
    }
    createRoot(document.getElementById('root')).render(<Chat />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  const view = await browser.newPage({ viewport: { width: 1280, height: 844 }, timezoneId: 'UTC' });
  // Keep the two-hour reset on the same date, even when tests run near midnight.
  await view.clock.setFixedTime(new Date('2026-10-21T12:00:00Z'));
  view.setDefaultTimeout(10_000);
  try {
    await view.route('http://helm-limits-test/**', route => route.fulfill({ contentType: 'text/html', body: '<div class="session" id="root"></div>' }));
    await view.goto('http://helm-limits-test/');
    await view.addStyleTag({ content: (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '') });
    await view.addScriptTag({ content: bundle.outputFiles[0].text });
    const line = view.locator('.limits-line');
    await line.getByText('7d', { exact: false }).waitFor();
    const title = await line.getAttribute('title');
    const [name, five, seven] = title.split('\n');
    assert.equal(name, 'claudes');
    assert.match(five, /^5h: 4% used · resets in 1h 5\dm, at \d/);
    assert.match(seven, /^7d: 59% used · resets [A-Z][a-z]{2} \d/);
    await capture(line, 'chat-limits-line.png');
    await view.evaluate(() => {window.quota=23;window.emit('session.event',{id:'chat',events:[{seq:1,at:Date.now(),type:'limits'}]})});
    await line.getByText('5h 23%',{exact:true}).waitFor();
  } finally { await view.close(); }
});
