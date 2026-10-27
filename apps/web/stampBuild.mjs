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
  let stamp = null;
  return {
    name: 'stamp-helm-build',
    // Read before the sources are: a commit that lands during the build must
    // not stamp output that was built without it.
    buildStart() {
      const commit = git(cwd, ['rev-parse', 'HEAD']);
      // Only edits to the app's own sources make the build differ from the commit.
      const dirty = Boolean(git(cwd, ['status', '--porcelain', '--', ':(top)apps/web', ':(top)packages/protocol', ':(top)packages/usage']));
      stamp = commit ? { commit, dirty } : null;
    },
    async writeBundle(options) {
      if (!options.dir || !stamp) return;
      await writeFile(join(options.dir, 'build.json'), `${JSON.stringify({ ...stamp, builtAt: now() })}\n`);
    },
  };
}
