#!/usr/bin/env node
// Paired private fixtures only. No /proc scan or owner folder reads.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const self = fileURLToPath(import.meta.url);
if (process.argv[2] === 'child') {
  const root = process.argv[3], job = process.argv[4];
  const { processList } = await import('../packages/connect/src/procinfo.js');
  const fs = await import('../packages/connect/src/fs.js');
  if (process.env.HELM_LOG_READER === 'rust') {
    const { nativeFunction } = await import('../packages/connect/src/log-index-native.js');
    assert.equal(typeof nativeFunction?.('discoveryProcessList'), 'function', 'Build the Rust discovery reader first.');
    assert.equal(typeof nativeFunction?.('discoveryReadDirectory'), 'function');
  }
  const run = job === 'processes' ? () => processList(root)
    : job === 'list' ? () => fs.list(root) : () => fs.warmIndex({ force: true });
  for (let i = 0; i < 3; i++) await run();
  const times = [];
  let result;
  for (let i = 0; i < 15; i++) {
    const start = performance.now();
    result = await run();
    times.push(performance.now() - start);
  }
  if (job === 'walk') {
    const index = await fs.folderIndex();
    result = index.names.map((name, i) => {
      const parts = [name];
      for (let p = index.parents[i]; p >= 0; p = index.parents[p]) parts.unshift(index.names[p]);
      return { path: parts.join('/'), repo: index.repos.includes(i) };
    }).sort((a, b) => a.path.localeCompare(b.path));
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ ms: times[7], result }));
} else {
  const root = mkdtempSync(join(tmpdir(), 'helm-discovery-bench-'));
  try {
    for (const size of [100, 3000]) {
      const proc = join(root, `proc-${size}`), home = join(root, `home-${size}`);
      mkdirSync(proc); mkdirSync(home);
      for (let i = 1; i <= size; i++) {
        mkdirSync(join(proc, String(i)));
        writeFileSync(join(proc, String(i), 'cmdline'), `node\0private-${i}\0اردو 😀\0`);
        const dir = join(home, `project-${String(i).padStart(5, '0')}`);
        mkdirSync(dir);
        if (i % 5 === 0) mkdirSync(join(dir, '.git'));
        if (i % 10 === 0) mkdirSync(join(dir, 'src'));
      }
      for (const job of ['processes', 'list', 'walk']) {
        const results = { javascript: [], rust: [] };
        // Alternate the order so one implementation does not always warm the disk first.
        for (let pair = 0; pair < 4; pair++) {
          const order = pair % 2 ? ['rust', 'javascript'] : ['javascript', 'rust'];
          for (const mode of order) {
            const state = join(root, `${size}-${job}-${mode}-${pair}`);
            const child = spawnSync(process.execPath, [self, 'child', job === 'processes' ? proc : home, job], {
              cwd: resolve(fileURLToPath(new URL('..', import.meta.url))), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
              env: { ...process.env, HOME: home, HELM_DIR: state, HELM_SSH_DIR: join(state, 'ssh'), HELM_LOG_READER: mode },
            });
            assert.equal(child.status, 0, child.stderr);
            results[mode].push(JSON.parse(child.stdout));
          }
          assert.deepEqual(results.rust[pair].result, results.javascript[pair].result);
        }
        const mean = mode => results[mode].reduce((sum, r) => sum + r.ms, 0) / results[mode].length;
        console.log(`${job} ${size}: JS ${mean('javascript').toFixed(2)} ms; Rust ${mean('rust').toFixed(2)} ms; ${(mean('javascript') / mean('rust')).toFixed(2)}x; ${job === 'walk' ? 'identical folder sets' : 'identical results'}`);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}
