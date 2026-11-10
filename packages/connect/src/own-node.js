import { mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { HELM_DIR } from './paths.js';

/**
 * Node under Helm's own name, for the programs Helm starts for itself.
 *
 * ananicy-cpp (on by default on CachyOS and its relatives) gives every
 * program that starts as `node` idle CPU and disk priority, and what that
 * program starts inherits it. Helm then ran behind the agents' compile jobs
 * and the browser: a reply that takes 15 ms took up to 5 s, and each `git`
 * or `ip` it started held it for about a second.
 *
 * The rule matches the name a program starts with (argv[0]). A program
 * started under another name is left alone; renaming a running one is too
 * late, because the rule is applied the moment it starts and nothing
 * raises it again. So the service starts Node as `helm` (service.js), and
 * everything else starts it through this link.
 */
export const OWN_NAME = 'helm';

/** The link's path, or plain Node where no link is needed or none can be made. */
export function ownNode({ dir = HELM_DIR, node = process.execPath } = {}) {
  if (process.platform !== 'linux') return node;
  const link = join(dir, 'helm-node');
  try {
    let target = null;
    try { target = readlinkSync(link); } catch { /* not there yet */ }
    if (target !== node) {
      // Node moved (a version switch): point at the one running now.
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const next = `${link}.${process.pid}.tmp`;
      rmSync(next, { force: true });
      symlinkSync(node, next);
      renameSync(next, link);
    }
    return link;
  } catch {
    return node;
  }
}
