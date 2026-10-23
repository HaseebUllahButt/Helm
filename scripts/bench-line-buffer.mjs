// Compare the old loop and the faster JavaScript collector.
// The measured Rust candidate was slower and was removed.
// Every process uses private generated input and an isolated HELM_DIR.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv[2] === '--read') {
  const mode = process.argv[3], name = process.argv[4];
  let collector;
  if (mode === 'baseline') {
    collector = { tail: '', write(text) { this.tail += text; }, read() {
      const cut = this.tail.indexOf('\n');
      if (cut < 0) return null;
      const line = this.tail.slice(0, cut); this.tail = this.tail.slice(cut + 1);
      return line;
    } };
  } else {
    const { LineBuffer } = await import('../packages/connect/src/line-buffer.js');
    collector = new LineBuffer();
  }
  const chunks = [];
  if (name === 'complete-small') {
    for (let n = 0; n < 20000; n++) chunks.push(JSON.stringify({ n, text: 'hello café اردو 😀' }) + '\n');
  } else if (name === 'many-small-lines') {
    const text = Array.from({ length: 20000 }, (_, n) => JSON.stringify({ n, text: 'hello café اردو 😀' }) + '\n').join('');
    for (let at = 0; at < text.length; at += 16384) chunks.push(text.slice(at, at + 16384));
  } else {
    const size = name.endsWith('512') ? 512 : 16384;
    const unit = name === 'split-ascii-512' ? 'x' : 'café اردو 😀 ';
    const chars = 1024 * 1024;
    const text = JSON.stringify({ text: unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars) });
    for (let n = 0; n < 4; n++) {
      for (let at = 0; at < text.length; at += size) chunks.push(text.slice(at, at + size));
      chunks.push('\n');
    }
    chunks.push('unfinished café \ud800');
  }
  global.gc();
  const before = process.memoryUsage().heapUsed;
  const cpuBefore = process.cpuUsage();
  const start = performance.now();
  const lines = [];
  for (const chunk of chunks) {
    collector.write(chunk);
    let line;
    while ((line = collector.read()) !== null) lines.push(line);
  }
  const ms = performance.now() - start;
  const cpu = process.cpuUsage(cpuBefore);
  const digest = createHash('sha256').update(JSON.stringify({ lines, tail: collector.tail })).digest('hex');
  global.gc();
  console.log(JSON.stringify({ ms, cpuMs: (cpu.user + cpu.system) / 1000, digest,
    peakRss: process.resourceUsage().maxRSS * 1024, retained: process.memoryUsage().heapUsed - before }));
} else {
  const dir = mkdtempSync(join(tmpdir(), 'helm-line-bench-'));
  try {
    for (const name of ['complete-small', 'many-small-lines', 'split-ascii-512', 'split-512', 'split-16384']) {
      const runs = { baseline: [], javascript: [] };
      for (let n = 0; n < 3; n++) {
        for (const reader of n % 2 ? ['javascript', 'baseline'] : ['baseline', 'javascript']) {
          runs[reader].push(JSON.parse(execFileSync(process.execPath,
            ['--expose-gc', fileURLToPath(import.meta.url), '--read', reader, name], {
              encoding: 'utf8', env: { ...process.env, HELM_DIR: join(dir, reader), HELM_LOG_READER: 'javascript' },
            })));
        }
      }
      if (new Set(Object.values(runs).flat().map(row => row.digest)).size !== 1) throw new Error('Line output differs.');
      const median = values => values.toSorted((a,b) => a-b)[Math.floor(values.length / 2)];
      console.log(JSON.stringify({ name, ...Object.fromEntries(Object.entries(runs).map(([reader, rows]) => [reader, {
        ms: +median(rows.map(row => row.ms)).toFixed(2),
        cpuMs: +median(rows.map(row => row.cpuMs)).toFixed(2),
        peakRssMiB: +(median(rows.map(row => row.peakRss)) / 1048576).toFixed(2),
        retainedMiB: +(median(rows.map(row => row.retained)) / 1048576).toFixed(2),
      }])) }));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
