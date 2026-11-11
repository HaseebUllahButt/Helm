import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, rm, readdir, readlink, rename, symlink, unlink } from 'node:fs/promises';
import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { availableParallelism } from 'node:os';
import { randomUUID } from 'node:crypto';
import { HELM_DIR } from './paths.js';
const exec = promisify(execFile);

/**
 * Build away from the serving checkout. Keep workspace links inside this folder.
 * `since` is the commit the machine runs: files that did not change since it
 * already passed this check, so only the changed ones are checked again.
 */
export async function prepareRelease(dir, tip, build, folder = join(HELM_DIR, `release-${randomUUID()}`), { since } = {}) {
  await mkdir(HELM_DIR, { recursive: true });
  try {
    await exec('git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout', '--', dir, folder]);
    await exec('git', ['-C', folder, 'fetch', '--quiet', '--', dir, tip]);
    await exec('git', ['-C', folder, 'checkout', '--quiet', '--detach', tip]);
    const listed = since
      ? await exec('git', ['-C', folder, 'diff', '--name-only', '--diff-filter=d', since, tip, '--', 'packages/connect']).catch(() => null)
      : null;
    const { stdout } = listed ?? await exec('git', ['-C', folder, 'ls-files', '--', 'packages/connect']);
    const paths = stdout.trim().split('\n').filter(path => /\.m?js$/.test(path));
    // One Node per file: run them side by side, not one after another.
    await Promise.all(Array.from({ length: Math.min(paths.length, availableParallelism()) }, async () => {
      for (let path; (path = paths.shift());) await exec(process.execPath, ['--check', join(folder, path)]);
    }));
    await build(folder);
    if (!existsSync(join(folder, 'apps/web/dist/index.html'))) throw Error('The new app is missing. Keep the working release.');
    // Real Helm builds carry a stamp; reject a stale stamp when present.
    const stamp = join(folder, 'apps/web/dist/build.json');
    if (existsSync(join(folder, 'apps/web/stampBuild.mjs')) && !existsSync(stamp)) throw Error('The new app has no saved version.');
    if (existsSync(stamp) && JSON.parse(readFileSync(stamp, 'utf8')).commit !== tip) {
      throw Error('The app has the wrong version. Keep the working release.');
    }
    return folder;
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}

/** Move the built files into the checkout. A move is instant; copy only across disks. */
export async function publishRelease(folder, dir, paths) {
  for (const path of paths) {
    await rm(join(dir, path), { recursive: true, force: true });
    if (existsSync(join(folder, path))) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      try { await rename(join(folder, path), join(dir, path)); }
      catch (error) {
        if (error.code !== 'EXDEV') throw error;
        await cp(join(folder, path), join(dir, path), { recursive: true, verbatimSymlinks: true });
      }
      await moveLinks(join(dir, path), folder, dir);
    }
  }
}

async function moveLinks(path, from, to) {
  if (!lstatSync(path).isDirectory()) return;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) await moveLinks(file, from, to);
    if (entry.isSymbolicLink()) {
      const target = await readlink(file);
      const offset = relative(from, target);
      if (isAbsolute(target) && !offset.startsWith('..') && !isAbsolute(offset)) {
        await unlink(file);
        await symlink(resolve(to, offset), file);
      }
    }
  }
}
