import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const WEEK = 7 * 24 * 60 * 60_000;

/** An installed app can still ask for an old lazy chunk after a deploy. */
export function retainAssets({ now = Date.now, maxAge = WEEK } = {}) {
  return {
    name: 'retain-previous-app-assets',
    async writeBundle(options, bundle) {
      if (!options.dir) return;
      const assets = join(options.dir, 'assets');
      const current = new Set(Object.keys(bundle));
      for (const entry of await readdir(assets, { withFileTypes: true })) {
        if (!entry.isFile() || current.has(`assets/${entry.name}`)) continue;
        const file = join(assets, entry.name);
        if (now() - (await stat(file)).mtimeMs > maxAge) await unlink(file);
      }
    },
  };
}
