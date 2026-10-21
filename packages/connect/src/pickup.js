/**
 * `helm pickup`: where earlier work in this project got to, on every machine,
 * built on demand.
 *
 * Helm used to keep a hand-written HANDOFF.md for this, and it grew to
 * 30,000 words: a file every agent may add to only grows, however strict its
 * rules. So nothing is written for the next agent any more. What was done is
 * in commit messages; what is left is the final reply of the chat that did
 * it, which Helm keeps anyway. This reads both, plus git, and prints a page
 * short enough to land in an agent's context. Nothing is stored, no model is
 * called, and a chat nobody picks up costs nothing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { M } from '@helm/protocol';
import { stripBrief } from '@helm/protocol/brief';
import { fold, shortId, ago } from './brain.js';
import { projectKeys, sameProject } from './project-key.js';

const RUNNING = new Set(['working', 'blocked']);
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const cap = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const isRunning = (s) => RUNNING.has(s.status) || !!s.team?.working || !!s.team?.blocked;

/** A folder belongs to the work when it is one of the repo's checkouts, or inside one. */
export function within(cwd, roots) {
  if (!cwd) return false;
  const dir = resolve(cwd);
  return roots.some((r) => dir === r || dir.startsWith(`${r}/`));
}

/**
 * Every checkout of the repo this folder is in, so a chat that worked in a
 * worktree still counts as "this repo". Outside git, just the folder.
 */
export function repoRoots(cwd, git = run) {
  const list = git(cwd, ['worktree', 'list', '--porcelain']);
  if (list == null) return [resolve(cwd)];
  return list.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => resolve(l.slice(9)));
}

/**
 * A helper's own checkout came from this repo, even after it was removed.
 * New ones record the repo; older ones sit beside it as `<repo>-<task>`.
 */
export function fromRepo(worktree, roots) {
  if (!worktree?.path) return false;
  const home = (p) => resolve(String(p).replace(/^~(?=\/|$)/, homedir()));
  if (worktree.repo) return roots.includes(home(worktree.repo));
  const path = home(worktree.path);
  return roots.some((r) => dirname(path) === dirname(r) && basename(path).startsWith(`${basename(r)}-`));
}

/**
 * Which chats to read, and which are busy here now.
 *
 * Earlier work is the newest finished top-level chats. A helper's result
 * already went back to the chat that started it, so helpers are left out of
 * that list; but a running helper still edits files, so it shows as busy.
 * Anything without its own event log (a bare terminal, a CLI found on disk)
 * has no reply to read.
 */
export function chooseChats(sessions, { roots, self = null, limit = 3 }) {
  const ours = (s) => s.id !== self && s.delegation?.parentId !== self;
  const workedHere = (s) => within(s.cwd, roots) || fromRepo(s.delegation?.worktree, roots);
  // A chat in another folder that sent helpers here holds their results and
  // its own "what is left", so it counts as earlier work in this repo.
  const sentHelpers = new Set(sessions.filter((s) => s.delegation?.parentId && workedHere(s)).map((s) => s.delegation.parentId));
  const here = sessions.filter((s) => ours(s) && (workedHere(s) || sentHelpers.has(s.id)));
  const readable = (s) => !String(s.id).startsWith('pane:') && !String(s.id).startsWith('found:');
  const newest = (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  return {
    earlier: here.filter((s) => readable(s) && !s.delegation?.parentId && !isRunning(s)).sort(newest).slice(0, limit),
    running: here.filter((s) => isRunning(s) && workedHere(s)).sort(newest),
  };
}

// A line that opens the part of a reply about what is not done yet:
// "What is left:", "## Next steps", "**What to build next:**", "Not checked".
const LEFT = /^(?:what\b[^:\n]{0,30}?\b(?:left|next|remains|open|not done)|left(?: to do)?|next(?: steps?| up)?|still (?:open|to do|left)|remaining|open(?: work| items)?|not (?:done|checked|verified)(?: yet)?|to ?do|untested|follow[- ]ups?)\b/i;

function leftHeading(line) {
  const bare = line.replace(/^[\s#>*_-]+/, '');
  const m = bare.match(LEFT);
  if (!m) return false;
  // "Next, I ran the tests" is prose, not a heading: a heading is marked up,
  // ends its keyword with a colon or dash, or is the whole line.
  const after = bare.slice(m[0].length);
  return /^[#*]/.test(line.trim()) || /^[\s*_]*[:\-–—]/.test(after) || /^\W*$/.test(after);
}

/**
 * What a turn asked, as one line. A message from another agent arrives
 * wrapped in Helm's reply instructions (agent-messages.js); only who sent it
 * and what it says matter here.
 */
function askText(text) {
  const said = stripBrief(text);
  const wrapped = said.match(/^\[Helm agent message [^\]]*\]\nFrom (.+?) \([^\n]*\n[\s\S]*?\n\n([\s\S]*)$/);
  return flat(wrapped ? `(message from ${wrapped[1]}) ${wrapped[2]}` : said);
}

/**
 * What a chat was asked and where it says it stopped.
 *
 * `head` is the start of the log (the first ask), `tail` its end (the final
 * reply). The final reply's "left / next" part is the handover; a reply
 * without one gives its last few lines, which is where agents put it anyway.
 */
export function chatSummary(head = [], tail = []) {
  const first = fold(head).turns.find((t) => t.text);
  const { turns } = fold(tail);
  const asks = turns.filter((t) => t.text && !t.wake);
  const lastAsk = asks[asks.length - 1] && askText(asks[asks.length - 1].text);
  const firstAsk = first && askText(first.text);
  const replied = [...turns].reverse().find((t) => t.items.some((i) => i.kind === 'text' && i.text.trim()));
  const reply = replied ? [...replied.items].reverse().find((i) => i.kind === 'text' && i.text.trim()).text : '';
  const lines = reply.split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) if (leftHeading(lines[i])) at = i;
  let left = (at >= 0 ? lines.slice(at) : lines).map((l) => cap(l.trimEnd(), 300)).filter((l) => l.trim());
  if (at < 0) left = left.slice(-4);
  const text = left.join('\n');
  const lastTurn = turns[turns.length - 1];
  return {
    asked: firstAsk ? cap(firstAsk, 300) : null,
    lastAsked: lastAsk && lastAsk !== firstAsk ? cap(lastAsk, 200) : null,
    left: cap(text, 900),
    found: at >= 0,
    ended: lastTurn?.status && lastTurn.status !== 'ok' ? lastTurn.status : null,
    startedAt: head[0]?.at ?? null,
  };
}

function run(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trimEnd();
  } catch { return null; }
}

const lines = (s, n) => {
  const all = (s ?? '').split('\n').filter(Boolean);
  return all.length > n ? [...all.slice(0, n), `… and ${all.length - n} more`] : all;
};

/**
 * Git's part: commits on this checkout since the oldest chat began, and per
 * folder (this one and each listed chat's checkout) what is uncommitted and
 * what that checkout's branch has that this one does not - work a chat left
 * on a worktree branch and never merged.
 */
export function gitState(cwd, chats, { git = run, since = null } = {}) {
  const out = { log: null, folders: [] };
  if (git(cwd, ['rev-parse', '--git-dir']) == null) return out;
  const head = git(cwd, ['rev-parse', 'HEAD']);
  const here = git(cwd, ['rev-parse', '--show-toplevel']);
  if (since) out.log = lines(git(cwd, ['log', '--oneline', '--no-decorate', `--since=@${Math.floor(since / 1000)}`, 'HEAD']), 10);
  const seen = new Set();
  for (const dir of [cwd, ...chats.map((c) => c.cwd)]) {
    const top = dir && existsSync(dir) ? git(dir, ['rev-parse', '--show-toplevel']) : null;
    if (!top || seen.has(top)) continue;
    seen.add(top);
    const dirty = lines(git(top, ['status', '--short']), 10);
    const own = top === here;
    const unmerged = !own && head ? lines(git(top, ['log', '--oneline', '--no-decorate', `${head}..HEAD`]), 6) : [];
    const branch = git(top, ['branch', '--show-current']) || 'detached';
    if (own || dirty.length || unmerged.length) out.folders.push({ dir: top, branch, own, dirty, unmerged });
  }
  return out;
}

// A machine its snapshot saw this recently is up but slow, not asleep.
const LATELY_MS = 2 * 60_000;
const silence = (at, now) => (now - at < LATELY_MS ? `not answering, last seen ${ago(at, now)}` : `offline, last seen ${ago(at, now)}`);

/** Where a chat is: this machine, another one now, or one seen a while ago. */
const where = ({ machine, offlineAt }, now) => (offlineAt ? `${machine} (${silence(offlineAt, now)})` : machine);

/** The page an agent reads. Short on purpose: it lands in its context. */
export function renderPickup({ chats, running, git, unchecked = [], now = Date.now() }) {
  const out = [];
  if (!chats.length) out.push('This project has no earlier chats. Run `helm pickup <chat-id>` to read a specific chat.');
  for (const c of chats) {
    const { session: s, summary } = c;
    out.push(`Chat ${shortId(s.id)} on ${where(c, now)}: ${s.title || 'untitled'} (${s.engine}, ${s.status}, ${ago(s.updatedAt, now)}) in ${s.cwd}`);
    if (!summary) {
      // An offline machine's chat: only the line its digest saved.
      if (s.last) out.push(`  Last seen doing: ${cap(flat(s.last), 300)}`);
      out.push(`  Read replies with \`helm pickup ${shortId(s.id)}\` when ${c.machine} is online.`);
      out.push('');
      continue;
    }
    if (summary.asked) out.push(`  Asked: ${summary.asked}`);
    if (summary.lastAsked) out.push(`  Last asked: ${summary.lastAsked}`);
    if (summary.ended) out.push(`  Its last reply ended: ${summary.ended}.`);
    if (summary.left) {
      out.push(summary.found ? '  Its final reply says what is left:' : '  The end of its final reply:');
      for (const l of summary.left.split('\n')) out.push(`    ${l}`);
    } else out.push(summary.unread ? `  Helm did not read this chat from ${c.machine}.` : '  It never replied.');
    out.push('');
  }
  if (git.log) {
    out.push(git.log.length ? 'Commits here since then:' : 'No commits here since then.');
    for (const l of git.log) out.push(`  ${l}`);
  }
  for (const f of git.folders) {
    const at = f.own ? `This project copy (${f.branch})` : `${f.dir} (${f.branch})`;
    if (f.unmerged.length) {
      out.push(`${at} has commits not in this one:`);
      for (const l of f.unmerged) out.push(`  ${l}`);
    }
    if (f.dirty.length) {
      out.push(`${at} has changes without commits. Check Running chats before editing:`);
      for (const l of f.dirty) out.push(`  ${l}`);
    } else if (f.own) out.push(`${at} has no changes without commits.`);
  }
  if (running.length) {
    out.push('Check Running chats before editing the same files. Ask them with `helm say <id>`:');
    for (const r of running) {
      const state = r.offlineAt ? `${r.session.status} when last seen` : r.session.status;
      out.push(`  ${shortId(r.session.id)}  ${r.session.title || 'untitled'} (${state}) on ${where(r, now)} in ${r.session.cwd}`);
    }
  }
  const away = [...new Set([...chats, ...running].filter((c) => !c.here).map((c) => c.machine))];
  if (away.length) {
    out.push(`Helm does not show commits without pushes or files without commits on ${away.join(', ')}.`
      + ' Run `helm exec <machine> --cwd <folder> -- git status` to check them.');
  }
  const why = new Map();
  for (const u of unchecked) why.set(u.why, [...(why.get(u.why) ?? []), u.seen ? `${u.machine} (${u.seen})` : u.machine]);
  for (const [reason, names] of why) out.push(`Not checked, ${reason}: ${names.join(', ')}.`);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

const OLD_HELM = 'the older Helm cannot identify the project in each folder';

/**
 * One machine's chats in this project.
 *
 * A machine that answers names the project of each of its chats' folders
 * itself (`projects`, from project-key.js), because the same repo sits at a
 * different path on each machine. This machine also matches by path, which
 * keeps folders outside git and older local daemons working. A machine that
 * does not answer is read from the last snapshot of it, marked offline.
 */
export function machineChats({ env, machine, here, listed, saved, keys, roots, sessionId, limit, now = Date.now() }) {
  if (listed) {
    const { sessions = [], projects } = listed;
    if (!projects && !here) return { unchecked: OLD_HELM };
    const matched = Object.entries(projects ?? {}).filter(([, k]) => sameProject(k, keys)).map(([dir]) => resolve(dir));
    const picked = chooseChats(sessions, { roots: here ? [...roots, ...matched] : matched, self: sessionId, limit });
    const tag = (session) => ({ env, machine, here, session });
    return { earlier: picked.earlier.map(tag), running: picked.running.map(tag) };
  }
  if (!saved?.at) return { unchecked: 'not answering and nothing saved' };
  const sessions = saved.sessions ?? [];
  if (keys.length && sessions.length && !sessions.some((s) => s.project)) {
    return { unchecked: 'not answering, and its saved list does not say which project a folder holds', seen: silence(saved.at, now) };
  }
  const ours = sessions.filter((s) => s.id !== sessionId && sameProject(s.project, keys));
  const tag = (session) => ({ env, machine, here: false, offlineAt: saved.at, session });
  const newest = (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  return {
    earlier: ours.filter((s) => !isRunning(s) && !s.delegation?.parentId).sort(newest).slice(0, limit).map(tag),
    running: ours.filter(isRunning).sort(newest).map(tag),
  };
}

/**
 * Gather and render, across every machine.
 *
 * `rpc(env, method, params)` reaches a machine's Helm patiently (this one);
 * `peerRpc` reaches another one quickly, so one asleep machine cannot hold
 * the page up. `find(id)` resolves a typed chat id across the network the
 * way `helm thread` does. `snapshots` are saved digests of every machine
 * (this machine's and the brain's; values or promises), for machines that
 * do not answer.
 */
export async function pickup({
  id = null, cwd = process.cwd(), self, selfName = 'this machine', machines = null, sessionId = null, limit = 3,
  rpc, peerRpc = rpc, find, snapshots = [], git = run, now = Date.now(),
}) {
  const roots = repoRoots(cwd, git);
  const keys = await projectKeys(cwd, git);
  const names = { ...Object.fromEntries(Object.entries(machines ?? {}).map(([env, m]) => [env, m?.name ?? env])), [self]: selfName };
  const ask = (env) => (env === self ? rpc : peerRpc)(env, M.SESSION_LIST, { includeDelegations: true, projects: true });
  const lists = await Promise.all(Object.keys(names).map(async (env) => [env, env === self ? await ask(env) : await ask(env).catch(() => null)]));
  const snaps = await Promise.all(snapshots ?? []);
  const saved = (env) => snaps.map((s) => s?.machines?.[env]).filter(Boolean).sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0];
  const earlier = [];
  const running = [];
  const unchecked = [];
  for (const [env, listed] of lists) {
    const here = env === self;
    const got = machineChats({ env, machine: names[env], here, listed, saved: here ? null : saved(env), keys, roots, sessionId, limit, now });
    if (got.unchecked) { unchecked.push({ machine: names[env], why: got.unchecked, seen: got.seen }); continue; }
    earlier.push(...got.earlier);
    running.push(...got.running);
  }
  const newest = (a, b) => (b.session.updatedAt ?? 0) - (a.session.updatedAt ?? 0);
  running.sort(newest);
  let picked = earlier.sort(newest).slice(0, limit);
  if (id) {
    const hit = await find(id);
    picked = [{ ...hit, here: hit.env === self }];
  }
  const chats = await Promise.all(picked.map(async (c) => {
    if (c.offlineAt) return { ...c, summary: null };
    const read = c.here ? rpc : peerRpc;
    try {
      const [head, tail] = await Promise.all([
        read(c.env, M.SESSION_EVENTS, { id: c.session.id, since: 0, limit: 40 }),
        read(c.env, M.SESSION_EVENTS, { id: c.session.id, tail: 400 }),
      ]);
      return { ...c, session: { ...c.session, ...(tail.session ?? {}) }, summary: chatSummary(head.events ?? [], tail.events ?? []) };
    } catch (err) {
      if (c.here) throw err;
      return { ...c, summary: { left: '', unread: true } };
    }
  }));
  const local = chats.filter((c) => c.here);
  const starts = local.map((c) => c.session.createdAt ?? c.summary?.startedAt).filter(Boolean);
  // Running chats' checkouts too: their unmerged and uncommitted work is
  // exactly what the next agent must not trip over. Only this machine's: a
  // path on another machine may name a different folder here.
  const state = gitState(cwd, [...local, ...running.filter((r) => r.here)].map((c) => c.session), { git, since: starts.length ? Math.min(...starts) : null });
  return renderPickup({ chats, running, git: state, unchecked, now });
}
