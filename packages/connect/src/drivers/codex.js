import { execFile, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Driver, readJsonLines, checkVersion } from './index.js';
import { modeFor } from '../modes.js';
import { expand } from '../paths.js';
import { codexSessionState } from '../transcript.js';
import { formatReset, planName, quotaBar, windowLabel } from '../quota.js';

/**
 * Codex, headless.
 *
 * `codex app-server --stdio` speaks newline-delimited JSON-RPC and can host
 * many threads, so there is one server per account (per CODEX_HOME) and one
 * driver per thread. Text, reasoning and command output arrive as deltas;
 * approvals arrive as server-to-client requests we answer by id.
 *
 * Written against codex-cli 0.154.0 and the streams recorded in
 * test/fixtures/codex by scripts/record-driver.mjs. The server omits
 * `jsonrpc` on what it sends and does not require it on what it receives.
 */

export const CODEX_MIN_VERSION = '0.154.0';

const MAX_OUTPUT = 32_000;
/** A diff is read in a fold on a phone, and `events.js` caps it there too. */
const MAX_DIFF = 8_000;
const clip = (s, n = MAX_OUTPUT) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s);

/**
 * Codex's slash commands live in its TUI, not in app-server. Unlike Claude
 * and ACP, app-server therefore has no "available commands" notification for
 * us to relay. These are the commands Helm can perform faithfully through
 * app-server (or locally for read-only workspace facts). Terminal-only UI
 * actions such as /theme, /copy and /quit deliberately do not pretend to
 * exist in a web conversation.
 */
export const CODEX_COMMANDS = [
  { name: 'help', description: 'Show the commands available in this chat', source: 'codex' },
  { name: 'model', description: 'List models, or switch with /model <id>', source: 'codex' },
  { name: 'permissions', description: 'Show permissions, or switch ask, edit, full, or readonly', source: 'codex' },
  { name: 'fast', description: 'Toggle fast mode, or use /fast on|off', source: 'codex' },
  { name: 'review', description: 'Review uncommitted changes, or add custom instructions', source: 'codex' },
  { name: 'rename', description: 'Rename this conversation with /rename <title>', source: 'codex' },
  { name: 'status', description: 'Show session settings and account quota', source: 'codex' },
  { name: 'usage', description: 'Show account quota and token activity; accepts daily, weekly, or cumulative', source: 'codex' },
  { name: 'diff', description: 'Show uncommitted changes in this workspace', source: 'codex' },
  { name: 'skills', description: 'List skills available in this workspace', source: 'codex' },
  { name: 'mcp', description: 'List configured MCP servers and their status', source: 'codex' },
  { name: 'apps', description: 'List apps available to Codex', source: 'codex' },
  { name: 'plugins', description: 'List installed Codex plugins', source: 'codex' },
  { name: 'pwd', description: 'Show the current working directory', source: 'codex' },
  { name: 'cwd', description: 'Show the current working directory', source: 'codex' },
];

const commandNames = new Set(CODEX_COMMANDS.map((c) => c.name));
const SIDEBAND_COMMANDS = new Set([
  'help', 'status', 'usage', 'diff', 'skills', 'mcp', 'apps', 'plugins', 'pwd', 'cwd',
]);
const sidebandCommand = (command) => !!command && (
  SIDEBAND_COMMANDS.has(command.name) ||
  (!command.args && (command.name === 'model' || command.name === 'permissions'))
);
const slashCommand = (text) => {
  const m = /^\/(\S+)(?:\s+([\s\S]*?))?\s*$/.exec(text.trim());
  return m && commandNames.has(m[1].toLowerCase())
    ? { name: m[1].toLowerCase(), args: (m[2] ?? '').trim() }
    : null;
};

const EXTERNAL_INSPECTION_COMMANDS = new Set([
  'help', 'status', 'usage', 'diff', 'skills', 'plugins', 'pwd', 'cwd',
]);

/** Commands that can be answered without acquiring the thread's writer. */
export function canInspectExternalCodex(text) {
  const command = slashCommand(text);
  return !!command && (
    EXTERNAL_INSPECTION_COMMANDS.has(command.name) ||
    (!command.args && (command.name === 'model' || command.name === 'permissions'))
  );
}

const runFile = (file, args, options = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 15_000, maxBuffer: MAX_OUTPUT * 4, ...options }, (err, stdout, stderr) => {
    if (err && !stdout && !stderr) return reject(err);
    resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: err?.code ?? 0 });
  });
});

const number = (value) => Number(value ?? 0).toLocaleString('en-US');

// Command answers render through the transcript's Markdown, so whatever a
// provider or API hands back is escaped while the labels stay markup.
const mdEscape = (value) => String(value ?? '').replace(/([\\`*_{}\[\]()<>#+.!|])/g, '\\$1');
const mdCode = (value) => `\`${String(value ?? '').replace(/`/g, '\\`')}\``;
const mdLines = (title, lines) => `### ${title}\n\n${lines.map((line) => `- ${line}`).join('\n')}`;

function sandboxName(policy) {
  if (!policy) return 'default';
  if (typeof policy === 'string') return policy;
  return policy.type ?? 'default';
}

/**
 * The quota card shared by `/status` and `/usage` - the same bars Codex's
 * own status card draws: the 5-hour bucket, the weekly bucket, then
 * credits and plan. `result` is an `account/rateLimits/read` response, or
 * a bare RateLimitSnapshot from the rolling `account/rateLimits/updated`
 * notification.
 */
export function formatRateLimits(result, { now = Date.now() } = {}) {
  if (!result) return '';
  const byLimitId = result.rateLimitsByLimitId;
  const snapshots = byLimitId && Object.keys(byLimitId).length
    ? Object.values(byLimitId)
    : [result.rateLimits ?? (result.primary || result.secondary || result.credits ? result : null)];
  const sections = [];
  const many = snapshots.filter(Boolean).length > 1;
  for (const snap of snapshots.filter(Boolean)) {
    const lines = [];
    const line = (label, w) => {
      const used = Math.round(w.usedPercent ?? w.used_percent ?? 0);
      const reset = formatReset(w.resetsAt ?? w.resets_at, now);
      return `**${mdEscape(label)}** ${quotaBar(used)} ${used}% used${reset ? ` · resets ${reset}` : ''}`;
    };
    if (snap.primary) lines.push(line(windowLabel(snap.primary, 'Primary limit'), snap.primary));
    if (snap.secondary) lines.push(line(windowLabel(snap.secondary, 'Secondary limit'), snap.secondary));
    if (snap.individualLimit) {
      const spend = snap.individualLimit;
      const used = 100 - (Number(spend.remainingPercent ?? spend.remaining_percent) || 0);
      const reset = formatReset(spend.resetsAt ?? spend.resets_at, now);
      const amounts = spend.limit ? ` (${mdEscape(spend.used ?? '0')} of ${mdEscape(spend.limit)})` : '';
      lines.push(`**Spend limit** ${quotaBar(used)} ${used}% used${amounts}${reset ? ` · resets ${reset}` : ''}`);
    }
    if (snap.credits?.hasCredits ?? snap.credits?.has_credits) {
      const c = snap.credits;
      lines.push(`**Credits:** ${c.unlimited ? 'unlimited' : mdEscape(c.balance ?? 'unknown')}`);
    }
    if (snap.planType ?? snap.plan_type) lines.push(`**Plan:** ${mdEscape(planName(snap.planType ?? snap.plan_type))}`);
    if (!lines.length) continue;
    const name = snap.limitName || snap.limitId || snap.limit_name || snap.limit_id;
    sections.push(many && name ? `*${mdEscape(name)}*  \n${lines.join('  \n')}` : lines.join('  \n'));
  }
  return sections.length ? `### Limits\n\n${sections.join('\n\n')}` : '';
}

const day = (date) => new Date(`${date}T00:00:00Z`);
const isoDay = (date) => date.toISOString().slice(0, 10);

/** Format the account activity returned by app-server's `account/usage/read`. */
export function formatAccountUsage(result, view = '', rateLimits = null) {
  const buckets = [...(result?.dailyUsageBuckets ?? [])]
    .filter((x) => x?.startDate && Number.isFinite(Number(x.tokens)))
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const summary = result?.summary ?? {};
  const recent = buckets.slice(-14);
  const today = new Date().toISOString().slice(0, 10);
  const todayTokens = buckets.find((x) => x.startDate === today)?.tokens ?? 0;
  const sevenDay = buckets.slice(-7).reduce((sum, x) => sum + Number(x.tokens), 0);
  const limits = formatRateLimits(rateLimits);

  if (view === 'daily') {
    return recent.length
      ? `### Daily token activity\n\n| Date | Tokens |\n| --- | --- |\n${recent.map((x) => `| ${x.startDate} | ${number(x.tokens)} |`).join('\n')}`
      : 'Daily token activity is unavailable.';
  }
  if (view === 'weekly') {
    const weeks = new Map();
    for (const bucket of buckets) {
      const d = day(bucket.startDate);
      const monday = new Date(d);
      monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      const key = isoDay(monday);
      weeks.set(key, (weeks.get(key) ?? 0) + Number(bucket.tokens));
    }
    const rows = [...weeks].slice(-12);
    return rows.length
      ? `### Weekly token activity\n\n| Week starting | Tokens |\n| --- | --- |\n${rows.map(([date, tokens]) => `| ${date} | ${number(tokens)} |`).join('\n')}`
      : 'Weekly token activity is unavailable.';
  }
  if (view === 'cumulative') {
    return `### Cumulative usage\n\n${[
      `**Lifetime tokens:** ${summary.lifetimeTokens == null ? 'unavailable' : number(summary.lifetimeTokens)}`,
      `**Peak day:** ${summary.peakDailyTokens == null ? 'unavailable' : number(summary.peakDailyTokens)}`,
      `**Current streak:** ${summary.currentStreakDays == null ? 'unavailable' : `${number(summary.currentStreakDays)} days`}`,
      `**Longest streak:** ${summary.longestStreakDays == null ? 'unavailable' : `${number(summary.longestStreakDays)} days`}`,
    ].join('  \n')}`;
  }
  // Quota first: that is what /usage means in the TUI. The token activity
  // is the breakdown underneath it.
  return [
    ...(limits ? [limits, ''] : []),
    '### Account usage',
    '',
    [
      `**Today:** ${number(todayTokens)} tokens`,
      `**Last 7 days:** ${number(sevenDay)} tokens`,
      `**Lifetime:** ${summary.lifetimeTokens == null ? 'unavailable' : number(summary.lifetimeTokens)} tokens`,
    ].join('  \n'),
    '',
    '*Views:* `/usage daily` · `/usage weekly` · `/usage cumulative`',
  ].join('\n');
}

// -------------------------------------------------------------- the server

const servers = new Map();

/** One app-server process, shared by every thread on the same account. */
class CodexServer {
  #child = null;
  #seq = 0;
  /** id -> resolve for requests we sent */
  #calls = new Map();
  /** threadId -> driver */
  #drivers = new Map();
  /** spawned child threadId -> the driver that owns its parent thread */
  #aliases = new Map();
  #starting = null;

  constructor(cmd, env, log) {
    Object.assign(this, { cmd, env, log });
  }

  static for(cmd, env, log) {
    const home = env.CODEX_HOME ?? '';
    const key = `${cmd}|${home}`;
    if (!servers.has(key)) servers.set(key, new CodexServer(cmd, env, log));
    return servers.get(key);
  }

  attach(driver) {
    // A fresh driver connects before thread/start gives it an id. Replace its
    // temporary null registration once the server returns the real thread.
    for (const [threadId, existing] of this.#drivers) if (existing === driver) this.#drivers.delete(threadId);
    this.#drivers.set(driver.threadId, driver);
  }
  detach(driver) {
    this.#drivers.delete(driver.threadId);
    for (const [tid, d] of this.#aliases) if (d === driver) this.#aliases.delete(tid);
    if (!this.#drivers.size) this.#stop();
  }

  /** Route a spawned agent's thread to the driver that spawned it. */
  alias(threadId, driver) { this.#aliases.set(threadId, driver); }
  #route(threadId) { return this.#drivers.get(threadId) ?? this.#aliases.get(threadId); }

  async ensure() {
    if (this.#child) return;
    if (this.#starting) return this.#starting;
    this.#starting = (async () => {
      await checkVersion('codex', this.cmd, this.env, CODEX_MIN_VERSION, this.log);
      // The server exits if its home does not exist yet.
      if (this.env.CODEX_HOME) mkdirSync(expand(this.env.CODEX_HOME), { recursive: true });
      const child = spawn(this.cmd, ['app-server', '--stdio'], {
        env: { ...process.env, ...this.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.#child = child;
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
      readJsonLines(child.stdout, (m) => this.#onMessage(m), (line) => this.log(`codex: ${line.slice(0, 200)}`));
      child.on('exit', (code) => {
        this.#child = null;
        this.#starting = null;
        for (const resolve of this.#calls.values()) resolve({ error: { message: 'codex exited' } });
        this.#calls.clear();
        for (const d of this.#drivers.values()) d.serverExited(code, stderr);
      });
      child.on('error', (err) => {
        for (const d of this.#drivers.values()) d.push('error', { message: `could not start ${this.cmd}: ${err.message}`, kind: 'spawn' });
      });
      const init = await this.call('initialize', {
        clientInfo: { name: 'helm', title: 'Helm', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      if (init.error) throw new Error(`codex initialize failed: ${init.error.message}`);
      this.notify('initialized');
    })();
    try { await this.#starting; } finally { this.#starting = null; }
  }

  #stop() {
    const child = this.#child;
    if (!child) return;
    try { child.stdin.end(); } catch { /* closed */ }
    setTimeout(() => { if (this.#child === child) child.kill('SIGTERM'); }, 3000).unref?.();
  }

  write(obj) {
    if (!this.#child?.stdin.writable) throw new Error('codex is not running');
    this.#child.stdin.write(JSON.stringify(obj) + '\n');
  }

  call(method, params) {
    const id = ++this.#seq;
    return new Promise((resolve) => {
      this.#calls.set(id, resolve);
      try { this.write({ jsonrpc: '2.0', id, method, params }); }
      catch (e) { this.#calls.delete(id); resolve({ error: { message: e.message } }); }
    });
  }

  notify(method, params) { this.write(params ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', method }); }

  respond(id, result) { this.write({ jsonrpc: '2.0', id, result }); }

  #onMessage(m) {
    if (m.id !== undefined && m.method) {
      // The server is asking us something (an approval).
      const d = this.#route(m.params?.threadId);
      if (d) d.onServerRequest(m);
      else this.respond(m.id, { decision: 'decline' });
      return;
    }
    if (m.id !== undefined) {
      const resolve = this.#calls.get(m.id);
      if (resolve) { this.#calls.delete(m.id); resolve(m); }
      return;
    }
    if (m.method) {
      const threadId = m.params?.threadId;
      if (threadId) this.#route(threadId)?.onNotification(m.method, m.params);
      else if (m.method === 'account/rateLimits/updated') {
        for (const d of this.#drivers.values()) d.onRateLimits(m.params?.rateLimits);
      }
    }
  }
}

// -------------------------------------------------------------- the driver

/**
 * What a child agent's item should be called on its parent's trail.
 *
 * Codex reports nothing about a spawned agent between "running" and its final
 * summary, so the only evidence of what it did is the items arriving on its
 * own thread. Naming each one on the spawn card is what gives a folded
 * subagent something to show. Prose and reasoning are not steps.
 */
function childStep(item) {
  switch (item.type) {
    case 'userMessage': case 'agentMessage': case 'reasoning': return null;
    case 'collabAgentToolCall': case 'collabToolCall': case 'subAgentActivity': return 'spawn';
    case 'fileChange': return 'edit';
    case 'commandExecution': {
      const c = item.command ?? item.commandActions?.map((a) => a.command).find(Boolean) ?? '';
      return String(c).trim().split(/\s+/)[0] || 'command';
    }
    default: return item.type;
  }
}

export class CodexDriver extends Driver {
  #server = null;
  #started = false;
  #turnId = null;
  #usage = null;
  #rateLimits = null;
  #rolloutState = null;
  #interrupting = false;
  /** itemId -> what we know about it (kind, changes) */
  #items = new Map();
  /** spawned child threadId -> the collab item that spawned it */
  #subagentThreads = new Map();
  /** the most recent spawn_agent item; later collab calls name its child */
  #lastSpawn = null;
  /** server request id -> { method, params } */
  #requests = new Map();

  constructor(opts) {
    super({ engine: 'codex', ...opts });
    this.threadId = this.engineSessionId ?? null;
    this.monitorOnly = !!opts.monitorOnly;
  }

  #policy() {
    const mode = modeFor('codex', this.mode);
    return {
      approvalPolicy: mode?.approvalPolicy ?? 'on-request',
      sandbox: mode?.sandbox ?? 'workspace-write',
      sandboxPolicy: mode?.sandboxPolicy ?? { type: 'workspaceWrite' },
    };
  }

  async start() {
    if (this.#started) return;
    const server = await this.#connectOnly();
    const { approvalPolicy, sandbox } = this.#policy();
    const common = { cwd: this.cwd, approvalPolicy, sandbox, ...(this.model ? { model: this.model } : {}) };
    const res = this.threadId
      ? await server.call('thread/resume', { threadId: this.threadId, excludeTurns: true, ...common })
      : await server.call('thread/start', common);
    if (res.error) throw new Error(`codex ${this.threadId ? 'resume' : 'start'} failed: ${res.error.message}`);
    this.threadId = res.result.thread.id;
    this.engineSessionId = this.threadId;
    server.attach(this);
    this.#rolloutState = await codexSessionState(this.transcript);
    this.#usage = this.#rolloutState.usage ?? this.#usage;
    // A rateLimits/updated notification may already have arrived; the
    // rollout's tail-of-turn snapshot is the fallback, not the fresher read.
    if (!this.#rateLimits && this.#rolloutState.rateLimits) {
      this.#rateLimits = { rateLimits: this.#rolloutState.rateLimits };
    }
    this.info = {
      model: res.result.model ?? res.result.thread?.model ?? this.#rolloutState.settings?.model,
      effort: res.result.reasoningEffort ?? res.result.thread?.reasoningEffort ?? this.#rolloutState.settings?.effort,
      approvalPolicy: res.result.approvalPolicy ?? approvalPolicy,
      sandbox: res.result.sandbox ?? sandbox,
      cliVersion: res.result.thread?.cliVersion ?? this.#rolloutState.cliVersion,
    };
    this.#started = true;
    this.emit('init', this.info);
  }

  /** Initialize app-server for account reads without resuming the thread. */
  async #connectOnly() {
    if (this.#server) return this.#server;
    const server = CodexServer.for(this.cmd, this.env, this.log);
    await server.ensure();
    this.#server = server;
    server.attach(this);
    return server;
  }

  /** Called after Sessions has safely released the external writer. */
  enableWriting() { this.monitorOnly = false; }

  serverExited(code, stderr) {
    this.#server = null;
    for (const requestId of [...this.pending.keys()]) this.push('permission.resolved', { requestId, decision: 'cancelled' });
    if (!this.killed) this.push('error', { message: `codex exited with code ${code}${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`, kind: 'exit' });
    this.push('status', { status: 'exited' });
  }

  // ----------------------------------------------------------------- verbs

  async send(text) {
    const command = slashCommand(text);
    if (command) return this.#runSlash(text, command, { sideband: sidebandCommand(command) });
    await this.start();
    // Per-turn overrides stick to the thread, so a mode or model changed
    // mid-session takes effect on the next message - the sandbox included,
    // which is the half that makes "act without asking" true rather than
    // merely quiet.
    const policy = this.#policy();
    const params = {
      threadId: this.threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      clientUserMessageId: randomUUID(),
      approvalPolicy: policy.approvalPolicy,
      sandboxPolicy: policy.sandboxPolicy,
      ...(this.model ? { model: this.model } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
      ...(this.speed ? { serviceTier: this.speed } : {}),
    };
    const wasWorking = this.status === 'working';
    if (!this.pending.size) this.push('status', { status: 'working' });
    const res = await this.#server.call('turn/start', params);
    if (res.error) {
      this.push('error', { message: res.error.message, kind: 'turn' });
      // Only unwind the status this call set: when a turn was already
      // running, "idle" would be a lie - that turn is still going, and its
      // own completion is what says otherwise.
      if (!wasWorking) this.push('status', { status: 'idle' });
      // The send failed, and the caller's optimistic turn has to know it:
      // returning quietly leaves a message that looks sent but was not.
      throw new Error(res.error.message);
    }
    this.#turnId = res.result.turn.id;
    this.push('turn.start', { turnId: this.#turnId, text });
  }

  /** app-server does not advertise these: they are client-side in Codex TUI. */
  async availableCommands() { return CODEX_COMMANDS; }

  canRunWhileBusy(text) {
    const command = slashCommand(text);
    return sidebandCommand(command);
  }

  /** Native compaction, rather than sending the string `/compact` as a prompt. */
  async compact() {
    await this.start();
    const res = await this.#server.call('thread/compact/start', { threadId: this.threadId });
    if (res.error) throw new Error(res.error.message);
  }

  /**
   * Give client-side Codex commands the same event shape as an ordinary turn,
   * so the optimistic message posted by Sessions is adopted instead of being
   * duplicated. /review is special: it starts a real app-server turn, whose
   * subsequent item and completion notifications finish this visible turn.
   */
  async #runSlash(text, { name, args }, { sideband = false } = {}) {
    if (this.monitorOnly && sideband) await this.#connectOnly();
    else await this.start();
    const commandTurn = `command-${randomUUID()}`;
    if (!sideband) this.push('status', { status: 'working' });
    this.push('turn.start', { turnId: commandTurn, text });

    if (name === 'review') {
      const target = args ? { type: 'custom', instructions: args } : { type: 'uncommittedChanges' };
      const res = await this.#server.call('review/start', { threadId: this.threadId, target });
      if (res.error) {
        this.push('turn.done', { turnId: commandTurn, status: 'error', error: res.error.message });
        this.push('status', { status: 'idle' });
        throw new Error(res.error.message);
      }
      this.#turnId = res.result.turn.id;
      return;
    }

    try {
      const body = await this.#slashResult(name, args);
      const itemId = `command-result-${randomUUID()}`;
      this.push('item.start', { id: itemId, turnId: commandTurn, kind: 'text' });
      this.push('item.delta', { id: itemId, text: body || 'Done.' });
      this.push('item.done', { id: itemId, status: 'ok' });
      this.push('turn.done', { turnId: commandTurn, status: 'ok' });
    } catch (err) {
      const message = String(err?.message || err);
      this.push('error', { message, kind: 'command' });
      this.push('turn.done', { turnId: commandTurn, status: 'error', error: message });
      throw err;
    } finally {
      if (!sideband) this.push('status', { status: 'idle' });
    }
  }

  async #call(method, params = {}) {
    const res = await this.#server.call(method, params);
    if (res.error) {
      // A proxy can occasionally return an HTML challenge page. Keep that
      // out of a chat transcript while retaining the useful first sentence.
      const message = String(res.error.message ?? 'Codex command failed')
        .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      throw new Error(clip(message, 500));
    }
    return res.result;
  }

  async #slashResult(name, args) {
    switch (name) {
      case 'help':
        return mdLines('Available commands',
          CODEX_COMMANDS.map((c) => `${mdCode(`/${c.name}`)} — ${mdEscape(c.description)}`));
      case 'pwd':
      case 'cwd':
        return `**Current directory:** ${mdCode(this.cwd)}`;
      case 'status': {
        // Refresh the rollout in case the external CLI wrote another token
        // count immediately before releasing its writer lock.
        this.#rolloutState = await codexSessionState(this.transcript);
        if (this.#rolloutState.usage) this.#usage = this.#rolloutState.usage;
        const settings = this.#rolloutState.settings ?? {};
        const last = this.#usage?.last;
        const total = this.#usage?.total;
        const window = this.#usage?.modelContextWindow;
        const context = last?.totalTokens != null && window
          ? `${number(last.totalTokens)} / ${number(window)} tokens (${Math.max(0, Math.round((1 - last.totalTokens / window) * 100))}% left)`
          : 'unavailable until the first model turn';
        // Live account reads are what the TUI's status card shows - quota
        // and the signed-in account. Older app-servers may lack them, and
        // the rollout's snapshot is the fallback either way.
        const account = await this.#call('account/read', {}).catch(() => null);
        const live = await this.#call('account/rateLimits/read', null).catch(() => null);
        if (live) this.#rateLimits = live;
        else if (!this.#rateLimits && this.#rolloutState.rateLimits) {
          this.#rateLimits = { rateLimits: this.#rolloutState.rateLimits };
        }
        const limits = formatRateLimits(this.#rateLimits);
        const acct = account?.account;
        const accountLine = !acct ? null
          : acct.type === 'chatgpt'
            ? `${mdEscape(acct.email ?? 'ChatGPT')}${acct.planType ? ` (${mdEscape(planName(acct.planType))})` : ''}`
            : acct.type === 'apiKey' ? 'API key' : mdEscape(acct.type);
        return [
          '### Session status',
          '',
          [
            `**Model:** ${mdEscape(this.model || this.info?.model || settings.model || 'default')}`,
            `**Thinking:** ${mdEscape(this.effort || this.info?.effort || settings.effort || 'default')}`,
            `**Permissions:** ${mdEscape(this.mode || settings.permissionProfile?.name || settings.approvalPolicy || 'ask')}`,
            `**Sandbox:** ${mdEscape(sandboxName(this.info?.sandbox ?? settings.sandboxPolicy))}`,
            `**Speed:** ${mdEscape(this.speed || settings.serviceTier || 'normal')}`,
            `**Folder:** ${mdCode(this.cwd || settings.cwd)}`,
            `**Thread:** ${mdCode(this.threadId)}`,
            ...(accountLine ? [`**Account:** ${accountLine}`] : []),
            ...(this.info?.cliVersion ? [`**Codex:** ${mdEscape(this.info.cliVersion)}`] : []),
            `**Context:** ${context}`,
            ...(total?.totalTokens != null ? [`**Turn tokens:** ${number(total.totalTokens)}`] : []),
          ].join('  \n'),
          ...(limits ? ['', limits] : []),
        ].join('\n');
      }
      case 'model': {
        if (args) {
          await this.setModel(args);
          this.push('settings', { model: this.model });
          return `**Model:** set to ${mdCode(this.model)}.`;
        }
        const result = await this.#call('model/list', {});
        const models = (result.data ?? []).map((m) =>
          `${mdCode(m.id)}${m.isDefault ? ' **default**' : ''} — ${mdEscape(m.description || m.displayName)}`);
        return models.length ? mdLines('Models', models) : 'No models reported.';
      }
      case 'permissions': {
        const modes = ['ask', 'edit', 'full', 'readonly'];
        if (!args) return `### Permissions\n\n**Current:** ${mdEscape(this.mode || 'ask')}  \n**Available:** ${modes.map(mdEscape).join(', ')}`;
        const picked = args.toLowerCase();
        if (!modes.includes(picked)) throw new Error(`Unknown permissions mode "${args}". Use ${modes.join(', ')}.`);
        await this.setMode(picked);
        this.push('settings', { mode: this.mode });
        return `**Permissions:** set to ${mdCode(picked)}.`;
      }
      case 'fast': {
        const value = args.toLowerCase();
        if (value && !['on', 'off', 'fast', 'normal'].includes(value)) throw new Error('Use /fast, /fast on, or /fast off.');
        const speed = value === 'off' || value === 'normal' ? null : value === 'on' || value === 'fast' ? 'fast' : (this.speed === 'fast' ? null : 'fast');
        await this.setSpeed(speed);
        this.push('settings', { speed: this.speed });
        return `**Fast mode:** ${this.speed === 'fast' ? 'on' : 'off'}.`;
      }
      case 'rename': {
        if (!args) throw new Error('Give the conversation a name: /rename <title>');
        await this.#call('thread/name/set', { threadId: this.threadId, name: args });
        this.push('title', { title: args });
        return `**Renamed:** ${mdEscape(args)}.`;
      }
      case 'skills': {
        const result = await this.#call('skills/list', { cwds: [this.cwd] });
        const skills = (result.data ?? []).flatMap((entry) => entry.skills ?? []);
        return skills.length
          ? mdLines('Skills', skills.map((s) => `**${mdEscape(s.name)}** ${s.enabled ? 'enabled' : 'disabled'} — ${mdEscape(s.description)}`))
          : 'No skills found.';
      }
      case 'mcp': {
        const result = await this.#call('mcpServerStatus/list', { threadId: this.threadId });
        const rows = (result.data ?? []).map((s) => {
          const state = typeof s.runtimeStatus === 'string' ? s.runtimeStatus : (s.runtimeStatus?.type ?? (s.toolsError ? 'error' : 'configured'));
          return `**${mdEscape(s.name)}** — ${mdEscape(state)}${s.toolsError ? `: ${mdEscape(s.toolsError)}` : ''}`;
        });
        return rows.length ? mdLines('MCP servers', rows) : 'No MCP servers configured.';
      }
      case 'apps': {
        const result = await this.#call('app/list', { threadId: this.threadId });
        const rows = (result.data ?? []).map((a) =>
          `**${mdEscape(a.name || a.displayName || a.id)}**${a.description ? ` — ${mdEscape(a.description)}` : ''}`);
        return rows.length ? mdLines('Apps', rows) : 'No apps available.';
      }
      case 'plugins': {
        const result = await this.#call('plugin/list', { cwds: [this.cwd] });
        const plugins = (result.marketplaces ?? []).flatMap((m) => m.plugins ?? []).filter((p) => p.installed);
        return plugins.length
          ? mdLines('Plugins', plugins.map((p) => `**${mdEscape(p.name || p.id)}**${p.version ? ` ${mdEscape(p.version)}` : ''}`))
          : 'No plugins installed.';
      }
      case 'usage': {
        const view = args.toLowerCase();
        if (view && !['daily', 'weekly', 'cumulative'].includes(view)) {
          throw new Error('Use /usage, /usage daily, /usage weekly, or /usage cumulative.');
        }
        const [activity, rateLimits] = await Promise.all([
          this.#call('account/usage/read', {}),
          this.#call('account/rateLimits/read', null).catch(() => null),
        ]);
        return formatAccountUsage(activity, view, rateLimits);
      }
      case 'diff': {
        const status = await runFile('git', ['-C', this.cwd, 'status', '--short']);
        const diff = await runFile('git', ['-C', this.cwd, 'diff', '--no-ext-diff', '--stat', '--patch']);
        // A ``` run inside git output would break the fence it lands in.
        const fence = (lang, body) => `\`\`\`${lang}\n${body.replace(/```/g, "'''")}\n\`\`\``;
        const parts = [
          status.stdout.trim() && `### Status\n\n${fence('text', status.stdout.trim())}`,
          diff.stdout.trim() && `### Diff\n\n${fence('diff', diff.stdout.trim())}`,
        ].filter(Boolean);
        return clip(parts.join('\n\n') || 'Working tree clean.');
      }
      default:
        throw new Error(`Unsupported Codex command: /${name}`);
    }
  }

  /**
   * Text plus images in one turn. The app-server takes images as a `url`
   * (verified against codex-cli 0.154.0 - a bare `path` is rejected, and
   * the model API rejects `file://`, so bytes go inline as a data URL).
   * Anything without image bytes is skipped.
   */
  async sendWithAttachments(text, attachments) {
    await this.start();
    const policy = this.#policy();
    const input = text ? [{ type: 'text', text, text_elements: [] }] : [];
    for (const a of attachments ?? []) {
      if (!String(a?.mime ?? '').startsWith('image/') || !a?.data) continue;
      input.push({ type: 'image', url: `data:${a.mime};base64,${a.data}` });
    }
    if (!input.length) return this.send('(empty message)');
    const params = {
      threadId: this.threadId,
      input,
      clientUserMessageId: randomUUID(),
      approvalPolicy: policy.approvalPolicy,
      sandboxPolicy: policy.sandboxPolicy,
      ...(this.model ? { model: this.model } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
      ...(this.speed ? { serviceTier: this.speed } : {}),
    };
    const wasWorking = this.status === 'working';
    if (!this.pending.size) this.push('status', { status: 'working' });
    const res = await this.#server.call('turn/start', params);
    if (res.error) {
      this.push('error', { message: res.error.message, kind: 'turn' });
      if (!wasWorking) this.push('status', { status: 'idle' });
      throw new Error(res.error.message);
    }
    this.#turnId = res.result.turn.id;
    this.push('turn.start', { turnId: this.#turnId, text });
  }

  /**
   * A message handed to the turn already running. app-server's turn/steer
   * injects it without interrupting, so a queued message does not have to
   * wait for the turn it was typed behind. It is the same input blocks a
   * turn/start takes; there is deliberately no status or turn event here -
   * the running turn's stream covers what the message becomes.
   */
  async steer(text, attachments = []) {
    await this.start();
    if (!this.#turnId) throw new Error('codex has no active turn to steer');
    const input = text ? [{ type: 'text', text, text_elements: [] }] : [];
    for (const a of attachments ?? []) {
      if (!String(a?.mime ?? '').startsWith('image/') || !a?.data) continue;
      input.push({ type: 'image', url: `data:${a.mime};base64,${a.data}` });
    }
    if (!input.length) input.push({ type: 'text', text: '(empty message)', text_elements: [] });
    const res = await this.#server.call('turn/steer', {
      threadId: this.threadId,
      expectedTurnId: this.#turnId,
      input,
      clientUserMessageId: randomUUID(),
    });
    if (res.error) throw new Error(res.error.message);
  }

  async answer(requestId, decision) {
    const req = this.pending.get(requestId);
    const raw = this.#requests.get(requestId);
    if (!req || !raw) throw new Error(`no pending request ${requestId}`);
    let result;
    switch (raw.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval': {
        const available = raw.params.availableDecisions ?? [];
        const amend = available.find((d) => typeof d === 'object' && d.acceptWithExecpolicyAmendment);
        result = decision.option === 'deny' ? { decision: 'decline' }
          : decision.option === 'always' ? { decision: amend ?? 'acceptForSession' }
          : { decision: 'accept' };
        break;
      }
      case 'item/permissions/requestApproval':
        result = decision.option === 'deny'
          ? { permissions: {}, scope: 'turn' }
          : { permissions: raw.params.permissions, scope: decision.option === 'always' ? 'session' : 'turn' };
        break;
      case 'item/tool/requestUserInput': {
        const answers = {};
        for (const q of raw.params.questions ?? []) {
          const a = decision.answers?.[q.question] ?? decision.answers?.[q.id];
          if (a != null) answers[q.id] = { answers: String(a).split(',').map((s) => s.trim()).filter(Boolean) };
        }
        result = { answers };
        break;
      }
      default:
        result = { decision: decision.option === 'deny' ? 'decline' : 'accept' };
    }
    this.#server.respond(raw.id, result);
    this.#requests.delete(requestId);
    this.push('permission.resolved', { requestId, decision: decision.option });
    this.push('status', { status: 'working' });
  }

  async interrupt() {
    if (!this.#server || !this.#turnId) return;
    this.#interrupting = true;
    await this.#server.call('turn/interrupt', { threadId: this.threadId, turnId: this.#turnId });
  }

  async setModel(model) { this.model = model || null; }
  async setMode(id) { this.mode = id; }
  /** Rides `turn/start`, so the next message uses it; nothing to restart. */
  async setEffort(effort) { this.effort = effort || null; }

  /** codex's service tier - what the TUI calls /fast. Also per-turn. */
  async setSpeed(speed) { this.speed = speed || null; }

  async kill() {
    this.killed = true;
    if (!this.#server) return;
    for (const requestId of [...this.pending.keys()]) {
      try { await this.answer(requestId, { option: 'deny' }); } catch { /* gone */ }
    }
    if (this.#turnId && this.status === 'working') {
      try { await this.#server.call('turn/interrupt', { threadId: this.threadId, turnId: this.#turnId }); } catch { /* fine */ }
    }
    this.#server.detach(this);
    this.#server = null;
    this.push('status', { status: 'exited' });
  }

  // ------------------------------------------------------------- the stream

  onNotification(method, p) {
    if (p.threadId && p.threadId !== this.threadId) {
      // A spawned agent's own thread: its items fold under the spawn card,
      // but its turns, status and usage are not this session's.
      const parentId = this.#subagentThreads.get(p.threadId);
      if (!parentId) return;
      switch (method) {
        case 'item/started': return this.#onItemStarted(p.item, this.#turnId, parentId);
        case 'item/completed': return this.#onItemCompleted(p.item);
        case 'item/agentMessage/delta':
        case 'item/reasoning/textDelta':
        case 'item/reasoning/summaryTextDelta':
        case 'item/commandExecution/outputDelta':
          if (p.delta) this.push('item.delta', { id: p.itemId, text: p.delta });
          return;
        default: return;
      }
    }
    switch (method) {
      case 'turn/started':
        this.#turnId = p.turn?.id ?? this.#turnId;
        this.push('status', { status: 'working' });
        return;
      case 'item/started': return this.#onItemStarted(p.item, p.turnId);
      case 'item/completed': return this.#onItemCompleted(p.item);
      case 'item/agentMessage/delta':
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/commandExecution/outputDelta':
        if (p.delta) this.push('item.delta', { id: p.itemId, text: p.delta });
        return;
      case 'item/fileChange/patchUpdated':
        this.push('item.update', { id: p.itemId, changes: this.#changes(p.changes) });
        return;
      case 'thread/tokenUsage/updated':
        this.#usage = p.tokenUsage;
        return;
      case 'turn/completed': {
        const t = p.turn ?? {};
        const status = t.status === 'interrupted' ? 'interrupted' : t.status === 'failed' ? 'error' : 'ok';
        this.#interrupting = false;
        const last = this.#usage?.last;
        this.push('turn.done', {
          turnId: t.id ?? this.#turnId,
          status,
          usage: last && { input: last.inputTokens, output: last.outputTokens, cacheRead: last.cachedInputTokens },
          durationMs: t.durationMs ?? undefined,
          error: status === 'error' ? (t.error?.message ?? 'turn failed') : undefined,
        });
        this.push('status', { status: 'idle' });
        return;
      }
      case 'serverRequest/resolved': {
        const requestId = String(p.requestId);
        if (this.pending.has(requestId)) {
          this.#requests.delete(requestId);
          this.push('permission.resolved', { requestId, decision: 'elsewhere' });
        }
        return;
      }
      case 'error':
        this.push('error', { message: p.error?.message ?? 'codex error', kind: p.willRetry ? 'retrying' : 'turn' });
        return;
      default: return;
    }
  }

  onRateLimits(rateLimits) {
    if (rateLimits) {
      // A rolling update is sparse - nulls in it do not clear what the last
      // account/rateLimits/read said - so it merges into the snapshot helm
      // holds rather than replacing it.
      const sparse = Object.fromEntries(Object.entries(rateLimits).filter(([, v]) => v != null));
      const prev = this.#rateLimits ?? {};
      const key = sparse.limitId;
      this.#rateLimits = {
        ...prev,
        rateLimits: { ...(prev.rateLimits ?? {}), ...sparse },
        ...(key && prev.rateLimitsByLimitId?.[key]
          ? { rateLimitsByLimitId: { ...prev.rateLimitsByLimitId, [key]: { ...prev.rateLimitsByLimitId[key], ...sparse } } }
          : {}),
      };
    }
    this.push('limits', { codex: rateLimits });
  }

  #changes(changes) {
    return (changes ?? []).map((c) => ({ path: c.path, kind: c.kind?.type ?? 'update', diff: clip(c.diff, MAX_DIFF) }));
  }

  #onItemStarted(item, turnId, parentId) {
    if (!item) return;
    if (parentId) {
      const step = childStep(item);
      if (step) this.push('item.update', { id: parentId, agent: { lastTool: step } });
    }
    const base = { id: item.id, turnId: turnId ?? this.#turnId, parentId };
    switch (item.type) {
      case 'userMessage': return;
      // One agent spawning another (spawn_agent | send_input | resume_agent
      // | wait | close_agent). The card is the child; what it does arrives on
      // the child's own threadId, which we alias back to here.
      case 'collabAgentToolCall':
      case 'collabToolCall':
      case 'subAgentActivity': {
        // Live traffic: spawnAgent carries no receiverThreadIds - the child
        // thread id shows up on the `wait` call that follows it. Parent the
        // child to the spawn card, not the wait that happened to name it.
        const isSpawn = /spawn/i.test(item.tool ?? '');
        const children = item.receiverThreadIds ?? (item.agentThreadId ? [item.agentThreadId] : []);
        if (isSpawn) this.#lastSpawn = item.id;
        const parent = isSpawn ? item.id : (this.#lastSpawn ?? item.id);
        for (const t of children) {
          if (!this.#subagentThreads.has(t)) this.#subagentThreads.set(t, parent);
          this.#server?.alias(t, this);
        }
        this.#items.set(item.id, { kind: 'subagent' });
        this.push('item.start', {
          ...base, kind: 'subagent',
          name: item.tool ?? item.type,
          input: item.prompt || item.model ? { prompt: item.prompt, model: item.model } : undefined,
          agent: { status: 'running' },
        });
        return;
      }
      case 'agentMessage':
        this.#items.set(item.id, { kind: 'text' });
        this.push('item.start', { ...base, kind: 'text' });
        return;
      case 'reasoning':
        this.#items.set(item.id, { kind: 'thinking' });
        this.push('item.start', { ...base, kind: 'thinking' });
        return;
      case 'commandExecution': {
        const command = item.commandActions?.map((a) => a.command).filter(Boolean).join(' && ') || item.command;
        this.#items.set(item.id, { kind: 'command', command });
        this.push('item.start', { ...base, kind: 'command', command, cwd: item.cwd });
        return;
      }
      case 'fileChange': {
        const changes = this.#changes(item.changes);
        this.#items.set(item.id, { kind: 'edit', changes });
        this.push('item.start', { ...base, kind: 'edit', changes });
        return;
      }
      default:
        this.#items.set(item.id, { kind: 'tool' });
        this.push('item.start', { ...base, kind: 'tool', name: item.type, input: item.arguments ?? item.input ?? undefined });
    }
  }

  #onItemCompleted(item) {
    if (!item || item.type === 'userMessage') return;
    const known = this.#items.get(item.id);
    if (!known) {
      // A resumed or summarised item we never saw start: show it whole.
      this.#onItemStarted(item);
      if (item.type === 'agentMessage' && item.text) this.push('item.delta', { id: item.id, text: item.text });
    }
    const status = item.status === 'failed' ? 'error' : item.status === 'declined' ? 'declined' : 'ok';
    switch (item.type) {
      case 'commandExecution':
        this.push('item.done', { id: item.id, status, output: clip(item.aggregatedOutput ?? ''), exitCode: item.exitCode ?? undefined });
        break;
      case 'fileChange':
        this.push('item.done', { id: item.id, status, changes: this.#changes(item.changes) });
        break;
      case 'collabAgentToolCall':
      case 'collabToolCall':
      case 'subAgentActivity': {
        const states = Object.values(item.agentsStates ?? {});
        const summary = states.map((s) => s?.message).filter(Boolean).join('\n');
        this.push('item.update', { id: item.id, agent: { status: item.status ?? 'completed', summary: summary || undefined } });
        this.push('item.done', { id: item.id, status, output: clip(summary) || undefined });
        break;
      }
      default:
        this.push('item.done', { id: item.id, status: 'ok' });
    }
    this.#items.delete(item.id);
  }

  onServerRequest(m) {
    const requestId = String(m.id);
    const p = m.params ?? {};
    this.#requests.set(requestId, { id: m.id, method: m.method, params: p });
    const known = this.#items.get(p.itemId) ?? {};
    let kind, title, detail, questions;
    const options = [{ id: 'allow', role: 'allow', label: 'Allow' }];
    const available = p.availableDecisions ?? [];
    const amend = available.find((d) => typeof d === 'object' && d.acceptWithExecpolicyAmendment);

    switch (m.method) {
      case 'item/commandExecution/requestApproval':
        kind = 'command';
        title = p.kind === 'writeStdin' ? 'Send input to a running command' : 'Run a command';
        detail = p.commandActions?.map((a) => a.command).filter(Boolean).join(' && ') || p.command || known.command;
        if (amend) options.push({ id: 'always', role: 'allow-always', label: `Always allow ${amend.acceptWithExecpolicyAmendment.execpolicy_amendment?.[0] ?? 'this'}` });
        else if (available.includes('acceptForSession')) options.push({ id: 'always', role: 'allow-always', label: 'Allow for this session' });
        break;
      case 'item/fileChange/requestApproval':
        kind = 'edit';
        title = `Change ${known.changes?.length === 1 ? known.changes[0].path.split('/').pop() : `${known.changes?.length ?? ''} files`.trim()}`;
        detail = { changes: known.changes ?? [] };
        options.push({ id: 'always', role: 'allow-always', label: 'Allow edits this session' });
        break;
      case 'item/permissions/requestApproval':
        kind = 'tool';
        title = 'Codex wants more access';
        detail = clip(JSON.stringify({ reason: p.reason, permissions: p.permissions }, null, 2), 4000);
        options.push({ id: 'always', role: 'allow-always', label: 'Allow for this session' });
        break;
      case 'item/tool/requestUserInput':
        kind = 'question';
        title = 'Codex has a question';
        options.length = 0;
        questions = (p.questions ?? []).map((q) => ({
          question: q.question, header: q.header, id: q.id, secret: !!q.isSecret, multiSelect: false,
          options: (q.options ?? []).map((o) => ({ label: o.label ?? String(o), description: o.description })),
        }));
        break;
      default:
        kind = 'tool';
        title = m.method;
        detail = clip(JSON.stringify(p, null, 2), 4000);
    }
    if (kind !== 'question') options.push({ id: 'deny', role: 'deny', label: 'Deny' });

    this.push('status', { status: 'blocked' });
    this.push('permission.request', {
      requestId, itemId: p.itemId, kind, tool: m.method.split('/')[1], title, detail,
      parentId: p.threadId && p.threadId !== this.threadId ? this.#subagentThreads.get(p.threadId) : undefined,
      reason: p.reason ?? undefined, questions, options, defaultTo: 'allow', allowEdit: false,
    });
  }
}
