import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildLogReader } from '../scripts/build-log-reader.mjs';

let available;
before(async () => { ({ available } = await buildLogReader({ log: () => {} })); });

const worker = String.raw`
import Module from 'node:module';
import { writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.HELM_DIR;
const mode = process.env.SEARCH_TEST_MODE;
const load = Module._load;
Module._load = function(name, ...args) {
  if (name.endsWith('.node')) {
    if (mode === 'missing' || mode === 'incompatible') {
      const error = new Error('Private test library');
      error.code = mode === 'missing' ? 'MODULE_NOT_FOUND' : 'ERR_DLOPEN_FAILED';
      throw error;
    }
    if (mode === 'old') return {};
    if (mode === 'failure') return { extractSearchEvents() { throw new Error('Private test failure'); } };
  }
  return load.call(this, name, ...args);
};
const { SearchIndex } = await import('./packages/connect/src/search-index.js');
const { searchReader, extractSearchEvents } = await import('./packages/connect/src/search-native.js');
const file = join(dir, 'index.json');
const log = join(dir, 'chat.jsonl');
const sessions = [{ id: 'chat', driver: 'fake', title: 'Private' }];
const line = e => JSON.stringify(e) + '\n';
let index = new SearchIndex({ dir, file });
const snapshots = [];
const snapshot = async () => {
  await index.update(sessions);
  index.save();
  const saved = JSON.parse(readFileSync(file));
  const { entries, last, diskLast, resetSeq, liveRanges, offset } = saved.chats.chat;
  snapshots.push({ entries, last, diskLast, resetSeq, liveRanges, offset, open: saved.open,
    results: ['café', 'اردو', 'queued', 'recovered', 'replacement'].map(q => index.search(q, sessions)) });
};
const start = { seq: 1, type: 'item.start', kind: 'text', id: null, at: null };
const delta = { seq: 2, type: 'item.delta', id: null, text: 'café اردو 😀\ud800 ' };
writeFileSync(log, line(start) + line(delta) + '{bad json}\n'
  + '{"seq":3,"seq":4,"type":"turn.start","text":"queued owner words"}\n'
  + line({ seq: 5, type: 'turn.start', text: '<helm-brief>hidden</helm-brief> queued café words' })
  + line({ seq: 6, type: 'item.delta', id: 'tool', text: 'tool payload'.repeat(10000) })
  + line({ seq: 7, type: 'item.delta', id: null, text: 'recovered ' })
  + line({ seq: 8, type: 'item.delta', id: null, text: 'x'.repeat(700) })
  + line({ seq: 9, type: 'item.delta', id: null, text: 'must not append' })
  + line({ seq: 10, type: 'item.done', id: null, at: 10 })
  + '[]\n' + line({ type: 'turn.start', text: { words: 'plain object' } })
  + Buffer.from([0xff]).toString() + '\n'
  + '{"seq":11,"type":"item.start","kind":"message","id":"tail"}\n'
  + '{"seq":12,"type":"item.delta","id":"tail","text":"torn');
index.note('chat', { seq: 14, type: 'turn.start', text: 'live café words' });
await snapshot();
index.close();
index = new SearchIndex({ dir, file });
appendFileSync(log, ' recovered"}\n' + line({ seq: 13, type: 'item.done', id: 'tail', at: 13 })
  + line({ seq: 14, type: 'turn.start', text: 'live café words' }));
await snapshot();
writeFileSync(log, line({ seq: 15, type: 'history.reset' })
  + line({ seq: 16, type: 'turn.start', text: 'replacement café words' }).trimEnd());
await snapshot();
appendFileSync(log, '\nnull');
await snapshot();
index.close();
const errors = [];
for (const type of ['unknown', 'history.reset', 'item.delta']) {
  for (const seq of [16, 18]) {
    writeFileSync(log, line({ seq, type, id: { toString: 'not callable' } }));
    try { await index.update(sessions); errors.push(null); }
    catch (error) { errors.push([error.name, error.message]); }
  }
}
const rows = extractSearchEvents(Buffer.from(line({ seq: 1, type: 'item.delta', id: 'tool', text: 'payload'.repeat(10000) })));
console.log(JSON.stringify({ searchReader, snapshots, errors, projectedBytes: rows ? JSON.stringify(rows).length : null }));
`;

test('search rebuild matches JS with Unicode, malformed rows, lazy tool text, live ranges, restarts and rewrites', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-search-native-'));
  try {
    const run = mode => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', worker], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', env: {
        ...process.env, HELM_DIR: dir, HELM_LOG_READER: mode === 'javascript' ? 'javascript' : 'rust', SEARCH_TEST_MODE: mode,
      },
    }));
    let baseline;
    for (const mode of ['javascript', ...(available ? ['rust'] : []), 'missing', 'incompatible', 'old', 'failure']) {
      rmSync(join(dir, 'index.json'), { force: true });
      const result = run(mode);
      if (mode === 'javascript') baseline = { snapshots: result.snapshots, errors: result.errors };
      else assert.deepEqual({ snapshots: result.snapshots, errors: result.errors }, baseline, mode);
      assert.equal(result.searchReader, ['rust', 'failure'].includes(mode) ? 'rust' : 'javascript', mode);
      if (mode === 'rust') assert.ok(result.projectedBytes < 100, 'tool payload stays in the input buffer');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
