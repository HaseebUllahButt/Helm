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
import { resolve } from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { expand } from './paths.js';

/** Only the same local Codex account can share the parent's context. */
export function codexHelperFork(parent, parentProfile, profile, cwd, worktree, socket) {
  if (!parent?.engineSessionId || parent.engine !== 'codex' || profile.engine !== 'codex'
    || !parentProfile || parentProfile.wraps || profile.wraps || worktree || !socket
    || resolve(expand(parent.cwd)) !== resolve(expand(cwd))
    || accountKey(parentProfile) !== accountKey(profile)) return null;
  const before = materialize(parentProfile), after = materialize(profile);
  const home = spec => resolve(expand(spec.env.CODEX_HOME || process.env.CODEX_HOME || '~/.codex'));
  if (before.cmd !== after.cmd || home(before) !== home(after)) return null;
  if ([...new Set([...Object.keys(before.env), ...Object.keys(after.env)])]
    .some(key => key !== 'CODEX_HOME' && before.env[key] !== after.env[key])) return null;
  return { threadId: parent.engineSessionId, nativeSocket: socket, note: helperNote(parent.id) };
}

/** Restore only this helper's accepted turns, including saved tool results. */
export function codexHelperHistory(events) {
  const turns = new Set(events.filter(e => e.type === 'turn.start' && !String(e.turnId).startsWith('local-')).map(e => e.turnId));
  const items = new Set(events.filter(e => e.type === 'item.start' && turns.has(e.turnId)).map(e => e.id));
  const accepted = events.filter(e => e.type === 'turn.start' ? turns.has(e.turnId) : items.has(e.id));
  const results = new Map();
  for (const event of accepted) {
    if (event.type === 'item.delta') results.set(event.id, (results.get(event.id) ?? '') + (event.text ?? ''));
    if (event.output != null) results.set(event.id, String(event.output));
    if (event.changes) results.set(event.id, JSON.stringify(event.changes));
  }
  return fold(accepted).turns.map(turn => [
    `Task: ${turn.text}`,
    ...turn.items.filter(item => item.kind !== 'thinking').map(item => item.kind === 'text'
      ? `Reply: ${item.text}`
      : `Tool: ${item.name ?? item.kind}\nInput: ${JSON.stringify(item.input)}\nResult: ${item.output ?? results.get(item.id) ?? item.text ?? ''}${item.error ? `\nError: ${item.error}` : ''}`),
  ].join('\n')).join('\n\n');
}

/** Read the saved log only on recovery, including work outside the recent window. */
export async function readCodexHelperHistory(file) {
  const events = [];
  try {
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'turn.start' || /^item\.(?:start|delta|update|done)$/.test(event.type)) events.push(event);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return codexHelperHistory(events);
}

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
 * Keep helpers visible to the owner. Same-account Codex helpers can reuse
 * their parent's context; other engines and accounts start a new chat.
 */
export function delegationNote() {
  return '[Helm helpers: Do the work yourself by default. For a side task that would flood your context or truly runs in parallel, start a Helm helper with helm delegate, never your CLI\'s own subagent tool, so the owner can open, message and stop it. Keep it attached to this chat: never unset HELM_SESSION_ID or start one detached. Use --model cheap for mechanical work; keep judgment calls yourself. Keep your helpers: the owner reads them under this chat. When done, remove the worktrees, branches and scratch folders you made, and delete (helm delete) only test chats that are not helpers.]';
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
  return '[Helm agent messages: Talk to other agents with helm say and helm reply. Reply only when useful; never trade acknowledgements.]';
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

/**
 * Only for a helper: its final reply goes back to the parent once. A wake-up
 * after that (a background watcher timing out) is never relayed, so news
 * worth a parent's attention goes by agent message instead.
 */
export function helperNote(parentId) {
  return `[Helm helper: You are a helper for chat ${parentId}. Your final reply goes back to it once, as the result. Report once. Later notes, such as a stale background watcher timing out, never reach it; do not write them. Send truly new, needed news with helm say ${parentId} -- "text".]`;
}

// Only notes for tools this machine can use: each one rides along in every session.
const toolNotes = (parentId) => [parentId && helperNote(parentId), delegationNote(), pickupNote(), agentMessageNote(), visualNote(), browserReady() && browserNote(), writingNote(), ownerNote()].filter(Boolean).join('\n');

export function helmBrief(net, { parentId = null } = {}) {
  const machines = Object.values(net?.machines ?? {});
  const self = net?.machines?.[net?.self];
  const seen = new Set();
  const others = machines
    .filter((m) => m.id !== net?.self && m.name && !seen.has(m.name) && seen.add(m.name))
    .map((m) => (m.kind ? `${m.name} (${m.kind})` : m.name));
  if (!self?.name || !others.length) return toolNotes(parentId);
  return `[Helm: you are running on ${self.name}, one of the owner's machines joined by Helm. The others: ${others.join(', ')}. Reach them through helm (helm exec, helm copy, helm spawn), not SSH: helm help lists every command and helm <command> --help explains one. Never rerun a helm exec that may have started; read it with helm exec-status. Links from helm share (spins) end after 3 hours; add --keep only when the owner asks.]
${toolNotes(parentId)}`;
}

/**
 * How every agent writes for people: Simplified Technical English (the
 * ASD-STE100 rules), cut down to what fits in every session. It covers every
 * message a person may read, to the owner or to another agent, never code,
 * commands or quoted output. Helm's own screens follow the same rules
 * (AGENTS.md).
 */
export function writingNote() {
  return '[Helm writing: These rules replace your usual reply style. Write every message in Simplified Technical English (ASD-STE100): replies to the owner, helm say and reply messages, helper tasks, commit messages. Put the answer or result first. One idea per sentence: at most 20 words for a step, 25 for an explanation. Start an instruction with its verb. Use active voice, simple tenses, common words and one word for one meaning. Explain jargon in a few plain words. Put steps in a list. Skip preamble and recaps; cut filler, hedging and repeats. Tell the owner what they will see, not how the code works. Code, commands and quoted output stay as they are.]';
}

export function visualNote() {
  return '[Helm visuals: Use plain text by default, including reviews, comparisons and progress reports. Make or publish visuals only when the owner asks. Keep verification screenshots private unless asked to show them. Skills must follow the owner\'s chosen format. Report useful findings based on evidence; do not stop at a fixed count. For a requested visual, make one self-contained HTML file, check it with helm preview, then publish it with helm render (helm render --help has the limits). Use helm canvas <file-or-spin-url> to open requested project files, visuals or live pages beside the chat.]';
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

export { parseAgentArgs } from './agent-args.js';

export function chooseAgent(agents, account) {
  const exact = agents.find((p) => p.id === account);
  if (exact) return exact;
  const want = String(account).toLowerCase();
  const hits = agents.filter((p) => p.engine === want || p.id.toLowerCase().startsWith(want));
  if (hits.length !== 1) throw new Error(hits.length
    ? `ambiguous account "${account}": ${hits.map((p) => p.id).join(', ')}`
    : `no CLI account "${account}" here; accounts: ${agents.map((p) => p.id).join(', ') || 'none'} (helm agents shows models)`);
  return hits[0];
}
