import { lstatSync } from 'node:fs';
import { join } from 'node:path';

export const REVIEW_FILE = '.helm-restore-review.json';

/** Restored state stays offline. A malformed marker still blocks startup. */
export function assertRestoreReviewed(directory) {
  try { lstatSync(join(directory, REVIEW_FILE)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Restored Helm data is blocked for review. Do not start it or replay saved work. Check current trusted removals and completed actions first.');
}
