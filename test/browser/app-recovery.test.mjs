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
    function Broken() { throw new Error('Cannot render this chat'); }
    function App() {
      const [screen, setScreen] = useState('chat');
      return <>
        <textarea aria-label="Draft" onChange={e => localStorage.setItem('saved-draft', e.target.value)} />
        <button onClick={() => setScreen('lazy')}>Open screen</button>
        <button onClick={() => setScreen('broken')}>Open broken chat</button>
        {screen === 'lazy' && <Suspense fallback="Opening screen"><Screen /></Suspense>}
        {screen === 'broken' && <Broken />}
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
        remoteHelpers: helper ? [{ id: 'helper', machine: 'away', title: 'Remote helper', status: 'blocked' }] : [] };
      const listeners = new Set();
      window.helperPresence = (online) => listeners.forEach(listener => listener('away', 'presence', { online }));
      const events = failedTurn ? [
        { seq: 1, type: 'turn.start', turnId: 'failed', text: 'Try this task' },
        { seq: 2, type: 'turn.done', turnId: 'failed', status: 'error', error: message },
      ] : [];
      const client = {
        on: listener => { listeners.add(listener); return () => listeners.delete(listener); },
        subscribe: () => {}, pendingActions: () => [], resumeActions: async () => [],
        rpc: async (target, method) => {
          if (target === 'away' && method === 'session.list') {
            if (helper === 'offline') throw Error('Machine offline.');
            return { sessions: [{ id: 'helper', title: 'Remote helper', status: 'blocked', engine: 'codex',
              delegation: { parentId: chat.id, parentMachine: env.id, status: 'blocked' } }] };
          }
          if (method === 'session.list') return { sessions: [] };
          if (method === 'session.events') return { session: chat, events, pending: [], last: events.length };
          if (method === 'model.list') return { models, default: models[0] };
          return {};
        },
      };
      root.render(<DrivenSession key={chat.id} client={client} env={env} session={chat}
        onBack={() => {}} onClosed={() => {}} onArchived={() => {}} onSession={() => {}}
        onOpenSession={() => { window.openedHelper = true; }} />);
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

test('a render error leaves a readable recovery screen without raw details', async t => {
  const page = await pageFor(t);
  await page.getByRole('button', { name: 'Open broken chat' }).click();
  await page.getByRole('heading', { name: 'Helm cannot open this screen.' }).waitFor();
  assert.equal(await page.getByText('Error details', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Cannot render this chat', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Reload Helm' }).click();
  assert.equal(await page.evaluate(() => window.reloads), 1);
});

test('chat recovery opens the existing model picker and shows a missing folder path', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => window.mountRecovery('The model is at capacity.', ['gpt-5-mini', 'gpt-5']));
  const card = page.locator('.recovery');
  await card.getByText('This model is busy. Try again later.', { exact: true }).waitFor();
  await card.getByRole('button', { name: 'Choose model' }).click();
  await page.getByRole('listbox', { name: /^model$/i }).waitFor();
  await page.evaluate(() => window.mountRecovery('The folder /home/me/old work does not exist on this machine', []));
  await card.getByText('Restore the folder /home/me/old work on the chat’s machine. Then try again.', { exact: true }).waitFor();
  assert.equal(await card.getByRole('button', { name: 'Choose model' }).count(), 0);
});

test('the transcript shows exit code 124 without assuming a timeout', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => window.mountCommand(124));
  await page.locator('.work-head').click();
  await page.getByText('Command failed (exit code 124)', { exact: true }).waitFor();
  await page.evaluate(() => window.mountCommand(7));
  await page.getByText('Command failed (exit code 7)', { exact: true }).waitFor();
});

test('a missing saved chat directs the owner to a new chat without a retry button', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => window.mountRecovery('No conversation found with session ID: test-chat', []));
  const card = page.locator('.recovery');
  await card.getByText('Saved chat missing', { exact: true }).waitFor();
  assert.match(await card.innerText(), /Start a new chat/);
  assert.equal(await card.getByRole('button', { name: 'Try again' }).count(), 0);
});

test('a helper waiting for approval has a disabled review button when offline', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => window.mountRecovery('Test error.', [], { helper: 'offline' }));
  const review = page.locator('.child-requests button').filter({ hasText: 'Remote helper' });
  await review.waitFor();
  assert.match(await review.innerText(), /Review request/);
  assert.equal(await review.isDisabled(), true);
});

test('a disconnect disables the helper review button before the next read', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => window.mountRecovery('Test error.', [], { helper: 'online' }));
  const review = page.locator('.child-requests button').filter({ hasText: 'Remote helper' });
  await review.waitFor();
  assert.equal(await review.isEnabled(), true);
  await page.evaluate(() => window.helperPresence(false));
  await page.waitForFunction(() => document.querySelector('.child-requests button')?.disabled, null, { timeout: 1500 });
});

test('the transcript hides Send again for a missing saved chat', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => window.mountRecovery('Could not finish the task.', [], { failedTurn: true }));
  const resend = page.getByRole('button', { name: 'Send again', exact: true });
  await resend.waitFor();
  await page.evaluate(() => window.mountRecovery('No conversation found with session ID: test-chat', ['gpt-5'], { failedTurn: true }));
  await page.getByText('Try this task', { exact: true }).waitFor();
  await page.locator('.recovery').getByText('Saved chat missing', { exact: true }).waitFor();
  assert.equal(await resend.count(), 0);
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
