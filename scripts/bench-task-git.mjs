// Compare task checkpoints on generated files. Each child samples ten seconds.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const self = fileURLToPath(import.meta.url);
const median = values => {
  const sorted = values.toSorted((a, b) => a - b), middle = Math.floor(values.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
if (process.argv[2] === '--read') {
  const root = process.argv[3];
  const { taskCheckpoint, checkpointChanges } = await import(pathToFileURL(join(root, 'packages/connect/src/task-git.js')));
  const directory = mkdtempSync(join(tmpdir(), 'helm-task-git-bench-'));
  const files = Array.from({ length: 2000 }, (_, i) => {
    const bytes = Buffer.alloc(4096); let seed = i + 1;
    for (let j = 0; j < bytes.length; j++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; bytes[j] = seed; }
    return { path: `nested/folder-${i % 20}/file-${i}`, mode: i % 17 ? 0o644 : 0o755, data: bytes.toString('base64url') };
  });
  try {
    const snapshot = { files }, times = [], hashes = new Set();
    const base = taskCheckpoint(directory, snapshot);
    const start = performance.now();
    while (performance.now() - start < 10_000) {
      const before = performance.now();
      const commit = taskCheckpoint(directory, snapshot, base);
      times.push(performance.now() - before);
      hashes.add(commit);
    }
    if (hashes.size !== 1) throw Error('Checkpoint content changed between identical captures.');
    const commit = [...hashes][0];
    const changes = checkpointChanges(directory, base, commit);
    if (changes.length) throw Error('An unchanged checkpoint has changed files.');
    const peak = process.platform === 'linux' ? Number(/VmHWM:\s+(\d+)/.exec(readFileSync('/proc/self/status', 'utf8'))[1]) / 1024
      : process.resourceUsage().maxRSS / 1024;
    console.log(JSON.stringify({ ms: median(times), runs: times.length, base, commit, nodePeakMiB: peak }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
} else {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const at = process.argv.indexOf('--compare');
  const baseline = at < 0 ? null : resolve(process.argv[at + 1]);
  const values = { before: [], after: [] };
  for (let pair = 0; pair < (baseline ? 3 : 1); pair++) {
    for (const mode of baseline ? pair % 2 ? ['after', 'before'] : ['before', 'after'] : ['after']) {
      const result = spawnSync(process.execPath, [self, '--read', mode === 'before' ? baseline : root], {
        encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      });
      if (result.status !== 0) throw Error(result.stderr || result.stdout || 'Checkpoint benchmark failed.');
      const value = JSON.parse(result.stdout);
      values[mode].push(value); console.log(mode + ': ' + JSON.stringify(value));
    }
  }
  const all = Object.values(values).flat();
  const digest = value => createHash('sha256').update(value.base + value.commit).digest('hex');
  if (all.some(value => digest(value) !== digest(all[0]))) throw Error('Checkpoint bytes differ between readers.');
  for (const [mode, rows] of Object.entries(values)) if (rows.length) console.log(`${mode}: ${median(rows.map(row => row.ms)).toFixed(2)} ms; Node peak ${median(rows.map(row => row.nodePeakMiB)).toFixed(2)} MiB`);
  console.log('Peak memory covers Node only. Git runs in separate child processes.');
}
