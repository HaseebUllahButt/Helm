import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// A model that joined by itself gets one quiet note, in the chat's model
// picker and on the account's settings screen, and the settings screen has
// the switch that turns the whole thing off.
let browser, script, css;
before(async () => {
  const bundle = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { Controls, trayPrefs } from './apps/web/src/session/Controls';
    import { ModelPrefsView } from './apps/web/src/App';

    const list = {
      default: 'claude-opus-6', models: ['claude-opus-6', 'claude-sonnet-5-5'], more: ['claude-opus-5-5'],
      labels: { 'claude-opus-6': 'Claude Opus 6', 'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'claude-opus-5-5': 'Claude Opus 5.5' },
      prefs: { default: 'claude-opus-6', approved: ['claude-opus-6', 'claude-sonnet-5-5'] },
      efforts: ['low', 'high'], auto: true,
      news: [{ id: 'claude-opus-6', label: 'Claude Opus 6', isDefault: true }, { id: 'claude-sonnet-5-6', label: 'Claude Sonnet 5.6', isDefault: false }],
    };
    window.calls = [];
    const client = { rpc: async (env, method, params) => {
      window.calls.push({ method, params });
      if (method === 'model.list') return JSON.parse(JSON.stringify(list));
      return { ok: true };
    } };

    function Picker() {
      const [options, setOptions] = useState(JSON.parse(JSON.stringify(list)));
      const session = { engine: 'claude', model: 'claude-opus-6', profileId: 'p1' };
      const prefs = trayPrefs({ client, env: 'm', engine: 'claude', profileId: 'p1', options, setOptions, setError: () => {} });
      const controls = Controls({ options, session, onPick: () => {}, ...prefs });
      return <div style={{ padding: 12 }}>{controls.chips}{controls.sheet}</div>;
    }
    window.mountPicker = () => createRoot(document.getElementById('root')).render(<Picker />);

    const account = { key: 'k', engine: 'claude', account: '~/.claude', token: false, aliases: [],
      profile: { id: 'p1', label: 'Claude', engine: 'claude', cmd: 'claude', source: 'detected' }, defaults: null };
    window.mountSettings = () => createRoot(document.getElementById('root')).render(
      <ModelPrefsView client={client} env={{ id: 'm', name: 'laptop' }} account={account} onBack={() => {}} />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  script = bundle.outputFiles[0].text;
  css = (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '');
  browser = await chromium.launch({ headless: true,
    ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
});
after(async () => { await browser?.close(); });

const pageFor = async (width = 390) => {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  await page.setContent('<!doctype html><meta name="viewport" content="width=device-width"><div id="root"></div>');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  return page;
};
const shoot = async (page, name, width) => {
  if (!process.env.HELM_TEST_SCREENSHOT_DIR) return;
  await page.screenshot({ path: `${process.env.HELM_TEST_SCREENSHOT_DIR}/${name}-${width}.png` });
};

for (const width of [390, 1280]) {
  test(`the model picker shows the note once, calmly (${width}px)`, async () => {
    const page = await pageFor(width);
    await page.evaluate(() => window.mountPicker());
    await page.locator('button[title^="model:"]').click();
    const note = page.locator('.model-news');
    await note.waitFor();
    const text = await note.innerText();
    assert.match(text, /New: Claude Opus 6 — now your default/);
    assert.match(text, /New: Claude Sonnet 5\.6/);
    assert.doesNotMatch(text.split('\n')[1], /now your default/);
    await shoot(page, 'model-news-picker', width);
    await note.getByRole('button', { name: 'OK' }).click();
    await note.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.calls.filter((c) => c.method === 'model.news').length), 1);
    assert.equal(await page.evaluate(() => window.calls.find((c) => c.method === 'model.news').params.profileId), 'p1');
    await page.close();
  });
}

test('closing the picker without tapping OK also retires the note', async () => {
  const page = await pageFor();
  await page.evaluate(() => window.mountPicker());
  await page.locator('button[title^="model:"]').click();
  await page.locator('.model-news').waitFor();
  await page.locator('.modesheet .x').click();
  await page.waitForFunction(() => window.calls.some((c) => c.method === 'model.news'));
  await page.locator('button[title^="model:"]').click();
  await page.locator('.modesheet').waitFor();
  assert.equal(await page.locator('.model-news').count(), 0, 'it does not come back');
  await page.close();
});

test('setting a default from the chat picker leaves the saved list to the machine', async () => {
  const page = await pageFor();
  await page.evaluate(() => window.mountPicker());
  await page.locator('button[title^="model:"]').click();
  await page.getByRole('button', { name: /Use Claude Sonnet 5.5 by default/ }).click();
  await page.waitForFunction(() => window.calls.some((c) => c.method === 'model.prefs'));
  const call = await page.evaluate(() => window.calls.find((c) => c.method === 'model.prefs').params);
  assert.equal(call.keepApproved, true);
  assert.equal(call.default, 'claude-sonnet-5-5');
  await page.close();
});

for (const width of [390, 1280]) {
  test(`settings has the switch and the note, and saves the choice (${width}px)`, async () => {
    const page = await pageFor(width);
    await page.evaluate(() => window.mountSettings());
    const sw = page.getByRole('switch', { name: /Add new models automatically/ });
    await sw.waitFor();
    assert.equal(await sw.getAttribute('aria-checked'), 'true', 'on unless switched off');
    await page.locator('.model-news').waitFor();
    await shoot(page, 'model-news-settings', width);
    await page.locator('.model-news').getByRole('button', { name: 'OK' }).click();
    await page.locator('.model-news').waitFor({ state: 'detached' });
    await sw.click();
    assert.equal(await sw.getAttribute('aria-checked'), 'false');
    await page.waitForTimeout(300); // let the switch finish sliding
    await shoot(page, 'model-news-settings-off', width);
    await page.getByRole('button', { name: 'Save' }).click();
    await page.waitForFunction(() => window.calls.some((c) => c.method === 'model.prefs'));
    const saved = await page.evaluate(() => window.calls.find((c) => c.method === 'model.prefs').params);
    assert.equal(saved.auto, false);
    assert.deepEqual(saved.approved, ['claude-opus-6', 'claude-sonnet-5-5']);
    await page.close();
  });
}
