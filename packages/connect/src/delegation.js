import { ENGINES } from './engines.js';
import { materialize } from './profiles.js';
import { listModels } from './models.js';
import { modelPrefs, startPrefs, subagentPrefs, accountKey } from './settings.js';
import { modesFor, defaultMode } from './modes.js';
import { credentialScan } from './credentials.js';
import { fold } from './brain.js';
import { activeTurnFromEvents } from './events.js';
import { createHash } from 'node:crypto';
import { browserNote, browserReady } from './browser.js';
import { loadOwner } from '../../protocol/owner.js';

/** Public capabilities and optional credential metadata, never secret values. */
export async function agentCatalog(profiles, statuses, { models = true, credentials = false } = {}) {
  return Promise.all(profiles.filter((p) => !p.disabled && ENGINES[p.engine]?.driver).map(async (p) => {
    const auth = statuses.get(p.id) ?? 'unknown';
    const account = createHash('sha256').update(accountKey(p)).digest('hex').slice(0, 16);
    const row = { id: p.id, label: p.label, engine: p.engine, account, auth,
      available: auth !== 'unauthenticated', modes: modesFor(p.engine),
      defaults: startPrefs(p), subagentDefaults: subagentPrefs(p),
      defaultMode: startPrefs(p)?.mode === 'plan' ? defaultMode(p.engine) : startPrefs(p)?.mode ?? defaultMode(p.engine) };
    if (credentials) row.credentials = credentialScan(p);
    if (!models || !row.available) return row;
    const spec = materialize(p);
    const engine = ENGINES[p.engine];
    try {
      const catalog = await listModels(p.engine, spec.env?.[engine.homeEnv] ?? engine.defaultHome,
        spec.env, p.wraps ? { cmd: spec.cmd, args: spec.args } : null);
      const labels = Object.fromEntries((catalog.models ?? []).filter((id) => catalog.labels?.[id])
        .map((id) => [id, catalog.labels[id]]));
      return { ...row, models: catalog.models, labels,
        defaultModel: modelPrefs(p)?.default ?? catalog.default ?? null,
        cheapModel: cheapModel(p.engine, catalog.models), refreshing: !!catalog.refreshing };
    } catch { return { ...row, models: [], defaultModel: null }; }
  }));
}

/**
 * Mark the rows the new-chat picker shows on this machine: one per account,
 * its plainest signed-in alias, and none for an account hidden there. A
 * helper is offered that same short list, not every alias the shell defines.
 */
export function markShown(agents, profiles, hidden = []) {
  const off = new Set(hidden);
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const best = new Map();
  for (const row of agents) {
    const p = byId.get(row.id);
    if (!p || !row.available) continue;
    const key = accountKey(p);
    if (off.has(key)) continue;
    const now = best.get(key);
    if (!now || (p.args ?? []).length < (byId.get(now.id).args ?? []).length) best.set(key, row);
  }
  const picked = new Set(best.values());
  for (const row of agents) row.shown = picked.has(row);
  return agents;
}

/**
 * The account's cheapest capable model, for mechanical helper work. Lists
 * come newest first (models.js), so the first match is the current small
 * model, not a retired one. Null when the catalog has no small tier - the
 * caller then names a model itself rather than guessing.
 */
const CHEAP_TIER = {
  claude: /haiku/i,
  gemini: /flash-lite|flash/i,
  codex: /nano|mini/i,
};
export function cheapModel(engine, models = []) {
  // A tier word starts a part of the name: "gpt-5-mini", never the "mini" in "gemini".
  const want = CHEAP_TIER[engine] ?? /(?:^|[^a-z])(?:haiku|flash|mini|nano|lite|spark)/i;
  return models.find((m) => want.test(m)) ?? null;
}

/**
 * Doing the work yourself is the default: a helper costs a fresh context, a
 * second plan draw, and a result the owner has to read twice. The CLI's own
 * subagents are the normal way to fan out; Helm's delegate exists for the
 * one thing they cannot do, which is run on another CLI or account.
 */
export function delegationNote() {
  return '[Helm: Do the work yourself by default. When a side task would flood your context or genuinely runs in parallel, start a Helm helper, not your CLI\'s own subagent tool: the owner can open, message and stop it. helm delegate same --wait --json -- "<task>" uses this chat\'s account; name another from helm agents when the work needs another CLI or account; --model cheap for mechanical work (searching, reading, summarising, running checks); keep judgment calls yourself. Discover accounts/models with helm agents --json only when needed. Inspect package scripts before assuming file arguments restrict a suite. Rerun checks only for changed code, failures or unresolved concerns; report what passed and what remains untested. Keep every helper attached to this chat: never unset HELM_SESSION_ID or start one detached, so it shows as a card inside this chat and not as a separate chat in Running. --cwd <folder> runs it in another folder; --worktree gives it its own checkout of this repo on a new helm/ branch, so several helpers never edit the same files (merge the branch back yourself). If you made worktrees, branches or scratch folders, clean them up once everything is merged: git worktree remove, delete the merged branch, remove the folder. Leave none behind. Never leave chats you started only to test something: delete them when done (helm thread lists them). Finished children release their runtime after 30 seconds idle and resume the same conversation on follow-up; Claude children keep their saved context for an hour, so follow-ups are cheap.]';
}

/**
 * What every agent Helm starts is told about where it is: which of the
 * owner's machines it runs on, the others, and how to act on them. "Go to
 * the VM and restart nginx" should not need the owner to explain how to get
 * there. Commands use Helm's authenticated machine connection directly.
 *
 * Kept to a few lines: it rides along in every session.
 */
export function agentMessageNote() {
  return '[Helm agent messages: Send a short question or useful detail to another agent with helm say <chat-id> -- "text". It names you as the sender. Reply to a received message with helm reply <message-id> -- "text"; read exchanges with helm messages --json. Each agent keeps its own conversation. Messages wait for the next turn, without interrupting work. Reply only when useful; do not trade acknowledgements.]';
}

/**
 * Where an agent's account of its work goes. A handoff file every agent may
 * add to only grows (HANDOFF.md reached 30,000 words), so there is none:
 * commits hold what was done, the final reply what is left, and
 * `helm pickup` (pickup.js) reads both back for the next agent.
 */
export function pickupNote() {
  return '[Helm pickup: What you did goes in commit messages, what is left in your final reply; Helm keeps both, so write no handoff files. To continue earlier work, run helm pickup.]';
}

/**
 * The owner's preferences, the same list on every machine (protocol/owner.js),
 * kept fresh from chats by the keeper (owner-keeper.js). Knowledge about the
 * owner lives here; knowledge about a project stays in that repo's AGENTS.md.
 * An empty list is no note at all.
 */
export function ownerNote(record = loadOwner()) {
  const lines = record?.lines ?? [];
  return lines.length ? `[Helm owner: What the owner wants from every agent:\n${lines.map((l) => `- ${l}`).join('\n')}]` : '';
}

// Only notes for tools this machine can use: each one rides along in every session.
const toolNotes = () => [delegationNote(), pickupNote(), agentMessageNote(), visualNote(), browserReady() && browserNote(), writingNote(), ownerNote()].filter(Boolean).join('\n');

export function helmBrief(net) {
  const machines = Object.values(net?.machines ?? {});
  const self = net?.machines?.[net?.self];
  const seen = new Set();
  const others = machines
    .filter((m) => m.id !== net?.self && m.name && !seen.has(m.name) && seen.add(m.name))
    .map((m) => (m.kind ? `${m.name} (${m.kind})` : m.name));
  if (!self?.name || !others.length) return toolNotes();
  return `[Helm: you are running on ${self.name}, one of the owner's machines joined by Helm. The others: ${others.join(', ')}.
- Run something on another machine: helm exec <machine> --cwd <absolute-path> -- <command> [args]. This uses Helm's managed connection; prefer it to SSH. For pipelines use -- sh -lc '<script>'. Pass environment explicitly with --env NAME=value. If it says the command may have started, never rerun it: read it with helm exec-status <machine> <command-id> --wait, or stop it with helm exec-cancel <machine> <command-id>.
- Copy files there: helm copy <machine> <file-or-folder> [--target-folder <path>] (default: the same place; ~ is that machine's home).
- Which machines are on and what is running where: helm digest. Read a session: helm thread <id>. Message it: helm say <id> <text>.
- Start an agent on another machine: helm spawn <machine> <folder> <account> <task>.
- Show the owner something running on a port (a dev server, a page, a preview, a UI change) from anywhere, phone included: helm share <port> [--name <name>] [--password] prints a public https link. Call these spins. A spin is short-lived: it ends by itself after 3 hours, so do not plan on it lasting longer. Add --keep only when the owner asks for a link that stays. Add --private when only the owner's own signed-in devices should open it. helm forward <machine> <port> opens a port another machine shared on this one's localhost. helm share list shows the links; helm share stop <name> ends one when it is no longer needed.]
${toolNotes()}`;
}

/**
 * How every agent writes to the owner: Simplified Technical English (the
 * ASD-STE100 rules), cut down to what fits in every session. It covers
 * words meant for people, never code, commands or quoted output.
 */
export function writingNote() {
  return '[Helm writing: Write to the owner in Simplified Technical English (ASD-STE100). Keep sentences short: at most 20 words for a step, 25 for an explanation. Put one instruction in each sentence and start it with the verb. Use the active voice and simple tenses. Use common words, and use one word for one meaning: call a thing by the same name each time. Do not use jargon; when a technical name is necessary, explain it in a few plain words. Tell the owner what they will see, not how the code does it. Use a list for steps that follow in sequence. These rules apply to replies, summaries and notes for people, not to code, commands, file contents or quoted output.]';
}

export function visualNote() {
  return '[Helm visuals: Use an inline visual when a diagram, chart, comparison, simulation, or interactive explanation would help the user. Write a self-contained HTML file with inline CSS/JS, then run helm preview <file.html> --output <preview.png> (optionally --width 390 for mobile). Inspect the screenshot and reported JavaScript errors; correct it before publishing with helm render <file.html> --title "<short title>". Render saves a snapshot in this chat, works across providers, and does not keep the agent working. Local image paths in img/srcset, SVG images, and CSS url() are embedded; each image must be a recognized image up to 2 MiB and the whole page up to 4 MiB. Use CSS variables --bg, --card, --text, --text-dim, --line, --primary-q for theme-aware visuals. Scripts run inside an isolated frame: no app state, network fetch, external scripts, or forms; use inline SVG/canvas and vanilla JS. A visual needs no dev server or background watcher. The owner sees it above your reply, so do not announce or repeat it; add only what it does not show. Prefer plain text for simple answers.]';
}

/** Read-only parents cannot acquire write access through a different CLI. */
export function delegationMode(engine, parentMode, requested, configured = null, parentEngine = engine) {
  const modes = modesFor(engine);
  if (requested === 'plan') throw new Error('plan mode is not supported for subagents; dispatch a task instead');
  const readOnly = ['plan', 'readonly', 'read'].includes(parentMode);
  const safe = readOnly ? modes.find((m) => ['readonly', 'read'].includes(m.id)) : null;
  if (readOnly && !safe) throw new Error(`${engine} has no verified read-only delegation mode`);
  if (requested && !modes.some((m) => m.id === requested)) {
    throw new Error(`invalid subagent mode: ${requested}`);
  }
  if (readOnly && requested && !['readonly', 'read'].includes(requested)) {
    throw new Error('a read-only parent requires a read-only subagent');
  }
  const parent = modesFor(parentEngine).find((m) => m.id === parentMode);
  const inherited = parent && modes.find((m) => m.short === parent.short)?.id;
  return requested || safe?.id || (configured !== 'plan' && modes.some((m) => m.id === configured) ? configured : null)
    || inherited || defaultMode(engine);
}

/**
 * A turn the agent began on its own (a background task finishing), not one we
 * sent. Drivers mark it `wake: true`; the `wake-` id is how the ones that make
 * up their own ids say so, and how a log written before the flag reads.
 */
export const isWakeTurn = (turn) => !!turn && (turn.wake === true || String(turn.turnId ?? '').startsWith('wake-'));

const turnTexts = (turn) => (turn?.items ?? []).filter((i) => i.kind === 'text').map((i) => i.text);

/** One turn as the log folds it, or undefined when the log no longer holds it. */
export const turnOf = (events, turnId) => fold(events).turns.find((t) => t.turnId === turnId);

/** What the agent wrote in one turn, for a short follow-up after the result went out. */
export const turnText = (turn) => turnTexts(turn).join('\n\n');

// `active` comes from the whole log when the caller has it: a long task
// pushes its own turn.start out of a tail window, and without it the task
// looked finished while it was still working.
export function delegationOutput(session, events, active = activeTurnFromEvents(events)) {
  const { turns, pending } = fold(events);
  const turn = turns.at(-1);
  // The task's answer is its last real turn plus anything it added on waking
  // up afterwards, so a late wake-up doesn't replace the report.
  let from = turns.length - 1;
  while (from > 0 && isWakeTurn(turns[from])) from--;
  const output = turns.slice(Math.max(from, 0)).flatMap(turnTexts).join('\n\n');
  // A mid-turn steering message has its own optimistic turn.start but the
  // provider finishes the original turn. That trailing ticket must not make
  // a completed task look busy forever on another device.
  const settled = !['starting', 'working', 'blocked'].includes(session.status)
    && ['done', 'error', 'interrupted'].includes(session.delegation?.status)
    ? session.delegation.status : null;
  // The other way round: a restart closes the tickets of messages already
  // handed to a CLI that is still working. Its own turn is still open, so the
  // task is not finished just because the newest card is.
  const running = ['starting', 'working'].includes(session.status) && !!active;
  const complete = !!settled || (!!turn?.status && !running);
  const status = !complete && (pending || session.status === 'blocked') ? 'blocked'
    : settled || (complete ? (turn.status === 'ok' ? 'done' : turn.status) : 'working');
  return { session, status, complete, output: output.slice(-32_000), truncated: output.length > 32_000,
    error: turn?.items.findLast((i) => i.error)?.error ?? events.findLast((e) => e.type === 'turn.done')?.error ?? null,
    pending: pending ? { requestId: pending.requestId, title: pending.title, kind: pending.kind } : null };
}

/** Keep a bounded reply even when streaming deltas outgrow the event window. */
export function trackDelegationReply(session, event) {
  if (!session.delegation) return;
  if (event.type === 'turn.start') {
    // A wake-up continues the same reply rather than starting a new one.
    if (event.wake && session.delegationReply) session.delegationReply.turnId = event.turnId;
    else session.delegationReply = { turnId: event.turnId, textIds: [], output: '', truncated: false };
  }
  const reply = session.delegationReply;
  if (!reply) return;
  if (event.type === 'item.start' && event.kind === 'text' && !event.parentId) {
    reply.textIds = [...reply.textIds.slice(-63), event.id];
    if (reply.output) {
      reply.output += '\n\n';
      if (reply.output.length > 32_000) { reply.output = reply.output.slice(-32_000); reply.truncated = true; }
    }
  }
  if (event.type === 'item.delta' && reply.textIds.includes(event.id)) {
    reply.output += event.text ?? '';
    if (reply.output.length > 32_000) { reply.output = reply.output.slice(-32_000); reply.truncated = true; }
  }
}

/** Flags consume their values; task words after -- are always literal. */
export function parseAgentArgs(args, { values = [], switches = [] } = {}) {
  const options = {}, words = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { words.push(...args.slice(i + 1)); break; }
    if (!arg.startsWith('--')) { words.push(arg); continue; }
    const name = arg.slice(2);
    if (Object.hasOwn(options, name)) throw new Error(`--${name} was given more than once`);
    if (switches.includes(name)) options[name] = true;
    else if (values.includes(name)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value`);
      options[name] = value;
    } else throw new Error(`unknown option: ${arg}`);
  }
  return { options, words };
}

export function chooseAgent(agents, account) {
  const exact = agents.find((p) => p.id === account);
  if (exact) return exact;
  const want = String(account).toLowerCase();
  const hits = agents.filter((p) => p.engine === want || p.id.toLowerCase().startsWith(want));
  if (hits.length !== 1) throw new Error(hits.length
    ? `ambiguous account "${account}": ${hits.map((p) => p.id).join(', ')}`
    : `no CLI account "${account}"; run helm agents`);
  return hits[0];
}
