import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { copyDependencies } from '../../../scripts/linux-package.mjs';
const execute = promisify(execFile);

async function prepareCandidate(source, candidate, tip) {
  await execute('git', ['clone', '--quiet', '--shared', '--no-checkout', '--', source, candidate]);
  await execute('git', ['-C', candidate, 'checkout', '--quiet', '--detach', tip]);
  const roots = [''];
  for (const group of ['apps', 'packages']) {
    for (const entry of await readdir(join(source, group), { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(join(group, entry.name));
    }
  }
  for (const root of roots) {
    const from = join(source, root, 'node_modules');
    try {
      const actual = await realpath(from);
      copyDependencies(actual, join(candidate, root, 'node_modules'));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const checkLinks = async path => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory() && entry.name !== '.git') await checkLinks(file);
      if (!entry.isSymbolicLink()) continue;
      const target = await realpath(file);
      if (target !== candidate && !target.startsWith(candidate + sep)) throw new Error('A private build link leaves its folder.');
    }
  };
  await checkLinks(candidate);
  await execute('npm', ['--workspace', '@helm/web', 'run', 'build'], { cwd: candidate, timeout: 120000, maxBuffer: 2 << 20 });
}

/** Check a private candidate first; check the installed release after rollout. */
export async function proveRelease({ directory, tip, prepare = false, run = execute, log = console.log } = {}) {
  if (!directory || !/^[a-f0-9]{40}$/.test(tip ?? '')) throw new Error('Choose the release folder and its saved version.');
  log('  Checking a private chat and its saved approval…');
  const name = `release-${randomBytes(8).toString('hex')}`;
  let candidate, working = directory;
  try {
    if (prepare) {
      candidate = await mkdtemp(join(tmpdir(), 'helm-release-candidate-'));
      await prepareCandidate(directory, candidate, tip);
      working = candidate;
    }
    const result = await run(process.execPath, [join(working, 'scripts/release-proof.mjs'), '--name', name, '--tip', tip],
      { cwd: working, timeout: 240000, maxBuffer: 2 << 20 });
    log(`  ${result.stdout.trim()}`);
  } catch (error) {
    throw new Error('The private chat recovery check failed. Run node scripts/release-proof.mjs in that release to see the failed step.', { cause: error });
  } finally {
    try {
      // execFile can terminate the proof before its own cleanup runs.
      await run(process.execPath, [join(working, 'scripts/verify-helm.mjs'), '--name', name, 'down'],
        { cwd: working, timeout: 60000, maxBuffer: 2 << 20 });
    } finally { if (candidate) await rm(candidate, { recursive: true, force: true }); }
  }
}
