import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

let browser, script;
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import * as workspace from './apps/web/src/workspaceCache';
    import { txn } from './apps/web/src/idb';
    Object.assign(window, { workspace, txn });
  `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'iife' });
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch({ headless: true,
    ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}),
  });
});
after(async () => browser?.close());

async function pageFor(t) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route('http://helm-cache-test/**', route => route.fulfill({
    contentType: 'text/html', body: '<div></div>',
  }));
  await page.goto('http://helm-cache-test/');
  await page.addScriptTag({ content: script });
  await page.evaluate(async () => {
    window.session = { id: 'chat', title: 'Chat', cwd: '/work', engine: 'codex', profileId: 'codex', status: 'idle' };
    window.workspace.saveWorkspace('test', {
      environments: [{ id: 'machine', name: 'Laptop', online: true, info: {} }],
      sessions: { machine: [window.session] }, view: { envId: 'machine', session: window.session },
    });
    window.workspace.writeWorkspaces();
    await window.txn('kv', 'readonly', store => store.get('helm.workspace:test'));
    window.flush = async () => {
      window.workspace.writeWorkspaces();
      return window.txn('kv', 'readonly', store => store.get('helm.workspace:test'));
    };
  });
  return page;
}

test('a changed header saves the list and the open view', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(async () => {
    const changed = { ...window.session, title: 'New title', context: { used: 42, window: 100 } };
    window.workspace.updateWorkspaceSession('test', 'machine', changed);
    const saved = await window.flush();
    return { title: saved.sessions.machine[0].title, view: saved.view.session.title, context: saved.view.session.context };
  });
  assert.deepEqual(result, { title: 'New title', view: 'New title', context: { used: 42, window: 100 } });
});

test('an open chat outside the saved list still saves its changed header', async t => {
  const page = await pageFor(t);
  const result = await page.evaluate(async () => {
    window.workspace.saveWorkspace('test', { sessions: { machine: [] } });
    await window.flush();
    window.workspace.updateWorkspaceSession('test', 'machine', { ...window.session, status: 'working' });
    const saved = await window.flush();
    return { status: saved.view.session.status, count: saved.sessions.machine.length };
  });
  assert.deepEqual(result, { status: 'working', count: 0 });
});
