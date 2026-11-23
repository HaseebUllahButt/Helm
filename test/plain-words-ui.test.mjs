import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const load = async (path) => {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const { code } = await transform(source, { loader: 'ts', format: 'esm' });
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
};
const { needsAttention, runningThread, settledThread, unknownThread } = await load('../apps/web/src/format.ts');
const { ENGINES } = await import('../packages/connect/src/engines.js');
// Every engine helm knows, so a new one cannot slip past these rules.
const PROVIDERS = Object.keys(ENGINES).filter((engine) => engine !== 'shell');
const place = (s) => needsAttention(s) ? 'needs you' : runningThread(s) ? 'running' : settledThread(s) ? 'done'
  : unknownThread(s) ? 'status unavailable' : 'neither';

test('every provider is Running while busy, Needs you when blocked, and Done only when idle', () => {
  for (const engine of ['devin', 'opencode', 'opencode2', 'agy', 'antigravity', 'pi', 'omp', 'cursor', 'grok', 'codex', 'claude', 'gemini', 'kimi', 'muse']) {
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
});
