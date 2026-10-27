import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the built PWA lives when running from a checkout. */
export function findWebRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../../apps/web/dist', '../web/dist', './web']) {
    const dir = join(here, rel);
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return null;
}

/**
 * The commit the served app was built from (apps/web/stampBuild.mjs). The
 * relay serves files as they are on disk, so this is what a browser gets
 * now. Read on each ask: a rebuild changes it without a restart.
 */
export function webBuild(root = findWebRoot()) {
  if (!root) return null;
  try {
    const { commit, dirty, builtAt } = JSON.parse(readFileSync(join(root, 'build.json'), 'utf8'));
    return typeof commit === 'string' ? { commit, dirty: dirty === true, builtAt } : null;
  } catch {
    return null;
  }
}
