import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, rm, readdir, readlink, symlink, unlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HELM_DIR } from './paths.js';
const exec = promisify(execFile);

/** Build away from the serving checkout. Keep workspace links inside this folder. */
export async function prepareRelease(dir, tip, build, folder = join(HELM_DIR, `release-${randomUUID()}`)) {
  await mkdir(HELM_DIR, { recursive: true });
  try {
    await exec('git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout', '--', dir, folder]);
    await exec('git', ['-C', folder, 'fetch', '--quiet', '--', dir, tip]);
    await exec('git', ['-C', folder, 'checkout', '--quiet', '--detach', tip]);
    const { stdout } = await exec('git', ['-C', folder, 'ls-files', '--', 'packages/connect']);
    for (const path of stdout.trim().split('\n').filter(path => /\.m?js$/.test(path))) {
      await exec(process.execPath, ['--check', join(folder, path)]);
    }
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

export async function publishRelease(folder, dir, paths) {
  for (const path of paths) {
    await rm(join(dir, path), { recursive: true, force: true });
    if (existsSync(join(folder, path))) {
      await cp(join(folder, path), join(dir, path), { recursive: true, verbatimSymlinks: true });
      await moveLinks(join(dir, path), folder, dir);
    }
  }
}

async function moveLinks(path, from, to) {
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
