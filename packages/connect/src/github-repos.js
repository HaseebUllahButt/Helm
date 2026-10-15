import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { expand, collapse, HELM_DIR } from './paths.js';

/**
 * "Clone from GitHub" in the new chat box: the repos a machine's `gh` login
 * can reach, finding one that is not in that list, and cloning one.
 *
 * Everything goes through the GitHub CLI already on the machine, so Helm
 * keeps no GitHub login of its own and no secret ever leaves the machine:
 * the app sees repo and account names, nothing more. Helm never signs in
 * for you - with no login there, the app says to run `gh auth login` on
 * that machine. A clone is gh's own, so it follows whatever git setup
 * (https or ssh) that login chose.
 *
 * The list is kept on disk, so opening the box shows it at once, even after
 * a restart; it is fetched again only when it is old, when asked, or when a
 * search finds nothing in it.
 */

const exec = promisify(execFile);
const HOST = 'github.com';
const LOGIN = /^[\w.-]{1,100}$/;
const PART = /^(?!\.\.?$)[\w.-]{1,100}$/;
const PAGES = 10;                // 1,000 repos: more than anyone scrolls
const STALE_MS = 10 * 60_000;    // older than this, the app quietly asks again
const RECHECK_MS = 30_000;       // a search miss fetches the list again unless it is this new
const JOBS = 20;

const plain = (text) => String(text ?? '').replace(/\x1b\[[0-9;]*m/g, '').trim();
const lastLine = (text) => plain(text).split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean).pop() || '';

/** A repo as GitHub sends it, as the app sees it; null for anything unsafe to name a folder after. */
const toRepo = (r) => {
  if (typeof r?.full_name !== 'string' || !PART.test(r.owner?.login ?? '') || !PART.test(r.name ?? '')) return null;
  return {
    full: r.full_name, owner: r.owner.login, org: r.owner.type === 'Organization', name: r.name,
    private: !!r.private, fork: !!r.fork, archived: !!r.archived,
    desc: typeof r.description === 'string' ? r.description.slice(0, 200) : '',
    pushed: typeof r.pushed_at === 'string' ? r.pushed_at : null,
  };
};

export function createGithubRepos({ command = exec, start = spawn, fetch: request = globalThis.fetch,
  noteFolder = async () => {}, now = Date.now, cacheFile = join(HELM_DIR, 'github-repos.json') } = {}) {
  /** login -> { at, repos }: what GitHub last said, also on disk. */
  let lists = null;
  const jobs = new Map();
  let seq = 0;

  const held = () => {
    if (lists) return lists;
    lists = new Map();
    try {
      const saved = JSON.parse(readFileSync(cacheFile, 'utf8'));
      for (const [login, v] of Object.entries(saved ?? {})) {
        if (LOGIN.test(login) && Number.isFinite(v?.at) && Array.isArray(v?.repos)) lists.set(login, { at: v.at, repos: v.repos.filter((r) => PART.test(r?.owner ?? '') && PART.test(r?.name ?? '')) });
      }
    } catch { /* none yet */ }
    return lists;
  };
  const keep = (login, repos) => {
    const entry = { at: now(), repos };
    held().set(login, entry);
    try {
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(held())), { mode: 0o600 });
      renameSync(tmp, cacheFile);
    } catch { /* still held in memory */ }
    return entry;
  };

  /** The gh logins on this machine, or null when gh is not installed. */
  async function accounts() {
    const fromJson = (stdout) => (JSON.parse(stdout).hosts?.[HOST] || [])
      .filter((a) => LOGIN.test(a.login) && a.state === 'success')
      .map((a) => ({ login: a.login, active: !!a.active }));
    try {
      const { stdout } = await command('gh', ['auth', 'status', '--hostname', HOST, '--json', 'hosts'], { timeout: 15_000, maxBuffer: 1024 * 1024 });
      return fromJson(stdout);
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      // Signed out: gh says so on stderr and exits 1, with no JSON to read.
      if (e.stdout) try { return fromJson(e.stdout); } catch { /* not JSON */ }
      // A gh older than --json (2.45 on Ubuntu 24.04): read its own words.
      if (/unknown flag/i.test(`${e.stderr ?? ''}${e.message ?? ''}`)) return statusText();
      return [];
    }
  }

  async function statusText() {
    const text = await command('gh', ['auth', 'status', '--hostname', HOST], { timeout: 15_000, maxBuffer: 1024 * 1024 })
      .then((r) => `${r.stdout}\n${r.stderr}`, (e) => (e.code === 'ENOENT' ? null : `${e.stdout ?? ''}\n${e.stderr ?? ''}`));
    if (text === null) return null;
    return parseStatus(text);
  }

  async function token(login) {
    const env = { ...process.env };
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN']) delete env[key];
    const { stdout } = await command('gh', ['auth', 'token', '--hostname', HOST, '--user', login], { env, timeout: 8000, maxBuffer: 64 * 1024 });
    const value = stdout.trim();
    if (!value) throw new Error(`Sign in to GitHub as ${login} again.`);
    return value;
  }

  async function ask(login, path, { missingOk = false } = {}) {
    const res = await request(`https://api.${HOST}${path}`, {
      headers: { authorization: `Bearer ${await token(login)}`, accept: 'application/vnd.github+json', 'user-agent': 'helm' },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401) throw new Error(`GitHub signed ${login} out. Run gh auth login on this machine again.`);
    if (missingOk && (res.status === 404 || res.status === 422)) return null;
    if (!res.ok) throw new Error('Could not reach GitHub. Try again.');
    return res.json();
  }

  async function fetchRepos(login) {
    const out = [];
    for (let page = 1; page <= PAGES; page++) {
      const rows = await ask(login, `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`);
      for (const r of Array.isArray(rows) ? rows : []) { const x = toRepo(r); if (x) out.push(x); }
      if (!Array.isArray(rows) || rows.length < 100) break;
    }
    return out;
  }

  /** Which login a request is about: the one named, else gh's active one. */
  async function pick(login) {
    const all = await accounts();
    if (all === null) return { all, chosen: null };
    return { all, chosen: all.find((a) => a.login === login) ?? all.find((a) => a.active) ?? all[0] ?? null };
  }

  /**
   * { installed, accounts, login, repos, at, stale, parent } - the picker's
   * whole view. The list kept from last time comes back at once; `stale`
   * says it is old enough to be worth asking GitHub again, quietly.
   */
  async function repos({ login, refresh = false } = {}) {
    const { all, chosen } = await pick(login);
    const parent = existsSync(expand('~/dev')) ? '~/dev' : '~';
    if (all === null) return { installed: false, accounts: [], login: null, repos: [], parent };
    if (!chosen) return { installed: true, accounts: [], login: null, repos: [], parent };
    let list = held().get(chosen.login);
    if (refresh || !list) list = keep(chosen.login, await fetchRepos(chosen.login));
    return { installed: true, accounts: all, login: chosen.login, repos: list.repos, at: list.at, stale: list.at + STALE_MS < now(), parent };
  }

  /**
   * A search that found nothing in the list: get the list again (unless it
   * is brand new) and ask GitHub's own search, which also reaches public
   * repos nobody here belongs to. `found` is what the search turned up.
   */
  async function find({ login, query } = {}) {
    const q = String(query ?? '').trim().slice(0, 200);
    if (!q) throw new Error('Type part of the repo name.');
    const { chosen } = await pick(login);
    if (!chosen) throw new Error('The GitHub CLI here is not signed in.');
    let list = held().get(chosen.login);
    if (!list || list.at + RECHECK_MS < now()) list = keep(chosen.login, await fetchRepos(chosen.login));
    const found = [];
    const [owner, name, extra] = q.split('/');
    if (extra === undefined && PART.test(owner ?? '') && PART.test(name ?? '')) {
      const exact = toRepo(await ask(chosen.login, `/repos/${owner}/${name}`, { missingOk: true }));
      if (exact) found.push(exact);
    }
    const words = q.replace(/[^\w.\-/ ]+/g, ' ').trim();
    if (words) {
      const r = await ask(chosen.login, `/search/repositories?per_page=30&q=${encodeURIComponent(`${words.replace(/\//g, ' ')} in:name`)}`, { missingOk: true });
      // Repos of people and organizations already in the list first: those
      // are much more likely the one meant than a stranger's of that name.
      const known = new Set(list.repos.map((x) => x.owner.toLowerCase()).concat(chosen.login.toLowerCase()));
      const hits = (Array.isArray(r?.items) ? r.items : []).map(toRepo).filter(Boolean);
      hits.sort((a, b) => Number(!known.has(a.owner.toLowerCase())) - Number(!known.has(b.owner.toLowerCase())));
      for (const h of hits) if (!found.some((f) => f.full.toLowerCase() === h.full.toLowerCase())) found.push(h);
    }
    return { login: chosen.login, repos: list.repos, at: list.at, found: found.slice(0, 20) };
  }

  /** The repo is all there: its origin is that repo and it has a commit. */
  async function cloned(target, owner, name) {
    const origin = await command('git', ['-C', target, 'remote', 'get-url', 'origin'], { timeout: 8000 }).then((r) => r.stdout.trim(), () => '');
    const same = origin.toLowerCase().replace(/\.git$/, '').endsWith(`${owner}/${name}`.toLowerCase());
    if (!same) return 'other';
    const head = await command('git', ['-C', target, 'rev-parse', '--verify', 'HEAD'], { timeout: 8000 }).then(() => true, () => false);
    return head && !existsSync(join(target, '.git', 'index.lock')) ? 'done' : 'partial';
  }

  /**
   * Starts cloning `repo` into the folder `target` (a full path) and answers
   * at once: { state: 'done' } when that repo is already there, else a job
   * with `done` (settles when the clone does), `onProgress` and `cancel`.
   * `partialOk` lets a half-finished clone this same request started before
   * (a restart cut it off) be cleared and done again; nothing else is ever
   * removed.
   */
  async function begin({ repo, target, login, partialOk = false } = {}) {
    const [owner, name, extra] = String(repo ?? '').split('/');
    if (extra !== undefined || !PART.test(owner ?? '') || !PART.test(name ?? '')) throw new Error('Not a GitHub repo name.');
    if (login !== undefined && login !== null && !LOGIN.test(login)) throw new Error('Not a GitHub account.');
    const dir = expand(String(target ?? ''));
    if (!isAbsolute(dir) || dir === '/') throw new Error('Not a folder to clone into.');
    const parent = dirname(dir);
    if (existsSync(parent) && !statSync(parent).isDirectory()) throw new Error(`${collapse(parent)} is not a folder.`);
    const path = collapse(dir);
    for (const j of jobs.values()) if (j.path === path && j.state === 'cloning') return j;
    // Already cloned there: use it rather than fail.
    if (existsSync(dir)) {
      const there = await cloned(dir, owner, name);
      if (there === 'done') return { state: 'done', percent: 100, path, existed: true };
      if (there === 'partial' && partialOk) rmSync(dir, { recursive: true, force: true });
      else throw new Error(`${path} is already there. Pick another folder.`);
    }
    const env = { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' };
    // A login other than gh's active one clones with that login's own access.
    if (login) {
      const active = (await accounts())?.find((a) => a.active)?.login;
      if (login !== active) { env.GH_TOKEN = await token(login); delete env.GITHUB_TOKEN; }
    }
    const id = `c${now().toString(36)}${(++seq).toString(36)}`;
    const listeners = new Set();
    let settle;
    const j = { id, repo: `${owner}/${name}`, state: 'cloning', percent: 0, path, error: '', log: '',
      done: new Promise((r) => { settle = r; }),
      onProgress: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      cancel: () => {} };
    jobs.set(id, j);
    while (jobs.size > JOBS) {
      const old = [...jobs.values()].find((x) => x.state !== 'cloning');
      if (!old) break;
      jobs.delete(old.id);
    }
    const finish = (state, error = '') => {
      if (j.state !== 'cloning') return;
      Object.assign(j, { state, error, percent: state === 'done' ? 100 : j.percent });
      for (const fn of listeners) fn(j);
      settle(j);
    };
    // Its own process group, so stopping it stops git under gh too, and git
    // takes away the half-made folder as it goes.
    const child = start('gh', ['repo', 'clone', `${owner}/${name}`, dir, '--', '--progress'], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    j.cancel = () => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
      finish('failed', 'Stopped.');
    };
    // git counts objects and then files; the two together are the bar.
    const read = (chunk) => {
      j.log = (j.log + chunk).slice(-4000);
      const recv = [...j.log.matchAll(/Receiving objects:\s+(\d+)%/g)].pop();
      const files = [...j.log.matchAll(/(?:Resolving deltas|Updating files):\s+(\d+)%/g)].pop();
      const percent = Math.min(99, Math.round(files ? 80 + Number(files[1]) * 0.19 : recv ? Number(recv[1]) * 0.8 : j.percent));
      if (percent !== j.percent) { j.percent = percent; for (const fn of listeners) fn(j); }
    };
    child.stdout?.on('data', read); child.stderr?.on('data', read);
    child.on('error', () => finish('failed', 'The GitHub CLI (gh) is not installed here.'));
    child.on('close', (code) => {
      if (code === 0) { finish('done'); void noteFolder(dir, true).catch(() => {}); }
      else finish('failed', cloneError(j.log));
    });
    return j;
  }

  /**
   * Before the box closes: is `target` free ('new'), already this repo
   * ('there' - the chat just opens in it), or something else ('other')?
   */
  async function check({ repo, target } = {}) {
    const [owner, name, extra] = String(repo ?? '').split('/');
    if (extra !== undefined || !PART.test(owner ?? '') || !PART.test(name ?? '')) throw new Error('Not a GitHub repo name.');
    const dir = expand(String(target ?? ''));
    if (!isAbsolute(dir) || dir === '/') throw new Error('Not a folder to clone into.');
    const parent = dirname(dir);
    if (existsSync(parent) && !statSync(parent).isDirectory()) return { state: 'other', path: collapse(dir), reason: `${collapse(parent)} is a file, not a folder.` };
    if (!existsSync(dir)) return { state: 'new', path: collapse(dir) };
    for (const j of jobs.values()) if (j.path === collapse(dir) && j.state === 'cloning') return { state: 'new', path: collapse(dir) };
    return { state: (await cloned(dir, owner, name)) === 'done' ? 'there' : 'other', path: collapse(dir) };
  }

  /** The new chat box's older way in: start a clone into `parent`, then follow it by `job`. */
  async function clone({ repo, parent = '~', login, job } = {}) {
    if (job) {
      const j = jobs.get(job);
      if (!j) throw new Error('That clone is no longer known here.');
      return { job, state: j.state, percent: j.percent, path: j.path, error: j.error || undefined };
    }
    const [, name] = String(repo ?? '').split('/');
    if (!PART.test(name ?? '')) throw new Error('Not a GitHub repo name.');
    const j = await begin({ repo, target: join(expand(String(parent || '~')), basename(name)), login });
    return j.id ? { job: j.id, state: j.state, percent: j.percent, path: j.path } : j;
  }

  return { repos, find, check, begin, clone };
}

/**
 * `gh auth status` as words, from a gh too old for --json:
 *   ✓ Logged in to github.com account me (keyring)   - 2.40 and later
 *   ✓ Logged in to github.com as me (~/.config/gh)    - before that
 *   - Active account: true
 */
export function parseStatus(text) {
  const out = [];
  for (const line of plain(text).split(/\r?\n/)) {
    const ok = line.match(/✓ Logged in to \S+ (?:account|as) ([\w.-]+)/);
    if (ok && LOGIN.test(ok[1])) { out.push({ login: ok[1], active: false }); continue; }
    if (/^\s*[xX✗] /.test(line)) out.push(null);
    const active = line.match(/Active account:\s*(true|false)/);
    if (active && out.at(-1)) out.at(-1).active = active[1] === 'true';
  }
  const list = out.filter(Boolean);
  if (list.length && !list.some((a) => a.active)) list[0].active = true;
  return list;
}

function cloneError(log) {
  const text = plain(log);
  if (/Repository not found|Could not resolve to a Repository/i.test(text)) return 'GitHub says that repo is not there, or this account cannot see it.';
  if (/Permission denied \(publickey\)/i.test(text)) return 'GitHub did not accept this machine\'s SSH key.';
  if (/could not resolve host|unable to access/i.test(text)) return 'Could not reach GitHub. Try again.';
  return lastLine(text.split('\n').filter((l) => !/%/.test(l)).join('\n')) || 'Clone failed.';
}
