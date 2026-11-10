import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, readdir, readFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { copyDependencies } from '../../../scripts/linux-package.mjs';
import { ownNode } from './own-node.js';
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
  await buildWeb(candidate);
}

/**
 * Build the app as `npm run build` would, but start its Node program under
 * Helm's own name. Through npm it starts as `node`, and on a machine with
 * ananicy that gets idle CPU: there a busy machine took 13 minutes, not 40 s,
 * and the check failed. Any other build command still goes through npm.
 */
async function buildWeb(candidate) {
  const web = join(candidate, 'apps/web');
  const bins = [join(web, 'node_modules/.bin'), join(candidate, 'node_modules/.bin')];
  const script = JSON.parse(await readFile(join(web, 'package.json'), 'utf8')).scripts?.build ?? '';
  const [first, ...rest] = script.trim().split(/\s+/);
  const bin = bins.map((dir) => join(dir, first)).find((file) => existsSync(file));
  const plain = /^[\w./=:@-]+$/.test(script.trim()) && (first === 'node' || bin);
  const options = { cwd: plain ? web : candidate, timeout: 300000, maxBuffer: 2 << 20, env: { ...process.env, PATH: [...bins, process.env.PATH].join(':') } };
  if (plain) await execute(ownNode(), [...(first === 'node' ? [] : [bin]), ...rest], options);
  else await execute('npm', ['--workspace', '@helm/web', 'run', 'build'], options);
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
