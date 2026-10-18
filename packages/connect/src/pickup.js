/**
 * `helm pickup`: where earlier work in this folder got to, built on demand.
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
import { resolve } from 'node:path';
import { M } from '@helm/protocol';
import { stripBrief } from '@helm/protocol/brief';
import { fold, shortId, ago } from './brain.js';

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
  const here = sessions.filter((s) => ours(s) && within(s.cwd, roots));
  const readable = (s) => !String(s.id).startsWith('pane:') && !String(s.id).startsWith('found:');
  const newest = (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  return {
    earlier: here.filter((s) => readable(s) && !s.delegation?.parentId && !isRunning(s)).sort(newest).slice(0, limit),
    running: here.filter(isRunning).sort(newest),
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
 * folder (this one and each chat's other checkout) what is uncommitted and
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

/** The page an agent reads. Short on purpose: it lands in its context. */
export function renderPickup({ chats, running, git, now = Date.now() }) {
  const out = [];
  if (!chats.length) out.push('No earlier chat in this folder. `helm pickup <chat-id>` reads a named one.');
  for (const { machine, session: s, summary } of chats) {
    out.push(`Chat ${shortId(s.id)} on ${machine}: ${s.title || 'untitled'} (${s.engine}, ${s.status}, ${ago(s.updatedAt, now)}) in ${s.cwd}`);
    if (summary.asked) out.push(`  Asked: ${summary.asked}`);
    if (summary.lastAsked) out.push(`  Last asked: ${summary.lastAsked}`);
    if (summary.ended) out.push(`  Its last turn ended: ${summary.ended}.`);
    if (summary.left) {
      out.push(summary.found ? '  Its final reply says what is left:' : '  The end of its final reply:');
      for (const l of summary.left.split('\n')) out.push(`    ${l}`);
    } else out.push('  It never replied.');
    out.push('');
  }
  if (git.log) {
    out.push(git.log.length ? 'Commits here since then:' : 'No commits here since then.');
    for (const l of git.log) out.push(`  ${l}`);
  }
  for (const f of git.folders) {
    const where = f.own ? `This checkout (${f.branch})` : `${f.dir} (${f.branch})`;
    if (f.unmerged.length) {
      out.push(`${where} has commits not in this one:`);
      for (const l of f.unmerged) out.push(`  ${l}`);
    }
    if (f.dirty.length) {
      out.push(`${where}, uncommitted (may belong to a running chat):`);
      for (const l of f.dirty) out.push(`  ${l}`);
    } else if (f.own) out.push(`${where}: nothing uncommitted.`);
  }
  if (running.length) {
    out.push('Running here now - do not edit the same files; `helm say <id>` asks them:');
    for (const s of running) out.push(`  ${shortId(s.id)}  ${s.title || 'untitled'} (${s.status}) in ${s.cwd}`);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/**
 * Gather and render. `rpc(env, method, params)` reaches a machine's Helm;
 * `find(id)` resolves a typed chat id across the network the way
 * `helm thread` does.
 */
export async function pickup({ id = null, cwd = process.cwd(), self, selfName = 'this machine', sessionId = null, limit = 3, rpc, find, git = run, now = Date.now() }) {
  const roots = repoRoots(cwd, git);
  const listed = (await rpc(self, M.SESSION_LIST, { includeDelegations: true })).sessions ?? [];
  const { earlier, running } = chooseChats(listed, { roots, self: sessionId, limit });
  const picked = id ? [await find(id)] : earlier.map((session) => ({ env: self, machine: selfName, session }));
  const chats = await Promise.all(picked.map(async ({ env, machine, session }) => {
    const [head, tail] = await Promise.all([
      rpc(env, M.SESSION_EVENTS, { id: session.id, since: 0, limit: 40 }),
      rpc(env, M.SESSION_EVENTS, { id: session.id, tail: 400 }),
    ]);
    const summary = chatSummary(head.events ?? [], tail.events ?? []);
    return { machine, session: { ...session, ...(tail.session ?? {}) }, summary };
  }));
  const starts = chats.map((c) => c.session.createdAt ?? c.summary.startedAt).filter(Boolean);
  const state = gitState(cwd, chats.map((c) => c.session), { git, since: starts.length ? Math.min(...starts) : null });
  return renderPickup({ chats, running, git: state, now });
}
