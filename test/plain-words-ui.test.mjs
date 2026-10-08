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
  assert.equal(plainProblem('restart', 'The agent stopped.').action, 'Continue');
  assert.equal(plainProblem('restart', 'The agent stopped.').title, 'Response interrupted');
  assert.doesNotMatch(plainProblem('restart', 'The agent stopped.').text, /Helm restarted|paused/);
  assert.equal(plainProblem('interrupted', 'The task was stopped.').text, 'You stopped this task.');
});

test('provider internal errors and rejected models explain how to recover', () => {
  const internal = 'Client error: Protocol error (invalid_argument): an internal error occurred (trace ID: d0ebd00c684f0c6c1cd575844e2e38aa)';
  const unavailable = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." } });
  assert.match(plainProblem('error', internal).text, /AI service.*choose another model/);
  assert.equal(plainProblem('error', internal).raw, internal);
  assert.match(plainProblem('error', unavailable).text, /unavailable for this account/);
  assert.equal(plainProblem('error', unavailable).raw, unavailable);
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

const { needsAttention, runningThread, settledThread, unknownThread, busyWord } = await load('../apps/web/src/format.ts');
const { ENGINES } = await import('../packages/connect/src/engines.js');
// Every engine helm knows, so a new one cannot slip past these rules.
const PROVIDERS = Object.keys(ENGINES).filter((engine) => engine !== 'shell');
const place = (s) => needsAttention(s) ? 'needs you' : runningThread(s) ? 'running' : settledThread(s) ? 'done'
  : unknownThread(s) ? 'status unavailable' : 'neither';

test('every provider is Running while busy, Needs you when blocked, and Done only when idle', () => {
  for (const engine of ['devin', 'opencode', 'opencode2', 'agy', 'antigravity', 'pi', 'omp', 'cursor', 'grok', 'codex', 'claude', 'rovo', 'gemini', 'kimi', 'muse']) {
    assert.ok(PROVIDERS.includes(engine), `${engine} is checked`);
  }
  for (const engine of PROVIDERS) {
    const at = (more) => place({ engine, status: 'idle', ...more });
    assert.equal(at({ status: 'starting' }), 'running', `${engine} starting`);
    assert.equal(at({ status: 'working' }), 'running', `${engine} working, thinking, tools or compaction`);
    assert.equal(at({ team: { working: 1, blocked: 0, failed: 0 } }), 'running', `${engine} child work`);
    assert.equal(at({ status: 'blocked' }), 'needs you', `${engine} approval`);
    assert.equal(at({ status: 'working', team: { working: 0, blocked: 1, failed: 0 } }), 'needs you', `${engine} child approval`);
    assert.equal(at({ recovery: { kind: 'error' } }), 'needs you', `${engine} failed turn`);
    assert.equal(at({}), 'done', `${engine} idle`);
    assert.equal(at({ status: 'done' }), 'done', `${engine} closed history`);
    assert.equal(at({ recovery: { kind: 'interrupted' } }), 'done', `${engine} stopped by the owner`);
    assert.equal(at({ status: 'unknown' }), 'status unavailable', `${engine} unknown is neither idle nor hidden`);
    assert.equal(at({ status: 'unknown', team: { working: 1, blocked: 0, failed: 0 } }), 'running', `${engine} unknown with child work`);
    for (const status of ['exited', 'shell', undefined, 'error']) {
      assert.equal(at({ status }), 'neither', `${engine} ${status} is never done`);
    }
  }
});

test('a stale failure does not pull a starting or working thread out of Running', () => {
  for (const status of ['starting', 'working']) {
    for (const kind of ['error', 'limited', 'restart']) {
      assert.equal(place({ status, recovery: { kind } }), 'running', `${status} with old ${kind}`);
    }
  }
  assert.equal(busyWord('starting'), 'starting');
  assert.equal(busyWord('working'), 'working');
  assert.equal(busyWord(undefined), 'working');
});
