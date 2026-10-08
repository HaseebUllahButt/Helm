import { ENGINES } from './engines.js';
import { materialize } from './profiles.js';
import { listModels } from './models.js';
import { modelPrefs, startPrefs, accountKey } from './settings.js';
import { modesFor, defaultMode } from './modes.js';
import { credentialScan } from './credentials.js';
import { fold } from './brain.js';
import { createHash } from 'node:crypto';

/** Public capabilities and optional credential metadata, never secret values. */
export async function agentCatalog(profiles, statuses, { models = true, credentials = false } = {}) {
  return Promise.all(profiles.filter((p) => !p.disabled && ENGINES[p.engine]?.driver).map(async (p) => {
    const auth = statuses.get(p.id) ?? 'unknown';
    const account = createHash('sha256').update(accountKey(p)).digest('hex').slice(0, 16);
    const row = { id: p.id, label: p.label, engine: p.engine, account, auth,
      available: auth !== 'unauthenticated', modes: modesFor(p.engine),
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
        defaultModel: modelPrefs(p)?.default ?? catalog.default ?? null };
    } catch { return { ...row, models: [], defaultModel: null }; }
  }));
}

export function delegationNote() {
  return '[Helm: Delegate only with helm delegate <account> --model <model> --wait --json -- "<task>", never native subagents. Discover accounts/models with helm agents --json only when needed. Machine capacity is shared by all sessions. Parallelize reading and coding; children run scoped checks, and the parent owns broad validation after integration. Run expensive tests, builds and type-checks with helm run --heavy -- <command> so they share one machine-wide slot and bounded test workers. Inspect package scripts before assuming file arguments restrict a suite. Rerun checks only for changed code, failures or unresolved concerns; report what passed and what remains untested. Finished children release their runtime after 30 seconds idle and resume the same conversation on follow-up.]';
}

/**
 * What every agent Helm starts is told about where it is: which of the
 * owner's machines it runs on, the others, and how to act on them. "Go to
 * the VM and restart nginx" should not need the owner to explain how to get
 * there. Commands use Helm's authenticated machine connection directly.
 *
 * Kept to a few lines: it rides along in every session.
 */
export function helmBrief(net) {
  const machines = Object.values(net?.machines ?? {});
  const self = net?.machines?.[net?.self];
  const seen = new Set();
  const others = machines
    .filter((m) => m.id !== net?.self && m.name && !seen.has(m.name) && seen.add(m.name))
    .map((m) => (m.kind ? `${m.name} (${m.kind})` : m.name));
  if (!self?.name || !others.length) return delegationNote();
  return `[Helm: you are running on ${self.name}, one of the owner's machines joined by Helm. The others: ${others.join(', ')}.
- Run something on another machine: helm exec <machine> --cwd <absolute-path> -- <command> [args]. This uses Helm's managed connection; prefer it to SSH. For pipelines use -- sh -lc '<script>'. Add --heavy for tests/builds; pass environment explicitly with --env NAME=value.
- Copy a folder there: helm copy <machine> <folder> --target-folder <absolute-path>.
- Which machines are on and what is running where: helm digest. Read a session: helm thread <id>. Message it: helm say <id> <text>.
- Start an agent on another machine: helm spawn <machine> <folder> <account> <task>.]
${delegationNote()}`;
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

export function delegationOutput(session, events) {
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
  const complete = !!settled || !!turn?.status;
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
