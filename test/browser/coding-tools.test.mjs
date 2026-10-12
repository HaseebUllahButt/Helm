import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const capture = (page, name) => process.env.HELM_TEST_SCREENSHOT_DIR && page.screenshot({ path: join(process.env.HELM_TEST_SCREENSHOT_DIR, name), fullPage: true });

// The Updates screen with a fake client: two machines, one of which has a
// tool the system owns, one that failed, and one with a newer version out.
test('the Updates screen lists each machine’s coding tools, updates now and saves the automatic setting', async () => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { UpdatesView } from './apps/web/src/Updates';
    const now = Date.now();
    const version = { commit: 'abc1234', subject: 'Chats show the context meter', time: now, dirty: false };
    const envs = [
      { id: 'laptop', name: 'laptop', kind: 'pc', online: true, lastSeen: now, info: { version } },
      { id: 'why', name: 'why', kind: 'vm', online: true, lastSeen: now, info: { version } },
      { id: 'home', name: 'HomePC', kind: 'pc', online: false, lastSeen: now - 3600e3, info: {} },
    ];
    const tools = {
      laptop: [
        { engine: 'claude', label: 'Claude Code', version: '2.1.296', method: 'self', canUpdate: true, lastChecked: now,
          lastResult: { at: now - 2 * 3600e3, ok: true, changed: true, from: '2.1.290', to: '2.1.296' } },
        { engine: 'codex', label: 'Codex', version: '0.161.0', method: 'self', canUpdate: true, lastChecked: now,
          lastResult: { at: now - 40 * 60e3, ok: true, changed: false, from: '0.161.0', to: '0.161.0' } },
        { engine: 'pi', label: 'Pi', version: '0.99.1', latest: '1.1.0', outdated: true, method: 'npm', canUpdate: true, lastChecked: now },
        { engine: 'cursor', label: 'Cursor', version: '2026.08.11-e8db854', method: 'self', canUpdate: true, lastChecked: now,
          lastResult: { at: now - 5 * 3600e3, ok: false, message: 'could not reach the update server' } },
      ],
      why: [
        { engine: 'claude', label: 'Claude Code', version: '2.1.280', method: 'system', canUpdate: false,
          reason: 'installed by the system - update it with the system’s package manager', lastChecked: now },
        { engine: 'gemini', label: 'Gemini', version: '0.9.0', method: 'npm', canUpdate: false,
          reason: 'installed with npm in a folder this user can not write to', lastChecked: now },
      ],
    };
    const state = { laptop: { auto: true, running: [] }, why: { auto: false, running: [] } };
    window.calls = [];
    const client = { rpc: async (env, method, params) => {
      window.calls.push({ env, method, params });
      if (method === 'cli.versions') return { ...state[env], tools: tools[env] };
      if (method === 'cli.update') {
        state[env].running = ['claude', 'codex'];
        setTimeout(() => { state[env].running = []; tools[env][1].lastResult = { at: Date.now(), ok: true, changed: true, from: '0.161.0', to: '0.162.0' }; tools[env][1].version = '0.162.0'; }, 3500);
        return { started: true };
      }
      if (method === 'cli.autoUpdate') { state[env].auto = params.on; return { auto: params.on }; }
      return {};
    } };
    createRoot(document.getElementById('root')).render(
      <div className="app"><UpdatesView client={client} envs={envs} onBack={() => {}} onRefresh={() => {}} /></div>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  const browser = await chromium.launch({ headless: true,
    ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent('<div id="root"></div>');
    await page.addStyleTag({ content: (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '') });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.locator('code', { hasText: '2.1.296' }).waitFor();

    const laptop = page.locator('.rows.plain', { has: page.getByText('Pi') });
    const text = await laptop.innerText();
    assert.match(text, /Claude Code[\s\S]*2\.1\.296[\s\S]*updated 2h ago \(2\.1\.290 → 2\.1\.296\)/);
    assert.match(text, /Codex[\s\S]*up to date · checked 40m ago/);
    assert.match(text, /Pi[\s\S]*0\.99\.1 · 1\.1\.0 is out/);
    assert.match(text, /Cursor[\s\S]*update failed 5h ago - could not reach the update server/);
    const why = await page.locator('.rows.plain', { has: page.getByText('Gemini') }).innerText();
    assert.match(why, /Claude Code[\s\S]*2\.1\.280[\s\S]*can’t update: installed by the system/);
    assert.match(why, /Gemini[\s\S]*can’t update: installed with npm in a folder this user can not write to/);
    assert.doesNotMatch(await page.locator('body').innerText(), /HomePC[\s\S]*Coding tools/, 'offline machines are not asked');

    // One switch per machine, on by default on one and saved when changed.
    assert.equal(await page.getByRole('switch').count(), 2);
    const onLaptop = page.getByRole('switch', { name: /on laptop/ }), onWhy = page.getByRole('switch', { name: /on why/ });
    assert.equal(await onLaptop.getAttribute('aria-checked'), 'true');
    assert.equal(await onWhy.getAttribute('aria-checked'), 'false');
    await capture(page, 'coding-tools-390.png');
    await onWhy.click();
    assert.equal(await onWhy.getAttribute('aria-checked'), 'true');
    await onLaptop.click();
    assert.equal(await onLaptop.getAttribute('aria-checked'), 'false');
    const saved = await page.evaluate(() => window.calls.filter((c) => c.method === 'cli.autoUpdate'));
    assert.deepEqual(saved, [{ env: 'why', method: 'cli.autoUpdate', params: { on: true } }, { env: 'laptop', method: 'cli.autoUpdate', params: { on: false } }]);

    // "Update now" is asked of that machine only, shows progress, then the result.
    const button = page.getByRole('button', { name: 'Update coding tools on laptop' });
    await button.click();
    await page.getByRole('button', { name: 'Updating on laptop…' }).waitFor();
    await page.getByText('updating…').first().waitFor();
    await capture(page, 'coding-tools-updating-390.png');
    await page.getByRole('button', { name: 'Update coding tools on laptop' }).waitFor({ timeout: 10_000 });
    assert.match(await laptop.innerText(), /Codex[\s\S]*0\.162\.0[\s\S]*updated just now \(0\.161\.0 → 0\.162\.0\)/);
    const updates = await page.evaluate(() => window.calls.filter((c) => c.method === 'cli.update'));
    assert.deepEqual(updates, [{ env: 'laptop', method: 'cli.update', params: {} }]);
    // Nothing can be updated on a machine where everything is the system's.
    assert.equal(await page.getByRole('button', { name: 'Update coding tools on why' }).isDisabled(), true);

    await page.setViewportSize({ width: 1280, height: 900 });
    await capture(page, 'coding-tools-1280.png');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll on a phone');
  } finally { await browser.close(); }
});
