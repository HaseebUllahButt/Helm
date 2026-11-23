import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'helm-search-responsive-home-'));
process.env.HELM_DIR = home;
const { SearchIndex } = await import('../packages/connect/src/search-index.js');
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
const line = event => JSON.stringify(event) + '\n';
const sessions = [{ id: 'chat', title: 'Private test', driver: 'devin', engine: 'devin' }];

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'helm-search-responsive-'));
  const file = join(dir, 'chat.jsonl');
  let seq = 0;
  const rows = [], emit = event => rows.push(line({ seq: ++seq, at: 1000, ...event }));
  emit({ type: 'turn.start', text: 'Find the saved canary' });
  emit({ type: 'item.start', id: 'reply', kind: 'text' });
  emit({ type: 'item.delta', id: 'reply', text: 'Saved prefix. ' });
  for (let i = 0; i < 1600; i++) emit({ type: 'item.delta', id: 'tool', text: 'ignored output '.repeat(300) });
  emit({ type: 'item.delta', id: 'reply', text: 'Saved middle. ' });
  writeFileSync(file, rows.join(''));
  const index = new SearchIndex({ dir, file: join(dir, 'index.json') });
  t.after(() => { index.close(); rmSync(dir, { recursive: true, force: true }); });
  return { index, seq };
}

async function duringRead(index, work, action) {
  let ended = false, applied = false;
  const done = work.finally(() => { ended = true; });
  await new Promise((resolve, reject) => {
    const tick = () => {
      if (ended) return reject(Error('The large read did not let other work run.'));
      if (!index.bytesRead) { setImmediate(tick); return; }
      try { action(); applied = true; resolve(); } catch (error) { reject(error); }
    };
    setImmediate(tick);
  });
  await done;
  assert.ok(applied);
}

test('a live reset during a large read removes old words and keeps the next reply', async t => {
  const { index, seq } = fixture(t);
  await duringRead(index, index.update(sessions), () => {
    index.note('chat', { seq: seq + 1, type: 'history.reset' });
    index.note('chat', { seq: seq + 2, at: 1002, type: 'turn.start', text: 'Keep the new kingfisher' });
    index.note('chat', { seq: seq + 3, type: 'item.start', id: 'new', kind: 'text' });
    index.note('chat', { seq: seq + 4, type: 'item.delta', id: 'new', text: 'A fresh answer.' });
    index.note('chat', { seq: seq + 5, at: 1003, type: 'item.done', id: 'new' });
  });
  assert.equal(index.search('canary', sessions).length, 0);
  assert.equal(index.search('kingfisher', sessions).length, 1);
  assert.equal(index.search('fresh answer', sessions).length, 1);
});
