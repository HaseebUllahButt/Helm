import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, readFile, realpath } from 'node:fs/promises';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { expand, collapse } from './paths.js';

/**
 * What a session has done to its folder, as git sees it.
 *
 * The phone asks about a folder it has chosen, so every call resolves that to a
 * real directory first, and the one argument that names a file inside it is
 * refused if it could point anywhere else. Nothing here writes to a repo except
 * `addWorktree`, which only ever adds a sibling checkout on a new branch.
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
    if (x === 'R' || x === 'C') parts.shift(); // the name it had before
    files.push({
      path,
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
  return { path: collapse(path), branch, base };
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

/** The pull request for this branch, if `gh` is here and there is one. Never throws. */
export async function pullRequest(cwd) {
  try {
    const dir = await folder(cwd);
    const { stdout } = await exec('gh', ['pr', 'view', '--json', 'number,title,url,state,isDraft,reviewDecision'], { cwd: dir, timeout: 8000, maxBuffer: 1024 * 1024 });
    const p = JSON.parse(stdout);
    return { number: p.number, title: p.title, url: p.url, state: p.state, draft: !!p.isDraft, review: p.reviewDecision || null };
  } catch { return null; }
}
