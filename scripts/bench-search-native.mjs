// Paired cold search rebuilds. All logs and Helm state are private generated data.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv[2] === '--read') {
  const dir = process.argv[3];
  process.env.HELM_DIR = join(dir, 'home');
  const { SearchIndex } = await import('../packages/connect/src/search-index.js');
  const { searchReader } = await import('../packages/connect/src/search-native.js');
  const sessions = [{ id: 'chat', driver: 'fake', title: 'Private generated chat' }];
  global.gc();
  const before = process.memoryUsage().heapUsed;
  const index = new SearchIndex({ dir, file: join(dir, `index-${process.pid}.json`) });
  const cpuBefore = process.cpuUsage();
  const start = performance.now();
  await index.update(sessions);
  const ms = performance.now() - start;
  const cpu = process.cpuUsage(cpuBefore);
  const cpuMs = (cpu.user + cpu.system) / 1000;
  index.close();
  const saved = JSON.parse(readFileSync(join(dir, `index-${process.pid}.json`)));
  const digest = createHash('sha256').update(JSON.stringify({ saved, result: index.search('café', sessions) })).digest('hex');
  global.gc();
  console.log(JSON.stringify({ reader: searchReader, ms, cpuMs, digest, retained: process.memoryUsage().heapUsed - before,
    peakRss: process.resourceUsage().maxRSS * 1024 }));
} else {
  const dir = mkdtempSync(join(tmpdir(), 'helm-search-bench-'));
  try {
    for (const [name, turns, deltas, chars, kind] of [
      ['short', 20, 10, 100, 'text'],
      ['long-replies', 100, 100, 4000, 'text'],
      ['tool-heavy', 2000, 4, 8000, 'tool'],
    ]) {
      const fd = openSync(join(dir, 'chat.jsonl'), 'w');
      let seq = 0;
      const put = event => writeSync(fd, JSON.stringify({ seq: ++seq, at: seq, ...event }) + '\n');
      try {
        for (let n = 0; n < turns; n++) {
          put({ type: 'turn.start', text: `Find café number ${n} اردو 😀` });
          put({ type: 'item.start', id: String(n), kind });
          for (let d = 0; d < deltas; d++) put({ type: 'item.delta', id: String(n), text: 'café '.repeat(chars / 5) });
          put({ type: 'item.done', id: String(n) });
        }
      } finally { closeSync(fd); }
      const runs = { javascript: [], rust: [] };
      for (let n = 0; n < 5; n++) {
        for (const reader of n % 2 ? ['rust', 'javascript'] : ['javascript', 'rust']) {
          const row = JSON.parse(execFileSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--read', dir], {
            encoding: 'utf8', env: { ...process.env, HELM_DIR: join(dir, 'home'), HELM_LOG_READER: reader },
          }));
          if (row.reader !== reader) throw new Error(`Expected ${reader}, got ${row.reader}. Build the native reader first.`);
          runs[reader].push(row);
        }
      }
      if (new Set(Object.values(runs).flat().map(r => r.digest)).size !== 1) throw new Error('Search outputs differ.');
      const median = values => values.toSorted((a,b) => a-b)[Math.floor(values.length / 2)];
      console.log(JSON.stringify({ name, bytes: statSync(join(dir, 'chat.jsonl')).size, events: seq,
        ...Object.fromEntries(Object.entries(runs).map(([reader, rows]) => [reader, {
          ms: +median(rows.map(r => r.ms)).toFixed(2),
          cpuMs: +median(rows.map(r => r.cpuMs)).toFixed(2),
          retainedMiB: +(median(rows.map(r => r.retained)) / 1048576).toFixed(2),
          peakRssMiB: +(median(rows.map(r => r.peakRss)) / 1048576).toFixed(2),
        }])) }));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
