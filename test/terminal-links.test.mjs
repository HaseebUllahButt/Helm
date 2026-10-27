import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
const { code } = await transform(await readFile('apps/web/src/terminalLinks.ts', 'utf8'), { loader: 'ts', format: 'esm' });
const { localTerminalUrl, terminalLocalLinks } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('only explicit local ports become chat browser links', () => {
  for (const url of ['localhost:80', 'https://localhost:443', 'localhost:5173', '127.0.0.1:5173/path?q=1', 'https://localhost:5173/path']) assert.ok(localTerminalUrl(url));
  for (const url of ['localhost:0', 'localhost:65536', 'http://localhost:5173@example.com', 'http://localhost:5173.evil.com', 'http://example.com:5173', 'ftp://localhost:5173', 'localhost']) assert.equal(localTerminalUrl(url), null, url);
});

function terminal(rows) {
  const lines = rows.map(({ text, wrapped }) => ({ isWrapped: wrapped, length: text.length, getCell: i => ({ getWidth: () => 1, getChars: () => text[i] }) }));
  return { buffer: { active: { length: lines.length, getLine: i => lines[i] } } };
}

test('local links retain paths and span terminal wraps without taking other hosts', () => {
  const term = terminal([{ text: 'App http://local', wrapped: false }, { text: 'host:5173/path?q=1', wrapped: true }]);
  const [link] = terminalLocalLinks(term, 2);
  assert.equal(link.url, 'http://localhost:5173/path?q=1');
  assert.deepEqual(link.range, { start: { x: 5, y: 1 }, end: { x: 18, y: 2 } });
  assert.equal(terminalLocalLinks(term, 1)[0].url, link.url);
  const other = terminal([{ text: 'evil.localhost:5173 http://localhost:5173.evil.com http://127.0.0.1:5174/a. localhost:5175', wrapped: false }]);
  assert.deepEqual(terminalLocalLinks(other, 1).map(link => link.url), ['http://127.0.0.1:5174/a', 'http://localhost:5175/']);
});
