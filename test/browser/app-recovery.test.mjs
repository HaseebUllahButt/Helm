import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

let browser, script;
before(async () => {
  browser = await chromium.launch({ headless: true,
    ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}),
  });
  const bundle = await build({ stdin: { contents: `
    import React, { lazy, Suspense, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { AppErrorBoundary } from './apps/web/src/AppErrorBoundary';
    import { DrivenSession } from './apps/web/src/session/DrivenSession';
    import { Transcript } from './apps/web/src/session/Transcript';
    const Screen = lazy(() => import('/assets/expired.js'));
    function App() {
      const [screen, setScreen] = useState('chat');
      return <>
        <textarea aria-label="Draft" onChange={e => localStorage.setItem('saved-draft', e.target.value)} />
        <button onClick={() => setScreen('lazy')}>Open screen</button>
        {screen === 'lazy' && <Suspense fallback="Opening screen"><Screen /></Suspense>}
      </>;
    }
    window.reloads = 0;
    const root = createRoot(document.getElementById('root'));
    window.mountCommand = (exitCode) => root.render(<Transcript status="idle" loaded turns={[{
      id: 'turn', text: 'Run the command', at: 1000, done: { status: 'error', durationMs: 3000 },
      items: [{ id: 'cmd', kind: 'command', command: 'example', output: 'working', status: 'error', exitCode, startedAt: 1000, doneAt: 4000 }],
    }]} />);
    window.mountRecovery = (message, models, { helper, failedTurn } = {}) => {
      const env = { id: 'here', name: 'Here', online: true };
      const chat = { id: models.length ? 'model' : 'folder', cwd: '/project', title: 'Test chat',
        profileId: 'codex', driver: 'codex', engine: 'codex', status: 'idle',
        recovery: { kind: 'error', message, at: Date.now() },
        remoteHelpers: helper ? [{ id: 'helper', machine: 'away', title: 'Remote helper', status: helper === 'online' ? 'working' : 'blocked' }] : [] };
      const listeners = new Set();
      const nested = helper === 'nested';
      let hubConnected = true, hubReachable = true;
      let leadOnline = helper !== 'offline', nestedOnline = true;
      window.helperAvailable = (online) => { leadOnline = online; };
      window.helperPresence = (online) => listeners.forEach(listener => listener('away', 'presence', { online }));
      window.helperConnection = (online, reachable = online) => {
        hubConnected = online;
        hubReachable = reachable;
        listeners.forEach(listener => listener('', 'connection', { online, reachable }));
      };
      window.disconnectBranch = () => {
        leadOnline = nestedOnline = false;
        window.helperPresence(false);
        listeners.forEach(listener => listener('other', 'presence', { online: false }));
        listeners.forEach(listener => listener('away', 'session.exit', {}));
      };
      window.reconnectNested = () => {
        nestedOnline = true;
        listeners.forEach(listener => listener('other', 'presence', { online: true }));
      };
      const events = failedTurn ? [
        { seq: 1, type: 'turn.start', turnId: 'failed', text: 'Try this task' },
        { seq: 2, type: 'turn.done', turnId: 'failed', status: 'error', error: message },
      ] : [];
      const client = {
        get connected() { return hubConnected; },
        get reachable() { return hubReachable; },
        on: listener => { listeners.add(listener); return () => listeners.delete(listener); },
        subscribe: () => {}, pendingActions: () => [], resumeActions: async () => [],
        rpc: async (target, method, params) => {
          if (target === 'away' && method === 'session.list') {
            if (!leadOnline) throw Error('Machine offline.');
            const status = nested ? 'working' : 'blocked';
            return { sessions: [{ id: 'helper', title: 'Remote helper', status, engine: 'codex',
              delegation: { parentId: chat.id, parentMachine: env.id, status } }, ...(nested ? [{
              id: 'middle', title: 'Helper on the lead machine', status: 'working', engine: 'codex',
              delegation: { parentId: 'helper', status: 'working' },
              remoteHelpers: [{ id: 'nested', machine: 'other', status: 'blocked' }],
            }] : [])] };
          }
          if (target === 'other' && method === 'session.list') {
            if (!nestedOnline) throw Error('Machine offline.');
            return { sessions: [{ id: 'nested', title: 'Nested helper', status: 'blocked', engine: 'pi',
              ask: { kind: 'command', text: leadOnline ? 'First request' : 'New request' },
              delegation: { parentId: 'middle', parentMachine: 'away', status: 'blocked' } }] };
          }
          if (method === 'session.list') return { sessions: [] };
          if (method === 'session.events' && target !== env.id) {
            if (target === 'other' ? !nestedOnline : !leadOnline) throw Error('Machine offline.');
            const requestId = target === 'other' ? 'nested-request' : 'remote-request';
            return { session: { id: params.id, title: 'Live helper', status: 'blocked' },
              pending: [{ requestId, kind: 'command', title: 'Review this command' }] };
          }
          if (method === 'session.events') return { session: chat, events, pending: [], last: events.length };
          if (method === 'model.list') return { models, default: models[0] };
          return {};
        },
      };
      root.render(<DrivenSession key={chat.id} client={client} env={env} session={chat} machines={[{ id: 'away', name: 'Away' }, { id: 'other', name: 'Other' }]}
        onBack={() => {}} onClosed={() => {}} onArchived={() => {}} onSession={() => {}}
        onOpenSession={(session, machine) => { window.openedHelper = { id: session.id, machine, request: session.ask?.requestId }; }} />);
    };
    root.render(
      <AppErrorBoundary reload={() => window.reloads++}><App /></AppErrorBoundary>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false,
    external: ['/assets/expired.js'], format: 'iife', jsx: 'automatic' });
  script = bundle.outputFiles[0].text;
});
after(async () => { await browser?.close(); });

async function pageFor(t) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route('http://helm-test/**', route => route.fulfill(route.request().url().endsWith('.js')
    ? { status: 404, body: 'not found' }
    : { contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://helm-test/');
  await page.addScriptTag({ content: script });
  return page;
}

test('a missing screen chunk shows recovery without clearing pairing or saved drafts', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => localStorage.setItem('helm.auth', 'test-membership'));
  await page.getByLabel('Draft').fill('keep my unsent message');
  await page.getByRole('button', { name: 'Open screen', exact: true }).click();
  await page.getByRole('heading', { name: 'Reload Helm' }).waitFor();
  assert.equal(await page.evaluate(() => window.reloads), 0, 'no reload loop');
  await page.getByRole('button', { name: 'Reload Helm' }).click();
  assert.equal(await page.evaluate(() => window.reloads), 1);
  assert.equal(await page.evaluate(() => localStorage.getItem('saved-draft')), 'keep my unsent message');
  assert.equal(await page.evaluate(() => localStorage.getItem('helm.auth')), 'test-membership');
});

test('the installed shell remains recoverable even when its entry bundle is missing', async t => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const html = (await readFile('apps/web/index.html', 'utf8')).replace('/src/main.tsx', '/assets/expired.js');
  let opens = 0;
  await page.route('http://helm-test/**', route => {
    if (new URL(route.request().url()).pathname === '/') {
      opens++;
      return route.fulfill({ contentType: 'text/html', body: html });
    }
    return route.fulfill({ status: 404, body: 'not found' });
  });
  await page.goto('http://helm-test/');
  assert.equal(await page.getByRole('heading', { name: 'Opening Helm…' }).isVisible(), true);
  await Promise.all([
    page.waitForEvent('domcontentloaded'),
    page.getByRole('button', { name: 'Reload Helm' }).click(),
  ]);
  assert.equal(opens, 2);
});
