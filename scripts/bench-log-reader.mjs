// Compare cold chat opens in separate processes, using private generated logs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
if (process.argv[2] === '--read') {
  const { EventLog } = await import('../packages/connect/src/events.js');
  const { logReader } = await import('../packages/connect/src/log-index-native.js');
  global.gc();
  const before = process.memoryUsage();
  const start = performance.now();
  const log = new EventLog(process.argv[3]);
  const result = log.tail('chat', 200);
  const ms = performance.now() - start;
  const digest = createHash('sha256').update(JSON.stringify(result)).digest('hex');
  global.gc();
  const after = process.memoryUsage();
  console.log(JSON.stringify({ reader: logReader, ms, digest, retained: after.heapUsed - before.heapUsed,
    peakRss: process.resourceUsage().maxRSS * 1024, tail: result.length }));
} else {
  const dir = mkdtempSync(join(tmpdir(), 'helm-log-reader-bench-'));
  try {
    for (const [name, turns, deltas, chars] of [['short', 10, 20, 200], ['long-text', 40, 300, 4000], ['many-tools', 4000, 1, 4000]]) {
      const fd = openSync(join(dir, 'chat.jsonl'), 'w');
      let seq = 0;
      const put = event => writeSync(fd, JSON.stringify({ seq: ++seq, at: 1700000000000 + seq, ...event }) + '\n');
      try {
        for (let n = 0; n < turns; n++) {
          put({ type: 'turn.start', turnId: `t${n}`, text: `Question ${n}` });
          put({ type: 'item.start', turnId: `t${n}`, id: `a${n}`, kind: name === 'many-tools' ? 'tool' : 'text', name: 'Read' });
          for (let d = 0; d < deltas; d++) put({ type: 'item.delta', id: `a${n}`, text: 'text '.repeat(chars / 5) });
          put({ type: 'item.done', id: `a${n}`, status: 'ok' });
          put({ type: 'turn.done', turnId: `t${n}`, status: 'ok' });
        }
      } finally { closeSync(fd); }
      const runs = { javascript: [], rust: [] };
      for (let n = 0; n < 3; n++) {
        for (const reader of n % 2 ? ['rust', 'javascript'] : ['javascript', 'rust']) {
          const result = JSON.parse(execFileSync(process.execPath, ['--expose-gc', self, '--read', dir], {
            encoding: 'utf8', env: { ...process.env, HELM_LOG_READER: reader },
          }));
          if (result.reader !== reader) throw new Error(`Expected ${reader}, got ${result.reader}. Build the Rust reader first.`);
          runs[reader].push(result);
        }
      }
      if (new Set(Object.values(runs).flat().map(r => r.digest)).size !== 1) throw new Error('The readers returned different chat tails.');
      const median = values => values.toSorted((a,b) => a-b)[Math.floor(values.length / 2)];
      console.log(JSON.stringify({ name, events: seq, ...Object.fromEntries(Object.entries(runs).map(([reader, rows]) => [reader, {
        ms: Math.round(median(rows.map(r => r.ms)) * 10) / 10,
        retainedMiB: Math.round(median(rows.map(r => r.retained)) / 104857.6) / 10,
        peakRssMiB: Math.round(median(rows.map(r => r.peakRss)) / 104857.6) / 10,
      }])) }));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
