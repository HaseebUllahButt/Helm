import { ENGINES } from './engines.js';
import { materialize } from './profiles.js';
import { listModels } from './models.js';
import { modelPrefs, startPrefs, accountKey } from './settings.js';
import { modesFor, defaultMode } from './modes.js';
import { fold } from './brain.js';
import { createHash } from 'node:crypto';

/** Public capabilities, never launch arguments, environment, or credentials. */
export async function agentCatalog(profiles, statuses, { models = true } = {}) {
  return Promise.all(profiles.filter((p) => !p.disabled && ENGINES[p.engine]?.driver).map(async (p) => {
    const auth = statuses.get(p.id) ?? 'unknown';
    const account = createHash('sha256').update(accountKey(p)).digest('hex').slice(0, 16);
    const row = { id: p.id, label: p.label, engine: p.engine, account, auth,
      available: auth !== 'unauthenticated', modes: modesFor(p.engine),
      defaultMode: startPrefs(p)?.mode === 'plan' ? defaultMode(p.engine) : startPrefs(p)?.mode ?? defaultMode(p.engine) };
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

export function delegationNote(agents) {
  const accounts = agents.filter((a) => a.available).slice(0, 24)
    .map((a) => `${a.id} (${a.engine}, ${a.auth})`).join('; ');
  return `[helm delegation: CLI accounts: ${accounts || 'discover with helm agents --json'}. Run helm agents --json for accounts and model IDs. Use helm delegate <account> --model <model> --wait --json -- "<task>" for a bounded task. Children belong to this orchestrator and share its folder; they are tasks, not ordinary chats. Read results with helm delegate-result <id> --wait --json and send follow-ups with helm say <id> <message>. Permissions default to YOLO and remain configurable. Never use plan mode or ask to approve a plan: dispatch the task and carry it to completion. Preserve explicitly configured read-only restrictions and surface any genuine user question in the parent workflow.]`;
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

export function delegationOutput(session, events) {
  const { turns, pending } = fold(events);
  const turn = turns.at(-1);
  const output = (turn?.items ?? []).filter((i) => i.kind === 'text').map((i) => i.text).join('\n\n');
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
    session.delegationReply = { turnId: event.turnId, textIds: [], output: '', truncated: false };
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
