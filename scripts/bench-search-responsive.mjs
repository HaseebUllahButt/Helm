// Measure search work and pauses seen by other work on the same Node loop.
// Use --compare <checkout> for alternating before/after runs. Build Rust first.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const self = fileURLToPath(import.meta.url);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const median = values => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

if (process.argv[2] === '--read') {
  const [, , , root, dir] = process.argv;
  const { SearchIndex } = await import(pathToFileURL(join(root, 'packages/connect/src/search-index.js')));
  const { logReader } = await import(pathToFileURL(join(root, 'packages/connect/src/log-index-native.js')));
  const sessions = [{ id: 'chat', title: 'Private test', driver: 'devin', engine: 'devin' }];
  const delays = monitorEventLoopDelay({ resolution: 1 });
  const times = [], cpu = [];
  let digest, count = 0;
  delays.enable();
  await pause(20);
  const started = performance.now();
  while (performance.now() - started < 10_000) {
    const file = join(dir, `index-${process.pid}.json`);
    const index = new SearchIndex({ dir, file });
    const before = performance.now();
    const used = process.cpuUsage();
    await index.update(sessions);
    times.push(performance.now() - before);
    const spent = process.cpuUsage(used);
    cpu.push((spent.user + spent.system) / 1000);
    const hash = createHash('sha256').update(JSON.stringify(index.search('canary', sessions))).digest('hex');
    if (digest && hash !== digest) throw Error('Search output changed between reads.');
    digest = hash;
    index.close();
    rmSync(file, { force: true });
    count++;
  }
  await pause(20);
  delays.disable();
  const peak = process.platform === 'linux'
    ? Number(/VmHWM:\s+(\d+)/.exec(readFileSync('/proc/self/status', 'utf8'))[1]) / 1024
    : process.resourceUsage().maxRSS / 1024;
  console.log(JSON.stringify({ reader: logReader, runs: count, ms: median(times), cpu: median(cpu), peakMiB: peak, p99: delays.percentile(99) / 1e6, max: delays.max / 1e6, hash: digest }));
} else {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const flag = process.argv.indexOf('--compare');
  const baseline = flag < 0 ? null : resolve(process.argv[flag + 1]);
  const dir = mkdtempSync(join(tmpdir(), 'helm-search-responsive-'));
  try {
    const rows = [], emit = event => rows.push(JSON.stringify({ seq: rows.length + 1, at: 1000, ...event }));
    const output = 'private tool output '.repeat(205);
    emit({ type: 'turn.start', text: 'Find the canary' });
    emit({ type: 'item.start', id: 'tool', kind: 'tool' });
    for (let i = 0; i < 18000; i++) emit({ type: 'item.delta', id: 'tool', text: output });
    emit({ type: 'item.done', id: 'tool' });
    emit({ type: 'item.start', id: 'reply', kind: 'text' });
    emit({ type: 'item.delta', id: 'reply', text: 'The canary is here. اردو 😀' });
    emit({ type: 'item.done', id: 'reply' });
    const file = join(dir, 'chat.jsonl');
    writeFileSync(file, rows.join('\n') + '\n');
    console.log(`Private tool-heavy log: ${(statSync(file).size / 1e6).toFixed(1)} MB. Each process samples for ten seconds.`);
    const results = { before: [], after: [] };
    for (let trial = 0; trial < (baseline ? 2 : 1); trial++) {
      const order = baseline ? trial % 2 ? ['after', 'before'] : ['before', 'after'] : ['after'];
      for (const mode of order) {
        const result = JSON.parse(execFileSync(process.execPath, [self, '--read', mode === 'before' ? baseline : root, dir], {
          env: { ...process.env, HELM_DIR: join(dir, 'private-home') }, encoding: 'utf8',
        }));
        results[mode].push(result);
        console.log(`${mode}: ${JSON.stringify(result)}`);
      }
    }
    const values = [...results.before, ...results.after];
    if (values.some(row => row.hash !== values[0].hash || row.reader !== values[0].reader)) throw Error('Readers or search output differ.');
    for (const [mode, rows] of Object.entries(results)) if (rows.length) {
      console.log(`${mode} median: search ${median(rows.map(row => row.ms)).toFixed(2)} ms; loop p99 ${median(rows.map(row => row.p99)).toFixed(2)} ms; worst pause ${median(rows.map(row => row.max)).toFixed(2)} ms`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
