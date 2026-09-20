import { execFile, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Driver, readJsonLines, checkVersion } from './index.js';
import { modeFor } from '../modes.js';
import { expand } from '../paths.js';

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
  { name: 'status', description: 'Show this Codex session configuration', source: 'codex' },
  { name: 'usage', description: 'Show current account usage limits', source: 'codex' },
  { name: 'diff', description: 'Show uncommitted changes in this workspace', source: 'codex' },
  { name: 'skills', description: 'List skills available in this workspace', source: 'codex' },
  { name: 'mcp', description: 'List configured MCP servers and their status', source: 'codex' },
  { name: 'apps', description: 'List apps available to Codex', source: 'codex' },
  { name: 'plugins', description: 'List installed Codex plugins', source: 'codex' },
  { name: 'pwd', description: 'Show the current working directory', source: 'codex' },
  { name: 'cwd', description: 'Show the current working directory', source: 'codex' },
];

const commandNames = new Set(CODEX_COMMANDS.map((c) => c.name));
const slashCommand = (text) => {
  const m = /^\/(\S+)(?:\s+([\s\S]*?))?\s*$/.exec(text.trim());
  return m && commandNames.has(m[1].toLowerCase())
    ? { name: m[1].toLowerCase(), args: (m[2] ?? '').trim() }
    : null;
};

const runFile = (file, args, options = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 15_000, maxBuffer: MAX_OUTPUT * 4, ...options }, (err, stdout, stderr) => {
    if (err && !stdout && !stderr) return reject(err);
    resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: err?.code ?? 0 });
  });
});

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

  attach(driver) { this.#drivers.set(driver.threadId, driver); }
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
        for (const d of this.#drivers.values()) d.push('limits', { codex: m.params?.rateLimits });
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
  #turnId = null;
  #usage = null;
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
    if (this.#server) return;
    const server = CodexServer.for(this.cmd, this.env, this.log);
    await server.ensure();
    const { approvalPolicy, sandbox } = this.#policy();
    const common = { cwd: this.cwd, approvalPolicy, sandbox, ...(this.model ? { model: this.model } : {}) };
    const res = this.threadId
      ? await server.call('thread/resume', { threadId: this.threadId, excludeTurns: true, ...common })
      : await server.call('thread/start', common);
    if (res.error) throw new Error(`codex ${this.threadId ? 'resume' : 'start'} failed: ${res.error.message}`);
    this.threadId = res.result.thread.id;
    this.engineSessionId = this.threadId;
    this.info = { model: res.result.model ?? res.result.thread?.model, approvalPolicy, sandbox };
    this.#server = server;
    server.attach(this);
    this.emit('init', this.info);
  }

  serverExited(code, stderr) {
    this.#server = null;
    for (const requestId of [...this.pending.keys()]) this.push('permission.resolved', { requestId, decision: 'cancelled' });
    if (!this.killed) this.push('error', { message: `codex exited with code ${code}${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`, kind: 'exit' });
    this.push('status', { status: 'exited' });
  }

  // ----------------------------------------------------------------- verbs

  async send(text) {
    const command = slashCommand(text);
    if (command) return this.#runSlash(text, command);
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
  async #runSlash(text, { name, args }) {
    await this.start();
    const commandTurn = `command-${randomUUID()}`;
    this.push('status', { status: 'working' });
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
      this.push('status', { status: 'idle' });
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
        return CODEX_COMMANDS.map((c) => `/${c.name} — ${c.description}`).join('\n');
      case 'pwd':
      case 'cwd':
        return this.cwd;
      case 'status':
        return [
          `Model: ${this.model || this.info?.model || 'default'}`,
          `Thinking: ${this.effort || 'default'}`,
          `Permissions: ${this.mode || 'ask'}`,
          `Speed: ${this.speed || 'normal'}`,
          `Folder: ${this.cwd}`,
          `Thread: ${this.threadId}`,
        ].join('\n');
      case 'model': {
        if (args) {
          await this.setModel(args);
          this.push('settings', { model: this.model });
          return `Model set to ${this.model}.`;
        }
        const result = await this.#call('model/list', {});
        return (result.data ?? []).map((m) => `${m.id}${m.isDefault ? ' (default)' : ''} — ${m.description || m.displayName}`).join('\n') || 'No models reported.';
      }
      case 'permissions': {
        const modes = ['ask', 'edit', 'full', 'readonly'];
        if (!args) return `Current: ${this.mode || 'ask'}\nAvailable: ${modes.join(', ')}`;
        const picked = args.toLowerCase();
        if (!modes.includes(picked)) throw new Error(`Unknown permissions mode "${args}". Use ${modes.join(', ')}.`);
        await this.setMode(picked);
        this.push('settings', { mode: this.mode });
        return `Permissions set to ${picked}.`;
      }
      case 'fast': {
        const value = args.toLowerCase();
        if (value && !['on', 'off', 'fast', 'normal'].includes(value)) throw new Error('Use /fast, /fast on, or /fast off.');
        const speed = value === 'off' || value === 'normal' ? null : value === 'on' || value === 'fast' ? 'fast' : (this.speed === 'fast' ? null : 'fast');
        await this.setSpeed(speed);
        this.push('settings', { speed: this.speed });
        return `Fast mode ${this.speed === 'fast' ? 'on' : 'off'}.`;
      }
      case 'rename': {
        if (!args) throw new Error('Give the conversation a name: /rename <title>');
        await this.#call('thread/name/set', { threadId: this.threadId, name: args });
        this.push('title', { title: args });
        return `Renamed to ${args}.`;
      }
      case 'skills': {
        const result = await this.#call('skills/list', { cwds: [this.cwd] });
        const skills = (result.data ?? []).flatMap((entry) => entry.skills ?? []);
        return skills.map((s) => `${s.enabled ? '●' : '○'} ${s.name} — ${s.description}`).join('\n') || 'No skills found.';
      }
      case 'mcp': {
        const result = await this.#call('mcpServerStatus/list', { threadId: this.threadId });
        return (result.data ?? []).map((s) => {
          const state = typeof s.runtimeStatus === 'string' ? s.runtimeStatus : (s.runtimeStatus?.type ?? (s.toolsError ? 'error' : 'configured'));
          return `${s.name} — ${state}${s.toolsError ? `: ${s.toolsError}` : ''}`;
        }).join('\n') || 'No MCP servers configured.';
      }
      case 'apps': {
        const result = await this.#call('app/list', { threadId: this.threadId });
        return (result.data ?? []).map((a) => `${a.name || a.displayName || a.id}${a.description ? ` — ${a.description}` : ''}`).join('\n') || 'No apps available.';
      }
      case 'plugins': {
        const result = await this.#call('plugin/list', { cwds: [this.cwd] });
        const plugins = (result.marketplaces ?? []).flatMap((m) => m.plugins ?? []).filter((p) => p.installed);
        return plugins.map((p) => `${p.name || p.id}${p.version ? ` ${p.version}` : ''}`).join('\n') || 'No plugins installed.';
      }
      case 'usage': {
        const result = await this.#call('account/rateLimits/read', null);
        const limits = result.rateLimitsByLimitId ? Object.values(result.rateLimitsByLimitId) : [result.rateLimits];
        const rows = limits.filter(Boolean).flatMap((limit) => [limit.primary, limit.secondary].filter(Boolean).map((w, i) => {
          const label = limit.limitName || limit.limitId || 'Codex';
          const reset = w.resetsAt ? `, resets ${new Date(w.resetsAt * 1000).toLocaleString()}` : '';
          return `${label}${i ? ' (secondary)' : ''}: ${w.usedPercent ?? 0}% used${reset}`;
        }));
        return rows.join('\n') || 'Usage information is unavailable.';
      }
      case 'diff': {
        const status = await runFile('git', ['-C', this.cwd, 'status', '--short']);
        const diff = await runFile('git', ['-C', this.cwd, 'diff', '--no-ext-diff', '--stat', '--patch']);
        const text = [status.stdout.trim() && `Status:\n${status.stdout.trim()}`, diff.stdout.trim()].filter(Boolean).join('\n\n');
        return clip(text || 'Working tree clean.');
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
