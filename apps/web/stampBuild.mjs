import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const git = (cwd, args) => {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
};

/**
 * Writes dist/build.json with the commit the app was built from, so
 * `helm ship` can tell an app that was rebuilt from one that was not
 * (packages/connect/src/web-build.js reads it).
 */
export function stampBuild({ now = Date.now, cwd = process.cwd() } = {}) {
  return {
    name: 'stamp-helm-build',
    async writeBundle(options) {
      if (!options.dir) return;
      const commit = git(cwd, ['rev-parse', 'HEAD']);
      if (!commit) return;
      // Only edits to the app's own sources make the build differ from the commit.
      const dirty = Boolean(git(cwd, ['status', '--porcelain', '--', ':(top)apps/web', ':(top)packages/protocol', ':(top)packages/usage']));
      await writeFile(join(options.dir, 'build.json'), `${JSON.stringify({ commit, dirty, builtAt: now() })}\n`);
    },
  };
}
