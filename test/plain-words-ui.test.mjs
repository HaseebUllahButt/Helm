import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import { askPreview } from '../packages/connect/src/notify.js';

const load = async (path) => {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const { code } = await transform(source, { loader: 'ts', format: 'esm' });
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
};
const { plainProblem, plainError } = await load('../apps/web/src/session/problem.ts');
const { isBrowserKey } = await load('../apps/web/src/browserKeys.ts');

test('a CLI failure reads as a sentence, with the raw line kept for Details', () => {
  const raw = 'claude exited with code 1: No conversation found with session ID: c11b0faa-9520-4551-a2b0-6dd8c3971a7f';
  const p = plainProblem('error', raw);
  assert.equal(p.title, 'Task failed');
  assert.equal(p.action, 'Try again');
  assert.match(p.text, /saved history .* is gone/);
  assert.equal(p.raw, raw);
  assert.match(plainError('Error: 401 Unauthorized'), /signed out/);
  assert.match(plainError('API Error: 529 Overloaded'), /busy/);
});

test('an unknown failure keeps its own words, without ids or the exit prefix', () => {
  const p = plainProblem('error', 'codex exited with code 2: the frobnicator 3f2a9c1e-1111-2222-3333-444455556666 jammed');
  assert.equal(p.text, 'the frobnicator jammed');
  assert.ok(p.raw);
});

test('a limit says when it resets; a restart and a stop say what to do', () => {
  assert.match(plainProblem('limited', 'Claude AI usage limit reached|1791312600').text, /resets at/);
  assert.equal(plainProblem('restart', 'The agent stopped.').action, 'Resume');
  assert.equal(plainProblem('interrupted', 'The task was stopped.').text, 'You stopped this task.');
});

test('browser keys are caught; editing and finding keys are not', () => {
  const key = (k, o = {}) => ({ key: k, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, ...o });
  for (const k of ['n', 't', 'p', 's', 'o', 'h', 'j', 'd', 'l']) assert.ok(isBrowserKey(key(k)), `Ctrl+${k}`);
  for (const k of ['N', 'T', 'B', 'Delete']) assert.ok(isBrowserKey(key(k, { shiftKey: true })), `Ctrl+Shift+${k}`);
  assert.ok(isBrowserKey(key('n', { ctrlKey: false, metaKey: true })), 'Cmd+N');
  assert.ok(isBrowserKey(key('F1', { ctrlKey: false })), 'F1 opens browser help');
  for (const k of ['c', 'v', 'x', 'z', 'a', 'f', 'r', 'w', 'k', '+', '-']) assert.ok(!isBrowserKey(key(k)), `Ctrl+${k} stays`);
  assert.ok(!isBrowserKey(key('n', { ctrlKey: false })), 'plain n is typing');
  assert.ok(!isBrowserKey(key('i', { shiftKey: true })), 'devtools stay');
});

test('the in-app notice gets the first line of what was asked', () => {
  assert.deepEqual(askPreview({ type: 'permission.request', kind: 'question', questions: [{ question: 'Ship it?' }, { question: 'When?' }] }),
    { kind: 'question', text: 'Ship it?', more: 1 });
  assert.deepEqual(askPreview({ type: 'permission.request', kind: 'command', detail: '\n  npm   test\nnpm run build' }),
    { kind: 'command', text: 'npm test', more: 0 });
  assert.equal(askPreview({ type: 'permission.request', kind: 'edit', title: 'Edit App.tsx' }).text, 'Edit App.tsx');
  assert.equal(askPreview({ type: 'status' }), null);
  assert.equal(askPreview({ type: 'permission.request', kind: 'command', detail: 'x'.repeat(300) }).text.length, 120);
});
