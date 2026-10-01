import { ENGINES } from './engines.js';
import { materialize } from './profiles.js';
import { listModels } from './models.js';
import { modelPrefs, accountKey } from './settings.js';
import { modesFor, defaultMode } from './modes.js';
import { fold } from './brain.js';
import { createHash } from 'node:crypto';

/** Public capabilities, never launch arguments, environment, or credentials. */
export async function agentCatalog(profiles, statuses, { models = true } = {}) {
  return Promise.all(profiles.filter((p) => !p.disabled && ENGINES[p.engine]?.driver).map(async (p) => {
    const auth = statuses.get(p.id) ?? 'unknown';
    const account = createHash('sha256').update(accountKey(p)).digest('hex').slice(0, 16);
    const row = { id: p.id, label: p.label, engine: p.engine, account, auth,
      available: auth !== 'unauthenticated', modes: modesFor(p.engine).filter((m) => !m.danger) };
    if (!models || !row.available) return row;
    const spec = materialize(p);
    const engine = ENGINES[p.engine];
    try {
      const catalog = await listModels(p.engine, spec.env?.[engine.homeEnv] ?? engine.defaultHome,
        spec.env, p.wraps ? { cmd: spec.cmd, args: spec.args } : null);
      return { ...row, models: catalog.models, labels: catalog.labels ?? {},
        defaultModel: modelPrefs(p)?.default ?? catalog.default ?? null };
    } catch { return { ...row, models: [], defaultModel: null }; }
  }));
}

export function delegationNote(agents) {
  const accounts = agents.filter((a) => a.available).slice(0, 24)
    .map((a) => `${a.id} (${a.engine}, ${a.auth})`).join('; ');
  return `[helm delegation: CLI accounts: ${accounts || 'discover with helm agents --json'}. Run helm agents --json for accounts and model IDs. When the owner asks for another CLI/model, use helm delegate <account> --model <model> --wait --json -- "<task>". Read a pending result with helm delegate-result <id> --wait --json. Children share this folder; give them a bounded task. Delegate only when requested or useful, and keep permission requests visible in Helm.]`;
}

/** Read-only parents cannot acquire write access through a different CLI. */
export function delegationMode(engine, parentMode, requested) {
  const modes = modesFor(engine);
  const readOnly = ['plan', 'readonly', 'read'].includes(parentMode);
  const safe = readOnly ? modes.find((m) => ['plan', 'readonly', 'read'].includes(m.id)) : null;
  if (readOnly && !safe) throw new Error(`${engine} has no verified read-only delegation mode`);
  if (requested && !modes.some((m) => m.id === requested && !m.danger)) {
    throw new Error(`invalid or unsafe subagent mode: ${requested}`);
  }
  if (readOnly && requested && !['plan', 'readonly', 'read'].includes(requested)) {
    throw new Error('a read-only parent requires a read-only subagent');
  }
  return requested || safe?.id || defaultMode(engine);
}

export function delegationOutput(session, events) {
  const { turns, pending } = fold(events);
  const turn = turns.at(-1);
  const output = (turn?.items ?? []).filter((i) => i.kind === 'text').map((i) => i.text).join('\n\n');
  const complete = !!turn?.status;
  const status = !complete && (pending || session.status === 'blocked') ? 'blocked'
    : complete ? (turn.status === 'ok' ? 'done' : turn.status) : 'working';
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
