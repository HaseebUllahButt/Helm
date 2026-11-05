import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';
import { prepareVisual } from '../../packages/connect/src/visual.js';
import { visualDocument } from '../../packages/protocol/visual.js';

// A saved page with math gets KaTeX written into it (visual-math.js).
const dir = mkdtempSync(join(tmpdir(), 'helm-visual-math-'));
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true,
    ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}),
  });
});
after(async () => { await browser?.close(); rmSync(dir, { recursive: true, force: true }); });

async function prepared(name, html) {
  writeFileSync(join(dir, name), html);
  return prepareVisual(join(dir, name));
}

/** The page in the same sandbox and policy the chat and canvas use. */
async function show(t, html) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text().slice(0, 200)); });
  await page.setContent('<iframe sandbox="allow-scripts" style="border:0;width:390px;height:800px"></iframe>');
  await page.locator('iframe').evaluate((frame, src) => { frame.srcdoc = src; }, visualDocument(html));
  const frame = page.frameLocator('iframe');
  return { page, frame, errors };
}

test('math in page text and in text a script adds later is drawn; prices and code stay', async t => {
  const html = await prepared('lesson.html', `<!doctype html><html><head><title>$x$</title></head><body>
    <p id="static">Only $W_Q$, $W_K$ and $W_V$ learn. It costs $5 and $10.</p>
    <p>$$\\mathrm{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V$$</p>
    <code>$not_math$</code>
    <table><tbody id="rows"></tbody></table>
    <button id="more">More</button>
    <script>
      const row = (n) => \`<tr><td>\\\\(Q_{\${n}}\\\\)</td><td>\${n}-\${n * 64}</td></tr>\`;
      document.getElementById('rows').innerHTML = row(1);
      document.getElementById('more').onclick = () => { document.getElementById('rows').innerHTML += row(2); };
    </script>
  </body></html>`);
  assert.match(html, /katex/);
  assert.doesNotMatch(html, /url\(fonts\//, 'fonts are embedded as data');
  assert.ok(Buffer.byteLength(html) < 1024 * 1024, `page is ${Buffer.byteLength(html)} bytes`);

  const { page, frame, errors } = await show(t, html);
  await frame.locator('#rows .katex').first().waitFor();
  assert.deepEqual(await frame.locator('.helm-math').evaluateAll(boxes => boxes.map(box => box.dataset.tex)),
    ['W_Q', 'W_K', 'W_V', '\\mathrm{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V', 'Q_{1}']);
  assert.match(await frame.locator('#static').innerText(), /It costs \$5 and \$10\./);
  assert.equal(await frame.locator('code').innerText(), '$not_math$');
  assert.equal(await frame.locator('title').textContent(), '$x$');

  // A script redraws the table: the new row is drawn too.
  await frame.locator('#more').click();
  await frame.locator('#rows tr:nth-child(2) .katex').waitFor();
  assert.equal(await frame.locator('#rows tr:nth-child(2) td').nth(1).innerText(), '2-128');

  // KaTeX fonts load under the page's strict policy.
  await page.waitForFunction(() => true);
  const fonts = await frame.locator('body').evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family);
  });
  assert.ok(fonts.includes('KaTeX_Main') && fonts.includes('KaTeX_Math'), fonts.join(' '));
  if (process.env.HELM_TEST_ARTIFACT_DIR) await page.screenshot({ path: `${process.env.HELM_TEST_ARTIFACT_DIR}/visual-math.png` });
  assert.deepEqual(errors, []);
});

test('a page without math gets no KaTeX, and template literals do not count as math', async () => {
  const html = await prepared('plain.html', '<p>Costs $5 and $10, or $5-$10.</p><script>const a = 1, b = 2; document.title = `${a}-${b} and ${a}`;</script>');
  assert.doesNotMatch(html, /katex/i);
});

test('TeX in a page cannot add links or markup', async t => {
  const html = await prepared('bad.html', '<p>A $\\href{javascript:alert(1)}{x}$ B $\\htmlClass{x}{y}$ C $\\frac{a$ D $\\rule{999em}{999em}$</p>');
  const { frame, errors } = await show(t, html);
  await frame.locator('[data-tex]').nth(3).waitFor();
  assert.equal(await frame.locator('p a, p .x').count(), 0);
  assert.equal(await frame.locator('.helm-math-source').innerText(), '$\\frac{a$');
  const width = await frame.locator('body').evaluate(() => document.documentElement.scrollWidth);
  assert.ok(width <= 390, `page is ${width} px wide`);
  assert.deepEqual(errors, []);
});
