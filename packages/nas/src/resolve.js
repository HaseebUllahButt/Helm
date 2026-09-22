import { realpath, stat } from 'node:fs/promises';
import { resolve as resolvePath, sep } from 'node:path';

/**
 * A refusal with a reason.
 *
 * `code` is stable and deliberately coarse - the HTTP layer maps it to a
 * status, which is what lets a 'hidden' path be answered exactly like a
 * 'missing' one: the response must not confirm that the private thing is
 * there.
 */
export class MediaError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const beneath = (root, candidate) =>
  candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Turn a path a caller asked for into a real file underneath a real root.
 *
 * Every check exists because the string arrived over the network:
 *
 * - No segment may be '..' or start with a dot. '..' is traversal, and a
 *   dotted name is private - `.ssh` inside a shared folder must stay as
 *   invisible as if it were not there.
 * - The resolved text must sit beneath the root. Belt and braces: the
 *   segment rule should already make this impossible, but the filesystem is
 *   the thing being protected, so it gets its own opinion.
 * - The *real* path must sit beneath the *real* root. A symlink inside the
 *   share that points outside it must not make the outside reachable.
 */
export async function resolveMedia(rootPath, rel = '') {
  if (typeof rel !== 'string' || rel.includes('\0') || rel.startsWith('/')) {
    throw new MediaError('invalid', 'not a media path');
  }
  // Split on both separators so a '..' written with a backslash is caught
  // before the platform's own rules get a say.
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  if (segments.some((s) => s === '..')) {
    throw new MediaError('outside', 'a media path does not climb out of its folder');
  }
  if (segments.some((s) => s.startsWith('.'))) {
    throw new MediaError('hidden', 'a media path does not name hidden files');
  }

  let realRoot;
  try { realRoot = await realpath(rootPath); }
  catch { throw new MediaError('missing', 'the shared folder is gone'); }

  const candidate = resolvePath(realRoot, ...segments);
  if (!beneath(realRoot, candidate)) {
    throw new MediaError('outside', 'a media path stays inside its shared folder');
  }

  let real;
  try { real = await realpath(candidate); }
  catch { throw new MediaError('missing', 'no such media'); }
  if (!beneath(realRoot, real)) {
    throw new MediaError('outside', 'a link in that path leaves the shared folder');
  }
  return { path: real, stat: await stat(real) };
}
