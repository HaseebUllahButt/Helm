#!/usr/bin/env node
// Generated private text only. Compare the old string tail, the JS queue and Rust.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

const cap = 262144;
function oldBuffer() {
  let text = '';
  return { append(chunk) {
    text += chunk;
    if (text.length <= cap) return;
    const cut = text.length - cap, nl = text.indexOf('\n', cut);
    text = text.slice(nl !== -1 && nl - cut < 4096 ? nl + 1 : cut);
  }, text: () => text };
}
const self = fileURLToPath(import.meta.url);
if (process.argv[2] === 'child') {
  const [, , , backend, sizeArg, readArg] = process.argv;
  const { createReplayBuffer } = await import('../packages/connect/src/replay-buffer.js');
  const text = ('private اردو 😀 terminal output\n'.repeat(140000)).slice(0, 4194304);
  const chunks = [], size = Number(sizeArg), readEvery = Number(readArg);
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  const times = []; let replay;
  for (let pass = 0; pass < 3; pass++) {
    const buffer = backend === 'baseline' ? oldBuffer() : createReplayBuffer(cap);
    const start = performance.now();
    for (let i = 0; i < chunks.length; i++) {
      buffer.append(chunks[i]);
      if (readEvery && i % readEvery === 0) buffer.text();
    }
    replay = buffer.text();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ ms: times[1], digest: createHash('sha256').update(Buffer.from(replay, 'utf16le')).digest('hex') }));
} else {
  const root = mkdtempSync(join(tmpdir(), 'helm-replay-bench-'));
  try {
    const modes = ['baseline', 'javascript'];
    console.log('The slower Rust replay candidate was removed. Compare the baseline with the JavaScript queue.');
    console.log('4194304 UTF-16 units of generated Unicode; tail 262144 units. Three paired processes per mode, three runs each.');
    for (const [size, readEvery] of [[128, 0], [1024, 0], [16384, 0], [128, 64]]) {
      const samples = Object.fromEntries(modes.map(mode => [mode, []])); let digest;
      for (let pair = 0; pair < 3; pair++) {
        for (const backend of pair % 2 ? [...modes].reverse() : modes) {
          const child = spawnSync(process.execPath, [self, 'child', backend, String(size), String(readEvery)], {
            encoding: 'utf8', env: { ...process.env, HOME: root, HELM_DIR: join(root, backend), HELM_LOG_READER: 'rust' },
          });
          assert.equal(child.status, 0, child.stderr);
          const result = JSON.parse(child.stdout);
          digest ??= result.digest;
          assert.equal(result.digest, digest);
          samples[backend].push(result.ms);
        }
      }
      const median = mode => samples[mode].sort((a, b) => a - b)[1].toFixed(2);
      console.log(`chunk ${size}, read ${readEvery ? `every ${readEvery}` : 'at end'}: baseline ${median('baseline')} ms; JS ${median('javascript')} ms; exact UTF-16 tail matches`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}
