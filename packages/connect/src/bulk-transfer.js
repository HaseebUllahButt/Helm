/**
 * Moving a project too big for one sealed handoff.
 *
 * A sealed snapshot lives in memory on both machines and crosses the relay
 * as one message, so it is capped (code-transfer.js) - and a game project
 * with its history is hundreds of megabytes. Rather than raise the cap, a
 * project over it travels the way `helm copy` does: rsync over the signed,
 * encrypted copy tunnel, streamed and resumable. Only the task itself - the
 * prompt and a small marker naming the copy - goes in the sealed handoff.
 *
 * What travels is what git would keep: tracked files, new files that are
 * not ignored, and the whole `.git` folder, so branches, history and
 * uncommitted work all arrive. Ignored build output and caches stay behind;
 * the agent on the other side rebuilds them. A folder without git skips the
 * same dependency and cache folders a sealed snapshot does.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, posix, resolve } from 'node:path';
import { expand } from './paths.js';

/** The same folders a sealed snapshot leaves out, for a project without git. */
export const BULK_SKIP_DIRS = ['node_modules', '.cache', '__pycache__', '.venv', 'venv', '.tox',
  '.next', '.nuxt', 'dist-ssr', '.pytest_cache', '.mypy_cache', '.gradle', '.terraform', '.helm-transfer-partial'];
const ENV_NAME = /^\.env(\..+)?$/;
const MAX_PROGRESS_LINE = 512;

const git = (folder, args) => execFileSync('git', ['-C', folder, ...args], {
  encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: 120_000,
});

function treeBytes(path) {
  let total = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) total += lstatSync(full).size;
    }
  };
  try { walk(path); } catch { /* best effort: a size estimate, not a gate */ }
  return total;
}

/**
 * What a bulk copy of `folder` will carry. Writes the NUL-separated list
 * rsync reads with --files-from, and returns it with a count and size so the
 * screen can say what is about to move before anything does.
 */
export function bulkPlan(folder, { includeEnv = true } = {}) {
  const root = resolve(expand(folder));
  if (!statSync(root).isDirectory()) throw new Error(`${folder} is not a folder`);
  let isGit = false;
  try { isGit = git(root, ['rev-parse', '--show-toplevel']).toString().trim() === root; } catch {}
  if (!isGit) {
    return { root, rootName: basename(root), git: null, listFile: null, files: null,
      bytes: treeBytes(root), excludes: BULK_SKIP_DIRS.map((d) => `${d}/`), envFiles: [] };
  }
  const split = (buf) => buf.toString('utf8').split('\0').filter(Boolean);
  // A tracked file deleted but not yet committed is in the index, not on
  // disk; rsync would stop on it, so only what exists goes on the list.
  const kept = split(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']))
    .filter((p) => { try { return lstatSync(join(root, p)).isFile() || lstatSync(join(root, p)).isSymbolicLink(); } catch { return false; } });
  const envFiles = includeEnv
    ? split(git(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard']))
      .filter((p) => ENV_NAME.test(posix.basename(p)) && !p.split('/').some((part) => BULK_SKIP_DIRS.includes(part)))
    : [];
  const paths = [...new Set([...kept, ...envFiles])];
  let bytes = treeBytes(join(root, '.git'));
  for (const p of paths) { try { bytes += lstatSync(join(root, p)).size; } catch {} }
  const dir = mkdtempSync(join(tmpdir(), 'helm-bulk-'));
  const listFile = join(dir, 'files');
  writeFileSync(listFile, `${['.git', ...paths].join('\0')}\0`, { mode: 0o600 });
  let head = null, branch = null;
  try { head = git(root, ['rev-parse', 'HEAD']).toString().trim(); } catch {}
  try { branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).toString().trim(); } catch {}
  return { root, rootName: basename(root), git: { commit: head, branch }, listFile, files: paths.length,
    bytes, excludes: [], envFiles };
}

export function discardPlan(plan) {
  if (plan?.listFile) rmSync(resolve(plan.listFile, '..'), { recursive: true, force: true });
}

/**
 * The marker the copy leaves beside the project: inside `.git` when there is
 * one, so `git status` on the other side reads exactly as it did here, else
 * under `.helm`. Its digest stands in for a snapshot digest in the signed
 * handoff, so the target starts the task only in a folder this very handoff
 * filled.
 */
export function bulkMarker({ handoffId, sourceMachineId, plan }) {
  const body = `${JSON.stringify({ handoffId, sourceMachineId, rootName: plan.rootName,
    files: plan.files, bytes: plan.bytes, git: plan.git })}\n`;
  return { body, digest: createHash('sha256').update(body).digest('hex'),
    parent: plan.git ? '.git' : '.helm', dir: plan.git ? 'helm-handoff' : 'handoff' };
}

export function writeMarkerDir(handoffId, marker) {
  const dir = mkdtempSync(join(tmpdir(), 'helm-marker-'));
  mkdirSync(join(dir, marker.dir), { recursive: true });
  writeFileSync(join(dir, marker.dir, `${handoffId}.json`), marker.body, { mode: 0o600 });
  return dir;
}

const MARKER_HOMES = [['.git', 'helm-handoff'], ['.helm', 'handoff']];

export function markerDigest(folder, handoffId) {
  for (const [parent, dir] of MARKER_HOMES) {
    const file = join(folder, parent, dir, `${handoffId}.json`);
    // Read as bytes: the digest covers exactly what the source wrote.
    if (existsSync(file)) return createHash('sha256').update(readFileSync(file)).digest('hex');
  }
  return null;
}

/** rsync --info=progress2 lines: "  12,345,678  45%   10.20MB/s    0:00:03". */
export function progressFrom(chunk) {
  const text = String(chunk).slice(-MAX_PROGRESS_LINE);
  const all = [...text.matchAll(/([\d,]+)\s+(\d{1,3})%\s+([\d.]+\w+\/s)?/g)];
  const last = all[all.length - 1];
  if (!last) return null;
  return { bytes: Number(last[1].replace(/,/g, '')), percent: Number(last[2]), rate: last[3] ?? null };
}
