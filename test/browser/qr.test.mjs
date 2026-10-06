import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const reader = ['/usr/bin/zbarimg', '/usr/local/bin/zbarimg', '/opt/homebrew/bin/zbarimg'].find(existsSync);

test('the pairing QR code reads back as the exact link', { skip: !reader && 'no zbarimg to read it' }, async (context) => {
  const link = 'https://helm.example.com/#pair=Abc-123_xyz';
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { QrCode } from './apps/web/src/QrCode';
    createRoot(document.getElementById('root')).render(<QrCode value=${JSON.stringify(link)} label="code" />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic' });
  const browser = await chromium.launch({ headless: true, ...(process.env.HELM_TEST_CHROMIUM ? { executablePath: process.env.HELM_TEST_CHROMIUM } : {}) });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<body style="background:#14161b"><div id="root"></div></body>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const path = join(mkdtempSync(join(tmpdir(), 'helm-qr-')), 'qr.png');
  await page.getByRole('img', { name: 'code' }).screenshot({ path });
  assert.equal(execFileSync(reader, ['-q', '--raw', path], { encoding: 'utf8' }).trim(), link);
});
