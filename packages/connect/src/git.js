import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, readFile, readdir, realpath, open, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, basename, resolve, relative } from 'node:path';
import { expand, collapse } from './paths.js';

/**
 * What a session has done to its folder, as git sees it.
 *
 * The phone asks about a folder it has chosen, so every call resolves that to a
 * real directory first, and the one argument that names a file inside it is
 * refused if it could point anywhere else. Nothing here writes to a repo except
 * `addWorktree`, which only ever adds a sibling checkout on a new branch, and
 * `write`, which saves one file the owner edited in the canvas.
 */

const exec = promisify(execFile);
const OPTS = { maxBuffer: 8 * 1024 * 1024, timeout: 15_000 };
const git = (cwd, args) => exec('git', ['-C', cwd, ...args], OPTS).then((r) => r.stdout);

/** Enough of a diff to read on a phone; past this it says so rather than freezing. */
const DIFF_LIMIT = 200_000;
const FILE_LIMIT = 300;

async function folder(cwd) {
  const dir = resolve(expand(String(cwd ?? '')));
  const s = await stat(dir).catch(() => null);
  if (!s?.isDirectory()) throw new Error('no such folder');
  return dir;
}

const toplevel = (dir) => git(dir, ['rev-parse', '--show-toplevel']).then((s) => s.trim()).catch(() => null);
/** The canvas's top folder: the Git project, or the chat's own folder when it is in none. */
const canvasRoot = async (dir) => (await toplevel(dir)) ?? dir;

/** `## main...origin/main [ahead 1, behind 2]`, `## HEAD (no branch)`, `## No commits yet on main`. */
function branchLine(line) {
  const l = line.replace(/^## /, '');
  const m = /^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(l);
  const [, name, upstream, counts] = m ?? [];
  const n = (word) => Number(new RegExp(`${word} (\\d+)`).exec(counts ?? '')?.[1] ?? 0);
  return {
    branch: name?.startsWith('HEAD (') ? null : name ?? null,
    upstream: upstream ?? null,
    ahead: n('ahead'), behind: n('behind'),
  };
}

export async function status(cwd) {
  const dir = await folder(cwd);
  const root = await toplevel(dir);
  if (!root) return { repo: false };

  const [raw, numstat, head, gitDir, common] = await Promise.all([
    git(root, ['status', '--porcelain=v1', '-b', '-z']),
    git(root, ['diff', '--numstat', '-z', 'HEAD']).catch(() => git(root, ['diff', '--numstat', '-z']).catch(() => '')),
    git(root, ['log', '-1', '--format=%h%x00%s']).catch(() => ''),
    git(root, ['rev-parse', '--absolute-git-dir']).then((s) => s.trim()),
    git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).then((s) => s.trim()).catch(() => ''),
  ]);

  const parts = raw.split('\0');
  const info = branchLine(parts.shift() ?? '');
  const files = [];
  while (parts.length) {
    const entry = parts.shift();
    if (!entry) continue;
    const x = entry[0], y = entry[1];
    const path = entry.slice(3);
    const originalPath = x === 'R' || x === 'C' ? parts.shift() : undefined;
    files.push({
      path,
      ...(originalPath ? { originalPath } : {}),
      status: x === '?' ? '?' : (x === 'R' ? 'R' : (x === 'D' || y === 'D') ? 'D' : (x === 'A' || y === 'A') ? 'A' : 'M'),
      staged: x !== ' ' && x !== '?',
      add: 0, del: 0,
    });
  }

  // `--numstat -z` is "add\tdel\tpath\0", and "add\tdel\t\0old\0new\0" for a rename.
  const stats = new Map();
  const nums = numstat.split('\0');
  for (let i = 0; i < nums.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(nums[i] ?? '');
    if (!m) continue;
    let p = m[3];
    if (!p) { p = nums[i + 2] ?? ''; i += 2; }
    stats.set(p, { add: m[1] === '-' ? 0 : Number(m[1]), del: m[2] === '-' ? 0 : Number(m[2]) });
  }
  for (const f of files.slice(0, FILE_LIMIT)) {
    const s = stats.get(f.path);
    if (s) Object.assign(f, s);
    else if (f.status === '?') {
      // Untracked: git has no numstat for it, so count what would be added.
      const text = await readFile(join(root, f.path), 'utf8').catch(() => '');
      f.add = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
    }
  }

  const [commit, subject] = head.trim().split('\0');
  return {
    repo: true,
    root: collapse(root),
    ...info,
    head: commit ? { commit, subject } : null,
    // A linked worktree keeps its git dir apart from the shared one.
    worktree: !!common && resolve(gitDir) !== resolve(common),
    files: files.slice(0, FILE_LIMIT),
    more: Math.max(0, files.length - FILE_LIMIT),
  };
}

/** Bounded commit ancestry and live agents in each checkout of this repository. */
export async function graph(cwd, sessions = []) {
  const dir = await folder(cwd);
  const root = await toplevel(dir);
  if (!root) return { repo: false, commits: [], worktrees: [] };
  const limit = 80;
  const [log, raw, current, remotes] = await Promise.all([
    git(root, ['log', '--all', '--topo-order', `--max-count=${limit + 1}`, '--format=%H%x00%P%x00%s%x00%an%x00%aI%x00%D']).catch(async (error) => {
      // An unborn repository still has a checkout and can have working agents.
      const refs = await git(root, ['show-ref']).catch(() => '');
      if (!refs.trim()) return '';
      throw error;
    }),
    git(root, ['worktree', 'list', '--porcelain', '-z']),
    realpath(root),
    // So the app can tell a local `feature/x` from a remote's `origin/x`.
    git(root, ['remote']).then((out) => out.split('\n').map((r) => r.trim()).filter(Boolean)).catch(() => []),
  ]);
  const commits = log.trimEnd().split('\n').filter(Boolean).map((line) => {
    const [hash, parents, subject, author, date, refs] = line.split('\0');
    return { hash, parents: parents ? parents.split(' ') : [], subject, author, date,
      refs: refs ? refs.split(', ') : [] };
  });
  const worktrees = [];
  let entry = null;
  for (const field of raw.split('\0')) {
    if (field.startsWith('worktree ')) {
      entry = { path: field.slice(9), head: null, branch: null, agents: [] };
      worktrees.push(entry);
    } else if (entry && field.startsWith('HEAD ')) {
      entry.head = /^0+$/.test(field.slice(5)) ? null : field.slice(5);
    } else if (entry && field.startsWith('branch ')) {
      entry.branch = field.slice(7).replace(/^refs\/heads\//, '');
    }
  }
  const roots = await Promise.all(worktrees.map((w) => realpath(w.path).catch(() => null)));
  const live = sessions.filter((s) => !s.archived && !s.brain && s.engine !== 'shell'
    && !['done', 'exited'].includes(s.status)
    && (s.alive === true || s.externalActive === true || ['working', 'blocked'].includes(s.status)));
  await Promise.all(live.map(async (s) => {
    if (!s.cwd) return;
    const path = await realpath(resolve(expand(s.cwd))).catch(() => null);
    if (!path) return;
    // Longest match matters when a linked checkout lives inside another one.
    const at = roots.map((r, i) => ({ r, i })).filter(({ r }) => r && (path === r || path.startsWith(`${r}/`)))
      .sort((a, b) => b.r.length - a.r.length)[0]?.i;
    if (at == null) return;
    const sessionRoot = await toplevel(path);
    if (!sessionRoot || await realpath(sessionRoot).catch(() => null) !== roots[at]) return;
    worktrees[at].agents.push({ id: s.id, title: s.title, engine: s.engine,
      profileId: s.profileId, status: s.status, cwd: collapse(path) });
  }));
  return { repo: true, commits: commits.slice(0, limit), truncated: commits.length > limit, remotes,
    worktrees: worktrees.map((w, i) => ({ ...w, path: collapse(w.path), current: roots[i] === current,
      agents: w.agents.sort((a, b) => a.id.localeCompare(b.id)) })) };
}

/** One file's change against HEAD, as unified diff text. */
export async function diff(cwd, path) {
  const dir = await folder(cwd);
  const rel = String(path ?? '');
  if (!rel || rel.includes('\0') || rel.startsWith('/') || rel.split('/').includes('..')) {
    throw new Error('that is not a path inside the folder');
  }
  const root = await toplevel(dir);
  if (!root) throw new Error('not a git repository');
  let out = await git(root, ['diff', '--no-color', 'HEAD', '--', rel]).catch(() => '');
  if (!out) out = await git(root, ['diff', '--no-color', '--', rel]).catch(() => '');
  if (!out && existsSync(join(root, rel))) {
    // Untracked: diff it against nothing. Exit status 1 just means "they differ".
    out = await exec('git', ['-C', root, 'diff', '--no-color', '--no-index', '--', '/dev/null', rel], OPTS)
      .then((r) => r.stdout, (e) => e.stdout ?? '');
  }
  const truncated = out.length > DIFF_LIMIT;
  return { path: rel, diff: truncated ? out.slice(0, DIFF_LIMIT) : out, truncated };
}

/** Past this many paths the Files list stops; search still finds what was listed. */
const TREE_LIMIT = 50_000;
/** Enough of one file to read on a phone. */
const TEXT_LIMIT = 400_000;
/** Files that usually hold passwords or keys: listed, never sent. */
const SECRET = /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|\.pgpass|id_(rsa|dsa|ecdsa|ed25519)|credentials(\.json)?|[^/]*\.(pem|key|p12|pfx|keystore|jks))$/i;
export const isSecretPath = (p) => SECRET.test(p) && !/\.(example|sample|template)$/i.test(p);

/** A path the phone named, checked to stay inside the repo. */
function inside(path) {
  const rel = String(path ?? '');
  if (!rel || rel.includes('\0') || rel.startsWith('/') || rel.split('/').includes('..')) {
    throw new Error('that is not a path inside the folder');
  }
  return rel;
}

/**
 * Every file git would show for the repo - tracked, plus new files that are
 * not ignored - for the read-only Files view. `start` is the chat's own
 * folder inside the repo, where the list opens.
 */
export async function files(cwd) {
  const dir = await folder(cwd);
  const root = await canvasRoot(dir);
  const all = [...new Set(await listed(root))].sort();
  const realRoot = await realpath(root).catch(() => root);
  const realDir = await realpath(dir).catch(() => dir);
  const start = realDir.startsWith(realRoot + '/') ? realDir.slice(realRoot.length + 1) : '';
  return {
    root: collapse(root), absoluteRoot: root, start, truncated: all.length > TREE_LIMIT,
    files: all.slice(0, TREE_LIMIT), secret: all.slice(0, TREE_LIMIT).filter(isSecretPath),
  };
}

/** A Git project's files, without the ignored ones. */
const gitFiles = (root) => exec('git', ['-C', root, 'ls-files', '-co', '--exclude-standard', '-z'], { ...OPTS, maxBuffer: 64 * 1024 * 1024 })
  .then((r) => r.stdout.split('\0').filter(Boolean));

/**
 * A folder's files. A folder outside Git is walked by hand, skipping
 * node_modules; a Git project found inside it lists its own files.
 */
async function listed(root, prefix = '', found = []) {
  if (!prefix && await toplevel(root) === root) return gitFiles(root);
  const here = join(root, prefix);
  const entries = await readdir(here, { withFileTypes: true }).catch(() => []);
  if (prefix && entries.some((e) => e.name === '.git')) {
    for (const f of await gitFiles(here).catch(() => [])) found.push(prefix + f);
    return found;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (found.length > TREE_LIMIT) break;
    if (e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules') await listed(root, `${prefix}${e.name}/`, found);
    else if (e.isFile()) found.push(prefix + e.name);
  }
  return found;
}

/** Resolve an agent's file against its chat folder, using the same read guards as Canvas. */
export async function canvasPath(cwd, path) {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0')) throw new Error('canvas needs a file path');
  const dir = await folder(cwd);
  const root = await canvasRoot(dir);
  const rel = relative(root, resolve(dir, expand(path)));
  const result = await file(cwd, rel);
  if (result.hidden) throw new Error('this file may hold passwords or keys');
  if (rel.split('/')[0] === '.git') throw new Error('that is git’s own folder');
  return rel;
}

/** What a save compares against, so it never overwrites a change it did not see. */
const hashOf = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * One file's text. Secrets, pictures and other binary files say what they are
 * instead. `hash` is there when the whole file was read; with `since` equal to
 * it, only `{ same: true }` comes back, which is how the canvas watches a file.
 */
export async function file(cwd, path, since) {
  const dir = await folder(cwd);
  const rel = inside(path);
  const root = await canvasRoot(dir);
  if (isSecretPath(rel)) return { path: rel, hidden: true };
  const realRoot = await realpath(root);
  const full = await realpath(join(root, rel)).catch(() => null);
  // A link that leads out of the repo is not "a file in this folder".
  if (!full || !full.startsWith(realRoot + '/')) throw new Error('no such file in this folder');
  if (isSecretPath(relative(realRoot, full))) return { path: rel, hidden: true };
  const s = await stat(full);
  if (!s.isFile()) throw new Error('that is not a file');
  const handle = await open(full, 'r');
  try {
    const buf = Buffer.alloc(Math.min(s.size, TEXT_LIMIT));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead);
    const truncated = s.size > TEXT_LIMIT;
    if (head.includes(0) || (!truncated && !isUtf8(head))) return { path: rel, size: s.size, binary: true };
    const hash = truncated ? undefined : hashOf(head);
    if (since && hash === since) return { path: rel, same: true };
    return { path: rel, size: s.size, text: head.toString('utf8'), truncated, ...(hash ? { hash } : {}) };
  } finally { await handle.close(); }
}

/**
 * Save one file the owner edited. `base` is the hash it was read at: if the
 * file changed since (the agent wrote to it), nothing is written and
 * `{ conflict: true }` comes back. `base: null` makes a new file and refuses
 * one that exists. Secrets and git's own folder are never written.
 */
const saves = new Map();
export async function write(cwd, path, text, base) {
  const dir = await folder(cwd);
  const root = await canvasRoot(dir);
  const target = join(root, inside(path));
  // Compare and write together, including when two tabs name the same link.
  const key = await realpath(target).catch(() => target);
  const previous = saves.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => writeChecked(cwd, path, text, base));
  saves.set(key, next);
  try { return await next; }
  finally { if (saves.get(key) === next) saves.delete(key); }
}

async function writeChecked(cwd, path, text, base) {
  const dir = await folder(cwd);
  const rel = inside(path);
  if (typeof text !== 'string') throw new Error('nothing to save');
  if (Buffer.byteLength(text) > TEXT_LIMIT) throw new Error('this file is too long to save from here');
  const root = await canvasRoot(dir);
  if (isSecretPath(rel)) throw new Error('this file may hold passwords or keys; it is not saved from here');
  if (rel.split('/')[0] === '.git') throw new Error('that is git’s own folder');
  const realRoot = await realpath(root);
  const target = join(root, rel);
  const full = await realpath(target).catch(() => null);
  if (full) {
    if (!full.startsWith(realRoot + '/')) throw new Error('no such file in this folder');
    const resolved = relative(realRoot, full);
    if (isSecretPath(resolved)) throw new Error('this file may hold passwords or keys; it is not saved from here');
    if (resolved.split('/')[0] === '.git') throw new Error('that is git’s own folder');
    if (base === null) return { path: rel, exists: true };
    const s = await stat(full);
    if (!s.isFile()) throw new Error('that is not a file');
    const now = await readFile(full);
    if (now.includes(0) || !isUtf8(now)) throw new Error('this is not a text file');
    if (hashOf(now) !== base) return { path: rel, conflict: true };
    await writeFile(full, text);
  } else {
    if (base !== null) return { path: rel, conflict: true, gone: true };
    // A new file's folder may not exist yet. The nearest folder that does is
    // checked before anything is made, so a link cannot lead the new folders out.
    const within = (p) => p === realRoot || p.startsWith(realRoot + '/');
    let near = dirname(target);
    while (!existsSync(near)) near = dirname(near);
    if (!within(await realpath(near))) throw new Error('that is not a path inside the folder');
    await mkdir(dirname(target), { recursive: true });
    const parent = await realpath(dirname(target));
    if (!within(parent)) throw new Error('that is not a path inside the folder');
    await writeFile(join(parent, basename(target)), text, { flag: 'wx' });
  }
  return { path: rel, hash: hashOf(Buffer.from(text)), size: Buffer.byteLength(text) };
}

/**
 * One commit: who, when, the full message, and the files it touched. With a
 * `path`, that file's change in the commit as well. The hash must be a hash -
 * nothing a phone sends is passed to git as a ref name or an option.
 */
export async function commit(cwd, hash, path) {
  const dir = await folder(cwd);
  const root = await toplevel(dir);
  if (!root) throw new Error('not a git repository');
  const id = String(hash ?? '');
  if (!/^[0-9a-f]{4,64}$/i.test(id)) throw new Error('that is not a commit');
  const [meta, numstat] = await Promise.all([
    git(root, ['show', '-s', '--format=%H%x00%P%x00%an%x00%aI%x00%s%x00%b', id]),
    // The first parent is what a merge is read against; a root commit has none.
    git(root, ['show', '--format=', '--numstat', '-z', '--first-parent', '-m', id]).catch(() => ''),
  ]);
  const [full, parents, author, date, subject, body] = meta.split('\0');
  const files = [];
  const nums = numstat.split('\0');
  for (let i = 0; i < nums.length && files.length < FILE_LIMIT; i++) {
    const m = /^\n?(\d+|-)\t(\d+|-)\t(.*)$/.exec(nums[i] ?? '');
    if (!m) continue;
    let p = m[3];
    if (!p) { p = nums[i + 2] ?? ''; i += 2; }
    files.push({ path: p, add: m[1] === '-' ? 0 : Number(m[1]), del: m[2] === '-' ? 0 : Number(m[2]) });
  }
  const out = {
    hash: full, parents: parents ? parents.split(' ') : [], author, date, subject,
    body: (body ?? '').trim(), files,
  };
  if (path != null) {
    const rel = String(path);
    if (!rel || rel.includes('\0') || rel.startsWith('/') || rel.split('/').includes('..')) {
      throw new Error('that is not a path inside the folder');
    }
    const text = await git(root, ['show', '--no-color', '--format=', '--first-parent', '-m', id, '--', rel]).catch(() => '');
    out.diff = text.length > DIFF_LIMIT ? text.slice(0, DIFF_LIMIT) : text;
    out.truncated = text.length > DIFF_LIMIT;
  }
  return out;
}

/**
 * A second checkout of this repository on its own new branch, beside it.
 *
 * Two agents in one folder step on each other's edits; two folders do not. The
 * branch starts from whatever this one has checked out, and its name is
 * derived, never taken as typed, so nothing a phone sends can become a ref.
 */
export async function addWorktree(cwd, name) {
  const dir = await folder(cwd);
  const root = await toplevel(dir);
  if (!root) throw new Error('not a git repository');
  const slug = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';

  const exists = (b) => git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]).then(() => true, () => false);
  let suffix = 0, branch, path;
  do {
    const s = suffix ? `${slug}-${suffix + 1}` : slug;
    branch = `helm/${s}`;
    path = join(dirname(root), `${basename(root)}-${s}`);
    suffix += 1;
  } while ((existsSync(path) || await exists(branch)) && suffix < 30);
  if (existsSync(path)) throw new Error('could not find a free folder name for the worktree');

  const base = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  await git(root, ['worktree', 'add', '-b', branch, path]);
  return { path: collapse(path), branch, base, repo: collapse(root) };
}

/**
 * If `cwd` is a linked worktree, the repository it belongs to; otherwise null.
 *
 * A linked worktree has a `.git` *file* pointing into the main repository's
 * `.git/worktrees/<name>`, so this is a read of one small file - it is called
 * for every session when the machine screen asks for its projects. That is how
 * a comparison's five worktrees can sit under the one repo they came from.
 */
export function worktreeBase(cwd) {
  try {
    const dir = resolve(expand(String(cwd ?? '')));
    const marker = join(dir, '.git');
    if (!statSync(marker).isFile()) return null;
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(marker, 'utf8'));
    if (!m) return null;
    const parts = resolve(dir, m[1].trim()).split('/');
    const at = parts.lastIndexOf('worktrees');
    if (at < 2 || parts[at - 1] !== '.git') return null;
    return collapse(parts.slice(0, at - 1).join('/') || '/');
  } catch { return null; }
}

/** Local identity only: never fetch, and never infer CI for an unpublished commit. */
export async function githubContext(cwd, { resolveHost = async host => {
  const { stdout } = await exec('ssh', ['-G', host], { timeout: 5000, maxBuffer: 1024 * 1024 });
  return /^hostname\s+(\S+)$/m.exec(stdout)?.[1] || host;
} } = {}) {
  const dir = await folder(cwd);
  const [sha, branch, remotes, resolved, root] = await Promise.all([
    git(dir, ['rev-parse', 'HEAD']).then(s => s.trim()),
    git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']).then(s => s.trim()).catch(() => null),
    git(dir, ['remote', '-v']),
    git(dir, ['config', '--get-regexp', '^remote\\..*\\.gh-resolved$']).catch(() => ''),
    git(dir, ['rev-parse', '--show-toplevel']).then(s => s.trim()),
  ]);
  const parse = value => {
    const match = /^(?:https:\/\/|ssh:\/\/git@|git@)([^/:]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(value);
    if (!match || /[?@#]/.test(match[2] + match[3])) return null;
    const [, host, owner, name] = match;
    // Enterprise hosts are supported only when gh has explicitly selected them.
    return { host: host.toLowerCase(), repository: `${owner}/${name}`, owner };
  };
  const refs = new Map();
  for (const line of remotes.trim().split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line);
    if (m) {
      const r = parse(m[2]);
      if (r && r.host !== 'github.com' && /^(?:git@|ssh:\/\/)/.test(m[2])) {
        r.host = (await resolveHost(r.host).catch(() => r.host)).toLowerCase();
      }
      if (r) refs.set(m[1], r);
    }
  }
  const mark = resolved.trim().split('\n').map(line => /^remote\.(.+)\.gh-resolved\s+base$/.exec(line)).find(Boolean);
  const base = (mark && refs.get(mark[1])) || refs.get('upstream') || refs.get('github') || refs.get('origin') || (refs.size === 1 ? [...refs.values()][0] : null);
  if (!base || (base.host !== 'github.com' && !mark)) return null;
  const tracking = branch ? await git(dir, ['config', '--get', `branch.${branch}.remote`]).then(s => s.trim()).catch(() => '') : '';
  const head = refs.get(tracking) || refs.get('origin') || base;
  return { root, host: base.host, repository: base.repository, headRepository: head.host === base.host ? head.repository : base.repository,
    headOwner: head.host === base.host ? head.owner : base.owner, branch, sha };
}
