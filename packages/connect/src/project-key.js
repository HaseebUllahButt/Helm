/**
 * Which project a folder holds, said the same way on every machine.
 *
 * The same repo lives at different paths on different machines, so a path
 * cannot say "this project" across the network. Each machine names its own
 * folders by what git already knows and cannot differ between copies: the
 * repo's first commit, and the host and name of its remotes. Two folders are
 * the same project when they share any of those. A local path remote is left
 * out, since it means a different place on each machine.
 *
 * Answers are kept for a while per folder: `helm pickup` asks every machine
 * for all its chats' folders, and should answer in a second or two.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

const KEEP_MS = 10 * 60_000;
const cache = new Map();

function git(cwd, args) {
  return new Promise((done) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000 }, (err, out) => done(err ? null : out.trimEnd()));
  });
}

/** `git@github.com:Me/Helm.git` and `https://github.com/me/helm` are one place. */
export function normaliseRemote(url) {
  const s = String(url ?? '').trim();
  if (/^file:/i.test(s)) return null;
  const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i) // scheme://[user@]host[:port]/path
    || s.match(/^(?:[^@/]+@)?([^/:\\]{2,}):(?!\/)(.+)$/); // scp style: [user@]host:path (not C:\)
  if (!m) return null;
  const path = m[2].replace(/\/+$/, '').replace(/\.git$/i, '').replace(/^\/+/, '');
  return path ? `${m[1]}/${path}`.toLowerCase() : null;
}

/** A folder's project keys, `[]` outside git. `run` is for tests. */
export async function projectKeys(dir, run = git) {
  if (!dir || !existsSync(dir)) return [];
  const [roots, remotes] = await Promise.all([
    run(dir, ['rev-list', '--max-parents=0', 'HEAD']),
    run(dir, ['config', '--get-regexp', '^remote\\..*\\.url$']),
  ]);
  const keys = new Set();
  for (const sha of (roots ?? '').split('\n')) if (/^[0-9a-f]{40,64}$/.test(sha)) keys.add(`root:${sha}`);
  for (const line of (remotes ?? '').split('\n')) {
    const at = normaliseRemote(line.split(/\s+/)[1]);
    if (at) keys.add(`remote:${at}`);
  }
  return [...keys].sort();
}

/** Keys for many folders at once, from the cache where it is fresh. */
export async function projectKeysFor(dirs, { now = Date.now(), run = git } = {}) {
  const out = {};
  await Promise.all([...new Set(dirs.filter(Boolean))].map(async (dir) => {
    const hit = cache.get(dir);
    if (hit && now - hit.at < KEEP_MS) { out[dir] = hit.keys; return; }
    const keys = await projectKeys(dir, run);
    cache.set(dir, { keys, at: now });
    out[dir] = keys;
  }));
  return out;
}

export const sameProject = (a, b) => !!a?.length && !!b?.length && a.some((k) => b.includes(k));
