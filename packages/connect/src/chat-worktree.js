import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addWorktree, worktreeBase } from './git.js';
import { collapse, expand } from './paths.js';

/**
 * Every chat in an opted-in repo works in its own git worktree.
 *
 * Many chats editing one checkout swept each other's half-done work into
 * their commits. A repo opts in with a committed `helm.json` at its root:
 * `{"worktrees": "per-chat", "setup": "<shell command>"}`. A new chat there
 * gets a sibling checkout on a new branch from the repo's current branch,
 * made usable at once (dependencies linked, never installed), and its folder
 * is removed again once its branch is merged back and the chat is idle, or
 * after an hour of quiet when it never committed anything.
 */

const exec = promisify(execFile);
const git = (cwd, args) => exec('git', ['-C', cwd, ...args], { maxBuffer: 8 * 1024 * 1024, timeout: 30_000 }).then((r) => r.stdout.trim());
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
/** The checkout this Helm runs from: a chat there works on the install itself. */
const SELF = real(fileURLToPath(new URL('../../..', import.meta.url)));

/** `helm.json` at a repo root, or null when it is missing or says nothing usable. */
export function repoConfig(root) {
  try {
    const raw = JSON.parse(readFileSync(join(root, 'helm.json'), 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return { worktrees: raw.worktrees === 'per-chat' ? 'per-chat' : null,
      setup: typeof raw.setup === 'string' && raw.setup.trim() ? raw.setup.trim() : null };
  } catch { return null; }
}

/**
 * Whether a new chat in `cwd` gets its own worktree: the folder is in a repo
 * whose `helm.json` asks for one, and is not already a linked worktree (a
 * helper started with --worktree, or a chat opened in another chat's copy),
 * nor the checkout this Helm runs from.
 */
export async function worktreePlan(cwd) {
  const dir = resolve(expand(String(cwd ?? '')));
  if (!existsSync(dir)) return null;
  const root = await git(dir, ['rev-parse', '--show-toplevel']).catch(() => null);
  if (!root || worktreeBase(root) || real(root) === SELF) return null;
  const config = repoConfig(root);
  if (config?.worktrees !== 'per-chat') return null;
  return { root, rel: relative(real(root), real(dir)), setup: config.setup };
}

/** The current branch, or the commit when HEAD is detached. */
const baseOf = async (root) => {
  const branch = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '');
  return branch || git(root, ['rev-parse', 'HEAD']);
};

/**
 * The worktree for chat `id`, on `helm/chat-<id>` until the chat has a name.
 * `start` is the commit it began from: a branch still there has no work yet.
 */
export async function makeChatWorktree(plan, id) {
  const base = await baseOf(plan.root);
  const start = await git(plan.root, ['rev-parse', 'HEAD']);
  const made = await addWorktree(plan.root, `chat-${id}`);
  const path = expand(made.path);
  const links = linkCheckout(plan.root, path);
  return { record: { repo: collapse(plan.root), path: made.path, branch: made.branch, base, start }, cwd: plan.rel ? join(path, plan.rel) : path, links };
}

/** Caches a tool writes into; shared with the main checkout they would mix two trees' builds. */
const CACHES = new Set(['.cache', '.vite', '.vite-temp']);

/**
 * Give a fresh worktree the main checkout's dependencies without installing.
 *
 * Each `node_modules` entry links to the main checkout's entry, so built
 * native modules (node-pty) come along. A link to one of the repo's own
 * workspace packages is recreated instead, so it resolves inside this
 * worktree: linked through, `@helm/connect` would run the main checkout's
 * code from here. Nested `node_modules` and `.env*` files get the same, and
 * nothing already in the worktree is touched. Returns what it made.
 */
export function linkCheckout(main, worktree) {
  const made = [];
  const realMain = realpathSync(main);
  const modules = join(realMain, 'node_modules');
  const ownPackage = (target) => (target === realMain || target.startsWith(`${realMain}/`))
    && target !== modules && !target.startsWith(`${modules}/`) && !target.includes('/node_modules/');

  const link = (target, at) => { symlinkSync(target, at); made.push(at); };
  const entry = (from, to, name, depth) => {
    const src = join(from, name), dst = join(to, name);
    if (existsSync(dst) || lstatExists(dst)) return;
    const st = lstatSync(src);
    if (st.isSymbolicLink()) {
      let real = null;
      try { real = realpathSync(src); } catch { /* a dangling link is copied as it is */ }
      if (real && ownPackage(real)) {
        // Same link text when relative (the tree around it is the same);
        // an absolute one is moved from the main checkout to this worktree.
        const text = readlinkSync(src);
        return link(isAbsolute(text) ? join(worktree, relative(realMain, real)) : text, dst);
      }
      return link(src, dst);
    }
    // A scope (`@helm`) or `.bin` can hold links to workspace packages, so
    // it becomes a real folder whose entries are handled one by one.
    if (st.isDirectory() && depth === 0 && (name.startsWith('@') || name === '.bin')) {
      mkdirSync(dst);
      for (const inner of readdirSync(src)) entry(src, dst, inner, 1);
      return;
    }
    link(src, dst);
  };
  const folder = (from, to) => {
    if (existsSync(to) || lstatExists(to) || !existsSync(dirname(to))) return;
    mkdirSync(to);
    made.push(to);
    for (const name of readdirSync(from)) if (!CACHES.has(name)) entry(from, to, name, 0);
  };

  for (const rel of scan(realMain)) {
    const src = join(realMain, rel);
    const dst = join(worktree, rel);
    if (rel === 'node_modules' || rel.endsWith('/node_modules')) folder(src, dst);
    else if (!lstatExists(dst) && existsSync(dirname(dst))) link(src, dst);
  }
  return made;
}

const lstatExists = (p) => { try { lstatSync(p); return true; } catch { return false; } };

/**
 * `node_modules` folders and `.env*` files in the main checkout, a few
 * levels down (workspace packages sit at `packages/x`), never inside a
 * `node_modules` or `.git`.
 */
function scan(root, max = 3) {
  const out = [];
  const walk = (rel, depth) => {
    let names;
    try { names = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      const path = rel ? `${rel}/${d.name}` : d.name;
      if (d.name === 'node_modules' && d.isDirectory()) out.push(path);
      else if (/^\.env/.test(d.name) && d.isFile()) out.push(path);
      else if (d.isDirectory() && d.name !== '.git' && depth < max) walk(path, depth + 1);
    }
  };
  walk('', 1);
  return out;
}

/**
 * The repo's own setup command, run once in a new worktree. Bounded by a
 * generous timeout so a command that never ends cannot keep the chat from
 * ever starting; the owner sees the error and the agent starts anyway.
 */
export const SETUP_TIMEOUT_MS = 10 * 60_000;
export function runSetup(command, cwd, { timeout = SETUP_TIMEOUT_MS } = {}) {
  return new Promise((done) => {
    let output = '';
    const child = spawn('sh', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    const keep = (b) => { output = (output + b).slice(-4000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => { output += `\n(stopped after ${Math.round(timeout / 60_000)} minutes)`; child.kill('SIGTERM'); }, timeout);
    timer.unref?.();
    child.on('error', (err) => { clearTimeout(timer); done({ ok: false, output: err.message }); });
    child.on('close', (code) => { clearTimeout(timer); done({ ok: code === 0, output: output.trim() }); });
  });
}

const slug = (title) => String(title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
const branchExists = (root, b) => git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]).then(() => true, () => false);

/**
 * Name the branch after the chat once it has a title, while it holds no
 * commits and the name is free. Only the branch: the folder stays, because
 * the agent runs in it and the CLI files its conversation under that path.
 */
export async function renameChatBranch(record, title) {
  const name = slug(title);
  if (!name || !existsSync(expand(record.path))) return null;
  const branch = `helm/${name}`;
  if (branch === record.branch) return null;
  const dir = expand(record.path);
  const tip = await git(dir, ['rev-parse', `refs/heads/${record.branch}`]).catch(() => null);
  if (!tip || tip !== record.start || await branchExists(dir, branch)) return null;
  await git(dir, ['branch', '-m', record.branch, branch]);
  return branch;
}

/**
 * Why a chat's worktree must stay, or null when it can go: the branch tip
 * is already in the base (`merged` asks for at least one commit of its own
 * too) and nothing is left uncommitted. Links Helm made do not count as
 * changes.
 */
export async function keepReason(record, { merged = true } = {}) {
  const dir = expand(record.path);
  if (!existsSync(dir)) return 'gone';
  const tip = await git(dir, ['rev-parse', `refs/heads/${record.branch}`]).catch(() => null);
  if (!tip) return 'no branch';
  if (merged && tip === record.start) return 'no commits';
  const base = await git(dir, ['rev-parse', '--verify', '--quiet', `${record.base}^{commit}`]).catch(() => null);
  if (!base) return 'no base';
  const inBase = await exec('git', ['-C', dir, 'merge-base', '--is-ancestor', tip, base]).then(() => true, () => false);
  if (!inBase) return 'unmerged';
  const main = await mainCheckout(dir);
  const raw = await git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  const changes = raw.split('\0').filter(Boolean).filter((line) => {
    if (!line.startsWith('?? ')) return true;
    return !helmLink(join(dir, line.slice(3).replace(/\/$/, '')), main);
  });
  return changes.length ? 'uncommitted' : null;
}

/** A `node_modules` folder or a link into the main checkout: what linkCheckout made. */
function helmLink(path, main) {
  if (/(^|\/)node_modules$/.test(path)) return true;
  try {
    if (!lstatSync(path).isSymbolicLink()) return false;
    const target = realpathSync(path);
    return !!main && (target === main || target.startsWith(`${main}/`));
  } catch { return false; }
}

async function mainCheckout(dir) {
  const common = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => null);
  if (!common) return null;
  try { return realpathSync(common.replace(/\/\.git\/?$/, '')); } catch { return null; }
}

/** Remove the folder and its branch. Callers check keepReason first. */
export async function removeChatWorktree(record) {
  const dir = expand(record.path);
  const repo = expand(record.repo);
  // --force: the links and node_modules Helm made are untracked files, and
  // keepReason has already said that nothing else is.
  await git(repo, ['worktree', 'remove', '--force', dir]);
  await git(repo, ['branch', '-D', record.branch]).catch(() => {});
}

/**
 * A reopened chat whose folder is gone: check its branch out there again,
 * or start the branch afresh from the base when that is gone too, so the
 * agent resumes in the same path its conversation was filed under. Returns
 * the record as it now is (a fresh branch has a new start), or null.
 */
export async function restoreChatWorktree(record) {
  const dir = expand(record.path);
  if (existsSync(dir)) return null;
  const repo = expand(record.repo);
  await git(repo, ['worktree', 'prune']).catch(() => {});
  let start = record.start;
  if (await branchExists(repo, record.branch)) await git(repo, ['worktree', 'add', dir, record.branch]);
  else {
    // Its work is already in the base; from here only new commits count.
    await git(repo, ['worktree', 'add', '-b', record.branch, dir, record.base]);
    start = await git(dir, ['rev-parse', 'HEAD']);
  }
  linkCheckout(repo, dir);
  return { ...record, start };
}

/** The one line an agent in such a worktree is told. */
export function worktreeNote(s) {
  const w = s?.chatWorktree;
  if (!w) return '';
  return `[Helm worktree: This chat has its own git worktree and branch (git branch --show-current), made from ${w.base}. When your work is verified, merge it into ${w.base} in ${w.repo} yourself and resolve any clashes. Helm removes this worktree once it is merged.]`;
}
