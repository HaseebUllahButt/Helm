import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { terminalQr } from '../packages/connect/src/qr-terminal.js';

const reader = ['/usr/bin/zbarimg', '/usr/local/bin/zbarimg', '/opt/homebrew/bin/zbarimg'].find(existsSync);

test('the QR code printed in a terminal reads back as the link', { skip: !reader && 'no zbarimg to read it' }, () => {
  const link = 'https://helm.example.com/#pair=Abc-123_xyz';
  // Light half blocks on a dark terminal: rebuild the picture a camera sees.
  const rows = [];
  for (const line of terminalQr(link).split('\n')) {
    const chars = [...line];
    rows.push(chars.map((ch) => (ch === '█' || ch === '▀' ? 255 : 0)));
    rows.push(chars.map((ch) => (ch === '█' || ch === '▄' ? 255 : 0)));
  }
  const scale = 6;
  const out = [`P2\n${rows[0].length * scale} ${rows.length * scale}\n255`];
  for (const row of rows) for (let y = 0; y < scale; y++) out.push(row.flatMap((v) => Array(scale).fill(v)).join(' '));
  const path = join(mkdtempSync(join(tmpdir(), 'helm-qr-')), 'qr.pgm');
  writeFileSync(path, out.join('\n') + '\n');
  assert.equal(execFileSync(reader, ['-q', '--raw', path], { encoding: 'utf8' }).trim(), link);
});
