import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expand, collapse } from './paths.js';

/**
 * "From GitHub" in the new chat box: the repos a machine's `gh` login can
 * reach, and cloning one into a folder.
 *
 * Everything goes through the GitHub CLI already on the machine, so Helm
 * keeps no GitHub login of its own and no secret ever leaves the machine:
 * the app sees repo and account names, nothing more. Helm never signs in
 * for you - with no login there, the app says to run `gh auth login` on
 * that machine. A clone is gh's own, so it follows whatever git setup
 * (https or ssh) that login chose.
 */

const exec = promisify(execFile);
const HOST = 'github.com';
const LOGIN = /^[\w.-]{1,100}$/;
const PART = /^(?!\.\.?$)[\w.-]{1,100}$/;
const PAGES = 10;            // 1,000 repos: more than anyone scrolls
const FRESH_MS = 2 * 60_000; // the list is asked for again after this
const JOBS = 20;

const plain = (text) => String(text ?? '').replace(/\x1b\[[0-9;]*m/g, '').trim();
const lastLine = (text) => plain(text).split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean).pop() || '';

export function createGithubRepos({ command = exec, start = spawn, fetch: request = globalThis.fetch,
  noteFolder = async () => {}, now = Date.now } = {}) {
  const lists = new Map();
  const jobs = new Map();
  let seq = 0;

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

  async function fetchRepos(login) {
    const auth = await token(login);
    const out = [];
    for (let page = 1; page <= PAGES; page++) {
      const res = await request(`https://api.${HOST}/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`, {
        headers: { authorization: `Bearer ${auth}`, accept: 'application/vnd.github+json', 'user-agent': 'helm' },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 401) throw new Error(`GitHub signed ${login} out. Sign in again.`);
      if (!res.ok) throw new Error('Could not reach GitHub. Try again.');
      const rows = await res.json();
      for (const r of Array.isArray(rows) ? rows : []) {
        if (typeof r?.full_name !== 'string' || !PART.test(r.owner?.login ?? '') || !PART.test(r.name ?? '')) continue;
        out.push({
          full: r.full_name, owner: r.owner.login, org: r.owner.type === 'Organization', name: r.name,
          private: !!r.private, fork: !!r.fork, archived: !!r.archived,
          desc: typeof r.description === 'string' ? r.description.slice(0, 200) : '',
          pushed: typeof r.pushed_at === 'string' ? r.pushed_at : null,
        });
      }
      if (!Array.isArray(rows) || rows.length < 100) break;
    }
    return out;
  }

  /** { installed, accounts, login, repos, parent } - the picker's whole view. */
  async function repos({ login, refresh = false } = {}) {
    const all = await accounts();
    const parent = existsSync(expand('~/dev')) ? '~/dev' : '~';
    if (all === null) return { installed: false, accounts: [], login: null, repos: [], parent };
    const chosen = all.find((a) => a.login === login) ?? all.find((a) => a.active) ?? all[0];
    if (!chosen) return { installed: true, accounts: [], login: null, repos: [], parent };
    let held = lists.get(chosen.login);
    if (refresh || !held || held.at + FRESH_MS < now()) {
      held = { at: now(), repos: await fetchRepos(chosen.login) };
      lists.set(chosen.login, held);
    }
    return { installed: true, accounts: all, login: chosen.login, repos: held.repos, parent };
  }

  /** Starts a clone and answers at once; ask again with `job` to follow it. */
  async function clone({ repo, parent = '~', login, job } = {}) {
    if (job) {
      const j = jobs.get(job);
      if (!j) throw new Error('That clone is no longer known here.');
      return { job, state: j.state, percent: j.percent, path: j.path, error: j.error || undefined };
    }
    const [owner, name, extra] = String(repo ?? '').split('/');
    if (extra !== undefined || !PART.test(owner ?? '') || !PART.test(name ?? '')) throw new Error('Not a GitHub repo name.');
    if (login !== undefined && !LOGIN.test(login)) throw new Error('Not a GitHub account.');
    const base = expand(String(parent || '~'));
    if (existsSync(base) && !statSync(base).isDirectory()) throw new Error(`${collapse(base)} is not a folder.`);
    const target = join(base, name);
    const path = collapse(target);
    // Already cloned there: open it rather than fail.
    if (existsSync(target)) {
      const origin = await command('git', ['-C', target, 'remote', 'get-url', 'origin'], { timeout: 8000 }).then((r) => r.stdout.trim(), () => '');
      if (origin.toLowerCase().replace(/\.git$/, '').endsWith(`${owner}/${name}`.toLowerCase())) return { state: 'done', percent: 100, path, existed: true };
      throw new Error(`${path} is already there. Pick another folder.`);
    }
    for (const j of jobs.values()) if (j.path === path && j.state === 'cloning') return { job: j.id, state: j.state, percent: j.percent, path };
    const env = { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' };
    // A login other than gh's active one clones with that login's own access.
    if (login) {
      const active = (await accounts())?.find((a) => a.active)?.login;
      if (login !== active) { env.GH_TOKEN = await token(login); delete env.GITHUB_TOKEN; }
    }
    const id = `c${now().toString(36)}${(++seq).toString(36)}`;
    const j = { id, state: 'cloning', percent: 0, path, error: '', log: '' };
    jobs.set(id, j);
    while (jobs.size > JOBS) jobs.delete(jobs.keys().next().value);
    const child = start('gh', ['repo', 'clone', `${owner}/${name}`, target, '--', '--progress'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    // git counts objects and then files; the two together are the bar.
    const read = (chunk) => {
      j.log = (j.log + chunk).slice(-4000);
      const recv = [...j.log.matchAll(/Receiving objects:\s+(\d+)%/g)].pop();
      const files = [...j.log.matchAll(/(?:Resolving deltas|Updating files):\s+(\d+)%/g)].pop();
      j.percent = Math.min(99, Math.round(files ? 80 + Number(files[1]) * 0.19 : recv ? Number(recv[1]) * 0.8 : j.percent));
    };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.on('error', () => { j.state = 'failed'; j.error = 'The GitHub CLI (gh) is not installed here.'; });
    child.on('close', (code) => {
      if (j.state !== 'cloning') return;
      if (code === 0) { j.state = 'done'; j.percent = 100; void noteFolder(target, true).catch(() => {}); }
      else { j.state = 'failed'; j.error = cloneError(j.log); }
    });
    return { job: id, state: j.state, percent: 0, path };
  }

  return { repos, clone };
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
