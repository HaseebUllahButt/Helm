import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Driver, readJsonLines, checkVersion } from './index.js';
import { modeFor, modesFor } from '../modes.js';

/**
 * Agent Client Protocol, headless.
 *
 * `devin acp` and `opencode acp` both speak ACP v1: newline-delimited
 * JSON-RPC over stdio, one process per session. A prompt is a single
 * `session/prompt` call that resolves when the turn ends; while it runs the
 * agent streams `session/update` notifications and stops on
 * `session/request_permission` requests that we answer by id.
 *
 * Everything engine-specific lives in `spec`, set by the subclass:
 *   args()            argv after the binary ('acp', '--cwd', ...)
 *   min               the CLI version this driver was written against
 *   acpMode(mode)     a helm mode's value for configId 'mode' (or null)
 *   effortId          configId that carries thinking level ('effort'), if any
 *   fallbackCommands  static palette entries for an agent that advertises none
 *   extraCommands     entries appended to whichever list won, for aliases the
 *                     agent never advertises (devin's /usage)
 *   mapPrompt(text)   the wire text for what the owner typed, when a command
 *                     spelling is really an alias for another
 *   localCommand(driver, text)  null, or () => Promise<markdown> for a
 *                     command helm answers itself - devin's /usage reads the
 *                     account quota API, which `devin acp` never exposes
 *
 * helm's own permission modes may be wider than what the agent's modes
 * express; a mode with `autoAllow` in modes.js is enforced here by answering
 * matching requests itself instead of showing them on the phone.
 *
 * Written against devin 3000.10.21 and opencode 1.18.26, probed live on both.
 */

const MAX_OUTPUT = 32_000;
/** A diff here is whole files, so it needs a tighter cap than output does. */
const MAX_DIFF = 8_000;
const clip = (s, n = MAX_OUTPUT) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s);

// ACP tool kinds -> helm item kinds.
const KIND = { execute: 'command', edit: 'edit', delete: 'edit', move: 'edit' };

// ACP has no subagent tool kind. The spawn arrives as a tool call named for
// it - devin's is `run_subagent`, opencode's `task` - and what the child then
// runs is marked `cognition.ai/subagent_context` in _meta; those items nest
// under the spawn card, they are not cards themselves.
const SUBAGENT_TOOL = /subagent|spawn.?agent|^task$/i;

export class AcpDriver extends Driver {
  #child = null;
  #exited = null;
  #seq = 0;
  /** request id -> resolve, for calls we sent */
  #calls = new Map();
  /** permission requestId -> { id, options } */
  #requests = new Map();
  /** toolCallId -> { kind, command, changes, output } */
  #items = new Map();
  /** the most recent subagent card; child tool calls nest under it */
  #lastSub = null;
  /** the streaming text/thinking item, while one is open */
  #stream = null;
  #itemSeq = 0;
  #turnId = null;
  #interrupting = false;
  /** session/load replays the transcript as updates; the log already has it. */
  #loading = false;
  /** latest configOptions the agent advertised (model/mode/effort pickers) */
  #options = [];
  /** Slash commands advertised by the ACP agent for this session. */
  #commands = [];
  /**
   * Helm's own model/mode choices have landed on the session. Until then,
   * the agent's mode/model notifications describe the state it loaded,
   * not a change it made, so mirroring them would overwrite the record's
   * choices before they were ever applied.
   */
  #live = false;
  /**
   * Whether this agent said it can take images in a prompt. ACP agents
   * differ - opencode's answer follows the provider behind the model, Devin
   * answers for itself - so it is read from what the agent advertised at
   * `initialize` rather than guessed from the engine's name.
   */
  #imagePrompts = false;

  constructor(spec, opts) {
    super({ engine: spec.engine, ...opts });
    this.spec = spec;
  }

  get args() { return [...this.spec.args(this), ...this.profileArgs]; }

  /** The pickers the agent reported, for the app's model/effort sheets.
   *  Null until any have arrived - an empty answer is "not asked yet",
   *  not "the agent takes nothing". */
  catalog() {
    if (!this.#options.length) return null;
    const by = (id) => this.#options.find((o) => o.id === id);
    const model = by('model'), effort = this.spec.effortId && by(this.spec.effortId);
    return {
      models: (model?.options ?? []).map((o) => o.value).filter(Boolean),
      labels: Object.fromEntries((model?.options ?? []).map((o) => [o.value, o.name]).filter(([k, v]) => k && v)),
      efforts: (effort?.options ?? []).map((o) => o.value).filter(Boolean),
      current: model?.currentValue ?? null,
    };
  }

  async availableCommands() {
    await this.start();
    // What the agent advertised always wins; the spec's static list is the
    // fallback for one that never sent available_commands_update, so the
    // palette is not left with only helm's own actions. The spec's extra
    // commands join either way - an alias like devin's /usage is missing
    // from the advertised list by definition, so it cannot wait for the
    // fallback to be the one that runs.
    const base = this.#commands.length ? this.#commands : (this.spec.fallbackCommands ?? []);
    const extra = (this.spec.extraCommands ?? []).filter((c) => c?.name && !base.some((x) => x.name === c.name));
    return extra.length ? [...base, ...extra] : base;
  }

  async start() {
    if (this.#child) return;
    await checkVersion(this.engine, this.cmd, this.env, this.spec.min, this.log);
    const child = spawn(this.cmd, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;
    // A fresh agent reports the state it loaded before helm's choices are
    // applied below; that reporting must not pass for a change it made.
    this.#live = false;
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); if (process.env.HELM_DEBUG_DRIVER) process.stderr.write(d); });
    readJsonLines(child.stdout, (m) => this.#onMessage(m), (line) => this.log(`${this.engine}: ${line.slice(0, 200)}`));

    this.#exited = new Promise((resolve) => {
      child.on('exit', (code) => {
        this.#child = null;
        for (const resolve of this.#calls.values()) resolve({ error: { message: `${this.engine} exited` } });
        this.#calls.clear();
        for (const requestId of [...this.pending.keys()]) {
          this.push('permission.resolved', { requestId, decision: 'cancelled' });
        }
        if (code && code !== 0 && !this.killed) {
          this.push('error', { message: `${this.engine} exited with code ${code}${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`, kind: 'exit' });
        }
        this.push('status', { status: 'exited' });
        resolve({ code });
      });
    });
    child.on('error', (err) => this.push('error', { message: `could not start ${this.cmd}: ${err.message}`, kind: 'spawn' }));

    // fs and terminal are left unadvertised on purpose: with no client to
    // delegate to, the agent runs its own tools and only stops for
    // permission - which is the one thing a phone is for.
    const init = await this.#call('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'helm', title: 'Helm', version: '0.1.0' },
    });
    if (init.error) {
      this.push('error', { message: `${this.engine} initialize failed: ${init.error.message}`, kind: 'init' });
      return;
    }
    this.#imagePrompts = init.result?.agentCapabilities?.promptCapabilities?.image === true;

    const res = this.engineSessionId ? await this.#load(this.engineSessionId) : null;
    if (res?.result) {
      this.#takeOptions(res.result);
    } else {
      if (res?.error) this.log(`${this.engine}: session/load failed (${res.error.message}); starting fresh`);
      const created = await this.#call('session/new', { cwd: this.cwd, mcpServers: [] });
      if (created.error) {
        this.push('error', { message: `${this.engine} session/new failed: ${created.error.message}`, kind: 'init' });
        return;
      }
      this.engineSessionId = created.result.sessionId;
      this.#takeOptions(created.result);
    }

    // The choices made in the app land on the live session. The agent may
    // lack the option entirely (an unknown model, a mode it does not have);
    // a refused set is worth a log line, not a dead session.
    const mode = this.spec.acpMode(this.mode);
    for (const [configId, value] of [
      ['model', this.model],
      ['mode', mode],
      [this.spec.effortId, this.spec.effortId ? this.effort : null],
    ]) {
      if (!configId || !value) continue;
      const r = await this.#call('session/set_config_option', { sessionId: this.engineSessionId, configId, value });
      if (r.error) this.log(`${this.engine}: set ${configId}=${value} refused: ${r.error.message}`);
      else this.#takeOptions(r.result);
    }
    // From here the agent's own switches - its /code, /fast, and the like -
    // are real changes, mirrored into settings by #modeChanged/#optionsChanged.
    this.#live = true;

    const opt = (id) => this.#options.find((o) => o.id === id)?.currentValue;
    this.info = { model: opt('model'), effort: this.spec.effortId ? opt(this.spec.effortId) : null };
    this.emit('init', this.info);
  }

  async #load(sessionId) {
    this.#loading = true;
    try {
      return await this.#call('session/load', { sessionId, cwd: this.cwd, mcpServers: [] });
    } finally {
      this.#loading = false;
    }
  }

  /**
   * Merge freshly advertised configOptions into the known set - an update
   * may carry the whole picker set or just the one that changed. Returns
   * the entries whose value actually moved: first sight of a picker is its
   * baseline, not a change.
   */
  #takeOptions(result) {
    if (!Array.isArray(result?.configOptions)) return [];
    const byId = new Map(this.#options.map((o) => [o.id, o]));
    const changed = [];
    for (const o of result.configOptions) {
      const known = byId.get(o?.id);
      if (known && o.currentValue !== known.currentValue) changed.push(o);
      byId.set(o.id, o);
    }
    this.#options = [...byId.values()];
    return changed;
  }

  // ------------------------------------------------------------------ wire

  #write(obj) {
    if (!this.#child?.stdin.writable) throw new Error(`${this.engine} is not running`);
    this.#child.stdin.write(JSON.stringify(obj) + '\n');
  }

  #call(method, params) {
    const id = `helm-${++this.#seq}`;
    return new Promise((resolve) => {
      this.#calls.set(id, resolve);
      try { this.#write({ jsonrpc: '2.0', id, method, params }); }
      catch (e) { this.#calls.delete(id); resolve({ error: { message: e.message } }); }
    });
  }

  #notify(method, params) {
    try { this.#write({ jsonrpc: '2.0', method, params }); } catch { /* closing */ }
  }

  #respond(id, result) {
    try { this.#write({ jsonrpc: '2.0', id, result }); } catch { /* gone */ }
  }

  // ----------------------------------------------------------------- verbs

  async send(text) {
    const local = this.spec.localCommand?.(this, text);
    if (local) return this.#localCommand(text, local);
    await this.start();
    if (!this.engineSessionId || !this.#child) {
      this.push('error', { message: `${this.engine} has no session; it never finished starting`, kind: 'init' });
      return;
    }
    const turnId = `turn-${randomUUID().slice(0, 8)}`;
    this.#turnId = turnId;
    this.push('turn.start', { turnId, text });
    if (!this.pending.size) this.push('status', { status: 'working' });
    // A spec alias rewrites only the wire text - devin's /usage goes out as
    // /session-stats - while the turn keeps the spelling the owner typed,
    // so the bubble and the optimistic echo match what was sent for them.
    const promptText = this.spec.mapPrompt?.(text) ?? text;
    // The response only arrives when the turn ends - which may be a
    // permission answer away - so it cannot be awaited here.
    this.#call('session/prompt', {
      sessionId: this.engineSessionId,
      prompt: [{ type: 'text', text: promptText }],
    }).then((res) => this.#turnDone(turnId, res));
  }

  /**
   * A command helm answers without the agent. It emits the same events as
   * a turn so the optimistic message is adopted rather than duplicated,
   * and it never starts or touches the agent process - a session that has
   * not spun up yet can still show its quota.
   */
  async #localCommand(text, run) {
    const turnId = `command-${randomUUID()}`;
    // local: the answer is complete on arrival, so the app renders it inside
    // whatever turn is still streaming rather than pinned after it.
    this.push('turn.start', { turnId, text, local: true });
    try {
      const body = await run();
      const itemId = `command-result-${randomUUID()}`;
      this.push('item.start', { id: itemId, turnId, kind: 'text' });
      this.push('item.delta', { id: itemId, text: body || 'Done.' });
      this.push('item.done', { id: itemId, status: 'ok' });
      this.push('turn.done', { turnId, status: 'ok' });
    } catch (err) {
      const message = String(err?.message || err);
      this.push('error', { message, kind: 'command' });
      this.push('turn.done', { turnId, status: 'error', error: message });
      throw err;
    }
  }

  /** A local command is a read: it runs beside a live turn, never queued. */
  canRunWhileBusy(text) {
    return !!this.spec.localCommand?.(this, text);
  }

  /** What `initialize` advertised; false until the agent has answered. */
  acceptsImages() { return this.#imagePrompts; }

  /**
   * Text plus image blocks in one prompt. ACP carries an image as its own
   * content block - `{ type: 'image', mimeType, data }` with the bytes
   * base64 inline - so nothing has to be written to a file the agent might
   * not be allowed to read. Anything without image bytes is skipped.
   */
  async sendWithAttachments(text, attachments) {
    const local = this.spec.localCommand?.(this, text);
    if (local) return this.#localCommand(text, local);
    await this.start();
    if (!this.engineSessionId || !this.#child) {
      this.push('error', { message: `${this.engine} has no session; it never finished starting`, kind: 'init' });
      return;
    }
    const prompt = text ? [{ type: 'text', text }] : [];
    for (const a of attachments ?? []) {
      if (!String(a?.mime ?? '').startsWith('image/') || !a?.data) continue;
      prompt.push({ type: 'image', mimeType: a.mime, data: a.data });
    }
    if (!prompt.length) return this.send('(empty message)');
    const turnId = `turn-${randomUUID().slice(0, 8)}`;
    this.#turnId = turnId;
    this.push('turn.start', { turnId, text });
    if (!this.pending.size) this.push('status', { status: 'working' });
    this.#call('session/prompt', {
      sessionId: this.engineSessionId,
      prompt,
    }).then((res) => this.#turnDone(turnId, res));
  }

  /** The prompt response: the turn is over, one way or another. */
  #turnDone(turnId, res) {
    if (this.#turnId !== turnId) return;
    this.#closeStream();
    if (res.error) {
      this.push('error', { message: res.error.message, kind: 'turn' });
      this.push('turn.done', { turnId, status: 'error', error: res.error.message });
      this.push('status', { status: 'idle' });
      return;
    }
    const r = res.result ?? {};
    const u = r.usage;
    const interrupted = r.stopReason === 'cancelled';
    this.push('turn.done', {
      turnId,
      status: interrupted ? 'interrupted' : r.stopReason && r.stopReason !== 'end_turn' ? 'error' : 'ok',
      error: r.stopReason && !['end_turn', 'cancelled'].includes(r.stopReason) ? `stopped: ${r.stopReason}` : undefined,
      usage: u && { input: u.inputTokens, output: u.outputTokens, cacheRead: u.cachedReadTokens },
      costUsd: u?.cost?.amount ?? u?._meta?.['cognition.ai/totalCreditCost'] ?? undefined,
    });
    this.#interrupting = false;
    this.push('status', { status: 'idle' });
  }

  async answer(requestId, decision) {
    const req = this.pending.get(requestId);
    const raw = this.#requests.get(requestId);
    if (!req || !raw) throw new Error(`no pending request ${requestId}`);
    const pick = (kind) => raw.options.find((o) => o.kind === kind)?.optionId;
    let outcome;
    if (decision.option === 'deny') {
      const optionId = pick('reject_once') ?? pick('reject_always');
      outcome = optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
    } else {
      const optionId = (decision.option === 'always' ? pick('allow_always') : null) ?? pick('allow_once');
      outcome = optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
    }
    this.#respond(raw.id, { outcome });
    this.#requests.delete(requestId);
    this.push('permission.resolved', { requestId, decision: decision.option });
    this.push('status', { status: 'working' });
  }

  async interrupt() {
    if (!this.#child || !this.engineSessionId) return;
    this.#interrupting = true;
    this.#notify('session/cancel', { sessionId: this.engineSessionId });
  }

  async setModel(model) {
    this.model = model || null;
    if (this.#child && this.engineSessionId && model) {
      const r = await this.#call('session/set_config_option', { sessionId: this.engineSessionId, configId: 'model', value: model });
      if (!r.error) this.#takeOptions(r.result);
    }
  }

  async setMode(id) {
    this.mode = id;
    const mode = this.spec.acpMode(id);
    if (this.#child && this.engineSessionId && mode) {
      const r = await this.#call('session/set_config_option', { sessionId: this.engineSessionId, configId: 'mode', value: mode });
      if (!r.error) this.#takeOptions(r.result);
    }
  }

  async setEffort(effort) {
    this.effort = effort || null;
    if (this.#child && this.engineSessionId && this.spec.effortId && effort) {
      const r = await this.#call('session/set_config_option', { sessionId: this.engineSessionId, configId: this.spec.effortId, value: effort });
      if (!r.error) this.#takeOptions(r.result);
    }
  }

  async kill() {
    this.killed = true;
    const child = this.#child;
    if (!child) return;
    for (const requestId of [...this.pending.keys()]) {
      try { await this.answer(requestId, { option: 'deny' }); } catch { /* already gone */ }
    }
    if (this.status === 'working') this.#notify('session/cancel', { sessionId: this.engineSessionId });
    try { child.stdin.end(); } catch { /* closed */ }
    const done = await Promise.race([this.#exited, new Promise((r) => setTimeout(() => r(null), 3000))]);
    if (!done) child.kill('SIGTERM');
    const done2 = await Promise.race([this.#exited, new Promise((r) => setTimeout(() => r(null), 2000))]);
    if (!done2) child.kill('SIGKILL');
    await this.#exited;
  }

  // ------------------------------------------------------------- the stream

  #onMessage(m) {
    if (m.id !== undefined && m.method) return this.#onRequest(m);
    if (m.id !== undefined) {
      const resolve = this.#calls.get(m.id);
      if (resolve) { this.#calls.delete(m.id); resolve(m); }
      return;
    }
    if (m.method === 'session/update') return this.#onUpdate(m.params);
    // Everything else - mcp/server notices, devin's _cognition.ai/* stream -
    // is bookkeeping the transcript does not need.
  }

  /** A request from the agent. Permissions are the only ones we answer. */
  #onRequest(m) {
    if (m.method === 'session/request_permission') return this.#onPermission(m);
    try { this.#write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `helm does not serve ${m.method}` } }); } catch { /* gone */ }
  }

  #onUpdate(p) {
    const u = p?.update;
    if (!u) return;
    if (u.sessionUpdate === 'available_commands_update') {
      this.#commands = (u.availableCommands ?? [])
        .filter((command) => command?.name)
        .map((command) => ({
          name: command.name,
          description: command.description,
          source: this.engine,
        }));
      return;
    }
    if (this.#loading) {
      // A replayed transcript is history the event log already holds; the
      // pickers are still worth taking.
      if (u.sessionUpdate === 'config_option_update') this.#takeOptions(u);
      return;
    }
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': return this.#chunk('text', u.content);
      case 'agent_thought_chunk': return this.#chunk('thinking', u.content);
      case 'tool_call': return this.#toolCall(u);
      case 'tool_call_update': return this.#toolUpdate(u);
      case 'plan': return this.#plan(u);
      case 'config_option_update': return this.#optionsChanged(u);
      case 'current_mode_update': return this.#modeChanged(u.currentModeId);
      case 'usage_update':
        this.push('limits', { [this.engine]: { used: u.used, size: u.size, cost: u.cost } });
        return;
      case 'session_info_update': {
        // The name the agent gave its session. It arrives more than once -
        // first a copy of the prompt, then the real title once the model has
        // written one - so whoever listens takes the latest, not the first.
        const title = typeof u.title === 'string' ? u.title.trim() : '';
        if (title) this.push('title', { title });
        return;
      }
      default: return; // user_message_chunk and friends
    }
  }

  /**
   * A config_option_update always refreshes the pickers; a settings event
   * only when a value the agent had already reported actually moved. That
   * is the agent switching something itself - devin's /fast changes the
   * model, /code the mode - and helm's record should follow.
   */
  #optionsChanged(u) {
    const changed = this.#takeOptions(u);
    if (!this.#live) return;
    for (const o of changed) {
      if (!o?.currentValue) continue;
      if (o.id === 'model') {
        this.model = o.currentValue;
        this.push('settings', { model: o.currentValue });
      } else if (o.id === 'mode') {
        this.#modeChanged(o.currentValue);
      }
    }
  }

  /**
   * The agent switched its own session mode (devin's /ask, /code, ... do
   * it agent-side, with no set_config_option from us). The acp word is
   * reversed through the spec's own acpMode so a mode helm never sent is
   * simply ignored, and when the current helm mode already maps to that
   * word - opencode folds three helm modes into 'build' - the agent is
   * agreeing, not changing.
   */
  #modeChanged(acpId) {
    if (!acpId || !this.#live) return;
    if (this.spec.acpMode(this.mode) === acpId) return;
    const mode = modesFor(this.engine).find((m) => this.spec.acpMode(m.id) === acpId);
    if (!mode || mode.id === this.mode) return;
    this.mode = mode.id;
    this.push('settings', { mode: mode.id });
  }

  /** A run of prose or thinking, opened on its first chunk and closed by
   *  anything that is not the same kind. */
  #chunk(kind, content) {
    const text = content?.type === 'text' ? content.text : '';
    if (!text) return;
    if (!this.#stream || this.#stream.kind !== kind) {
      this.#closeStream();
      const id = `${this.#turnId ?? 's'}-${kind === 'text' ? 'm' : 'k'}${++this.#itemSeq}`;
      this.#stream = { id, kind };
      this.push('item.start', { id, kind, turnId: this.#turnId });
    }
    this.push('item.delta', { id: this.#stream.id, text });
  }

  #closeStream() {
    if (!this.#stream) return;
    this.push('item.done', { id: this.#stream.id, status: 'ok' });
    this.#stream = null;
  }

  #toolCall(u) {
    this.#closeStream();
    const id = u.toolCallId ?? `tool-${++this.#itemSeq}`;
    const input = u.rawInput ?? {};
    const name = u._meta?.['cognition.ai/inferenceToolName'] ?? input.tool ?? null;
    const isSpawn = SUBAGENT_TOOL.test(name ?? u.title ?? '');
    const inChild = !isSpawn && !!u._meta?.['cognition.ai/subagent_context'];
    const changes = this.#changes(u.content);
    const kind = isSpawn ? 'subagent' : KIND[u.kind] ?? (input.command ? 'command' : changes.length ? 'edit' : 'tool');
    if (isSpawn) this.#lastSub = id;
    const parentId = inChild ? this.#lastSub : undefined;
    // devin previews the command as a shellscript resource rather than in
    // rawInput; opencode puts it in rawInput.command.
    const script = (u.content ?? []).find((c) =>
      c?.type === 'content' && c.content?.type === 'resource' &&
      (c.content?._meta?.['cognition.ai/preview_is_shell_command'] || c.content?.resource?.mimeType === 'text/x-shellscript')
    )?.content?.resource?.text;
    const command = input.command
      ?? u._meta?.['cognition.ai/editableCommand']
      ?? script
      ?? (kind === 'command' ? u.title : undefined);
    const item = { kind, command, changes, name, output: '' };
    this.#items.set(id, item);
    this.push('item.start', {
      id, kind, turnId: this.#turnId,
      name: name ?? (kind === 'command' ? 'Bash' : kind === 'edit' ? 'Edit' : u.title ?? 'tool'),
      input: Object.keys(input).length ? input : undefined,
      command, cwd: u._meta?.['cognition.ai/cwd'] ?? input.cwd,
      changes: changes.length ? changes : undefined,
      parentId,
      agent: isSpawn ? { status: 'running', description: u.title } : undefined,
    });
    if (u.status === 'completed' || u.status === 'failed') this.#toolDone(id, u);
  }

  #toolUpdate(u) {
    const id = u.toolCallId;
    if (!id) return;
    const item = this.#items.get(id) ?? { kind: 'tool', output: '' };
    if (!this.#items.has(id)) {
      this.#items.set(id, item);
      const isSpawn = SUBAGENT_TOOL.test(u.title ?? '');
      const inChild = !isSpawn && !!u._meta?.['cognition.ai/subagent_context'];
      if (isSpawn) { item.kind = 'subagent'; this.#lastSub = id; }
      this.push('item.start', { id, kind: item.kind, turnId: this.#turnId, name: u.title ?? 'tool', parentId: inChild ? this.#lastSub : undefined, agent: isSpawn ? { status: 'running', description: u.title } : undefined });
    }
    // Content entries replace rather than append: a terminal preview and the
    // final output both say the whole thing.
    const out = this.#contentText(u.content);
    if (out) item.output = out;
    const changes = this.#changes(u.content);
    if (changes.length) {
      item.changes = changes;
      this.push('item.update', { id, changes });
    }
    if (u.status === 'completed' || u.status === 'failed') this.#toolDone(id, u);
  }

  #toolDone(id, u) {
    const item = this.#items.get(id) ?? {};
    const output = clip(item.output || this.#contentText(u.content));
    this.push('item.done', {
      id,
      status: u.status === 'failed' ? (/declined|denied|rejected/i.test(output) ? 'declined' : 'error') : 'ok',
      output,
      changes: item.changes?.length ? item.changes : undefined,
    });
    this.#items.delete(id);
  }

  /** `content` entries -> the text worth showing under a tool card. */
  #contentText(content) {
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (const c of content) {
      if (c?.type === 'content' && c.content?.type === 'text') parts.push(c.content.text);
      else if (c?.type === 'content' && c.content?.type === 'resource' && c.content?.text && !c.content?.uri?.startsWith('tool://')) parts.push(c.content.text);
    }
    return parts.join('\n');
  }

  /** `content` diff entries -> helm's {path, kind, diff} change list. */
  /**
   * `content` entries -> the file changes worth showing under a tool card.
   *
   * ACP hands over whole files, not hunks: every line of the old one and
   * every line of the new one. Written out unbounded - which this did until
   * 2026-09-17 - one edit of a 2000-line file is 140KB, and the same array
   * rides on the item's start, each update and its done. A devin thread on
   * the owner's VM reached 6.8MB that way, 95% of it here, and became a chat
   * that could not be opened over the network at all.
   *
   * So a diff is clipped like every other payload a driver produces. What is
   * cut is the middle of a wall of changed lines, on a screen where it is
   * behind a fold; what is kept is which file, what kind of change, and
   * enough of it to recognise.
   */
  #changes(content) {
    if (!Array.isArray(content)) return [];
    const out = [];
    for (const c of content) {
      if (c?.type !== 'diff' || !c.path) continue;
      const kind = !c.oldText ? 'add' : !c.newText ? 'delete' : 'update';
      const diff = [
        `--- ${c.path}`, `+++ ${c.path}`, '@@',
        ...(c.oldText ? String(c.oldText).replace(/\n$/, '').split('\n').map((l) => '-' + l) : []),
        ...(c.newText ? String(c.newText).replace(/\n$/, '').split('\n').map((l) => '+' + l) : []),
      ].join('\n');
      out.push({ path: c.path, kind, diff: clip(diff, MAX_DIFF) });
    }
    return out;
  }

  /** The todo list an agent publishes, kept as one updating card. */
  #plan(u) {
    const text = (u.entries ?? [])
      .map((e) => `${e.status === 'completed' ? '☑' : e.status === 'in_progress' ? '▸' : '☐'} ${e.content}`)
      .join('\n');
    const id = `plan-${this.#turnId}`;
    if (!this.#items.has(id)) {
      this.#closeStream();
      this.#items.set(id, { kind: 'tool' });
      this.push('item.start', { id, kind: 'tool', turnId: this.#turnId, name: 'plan' });
    }
    this.push('item.update', { id, output: clip(text, 8000) });
  }

  #onPermission(m) {
    const p = m.params ?? {};
    const requestId = String(m.id);
    const options = p.options ?? [];
    this.#requests.set(requestId, { id: m.id, options });

    const id = p.toolCall?.toolCallId;
    const item = (id && this.#items.get(id)) || {};
    const kind = item.kind === 'command' ? 'command' : item.kind === 'edit' ? 'edit' : 'tool';
    const tool = p.toolCall?._meta?.['cognition.ai/inferenceToolName'] ?? item.name ?? 'tool';
    const title = p.toolCall?.title || (kind === 'command' ? 'Run a command' : kind === 'edit' ? 'Edit files' : `${this.spec.label ?? this.engine} wants permission`);
    const detail = kind === 'command'
      ? (item.command ?? p.toolCall?._meta?.['cognition.ai/editableCommand'] ?? title)
      : kind === 'edit' ? { changes: item.changes ?? [] }
      : clip(JSON.stringify(p.toolCall?.rawInput ?? p.toolCall ?? {}, null, 2), 4000);

    // The mode may let helm answer this itself; then the phone never sees it.
    const auto = modeFor(this.engine, this.mode)?.autoAllow;
    const allowId = options.find((o) => o.kind === 'allow_once')?.optionId;
    if (allowId && (auto === 'all' || (Array.isArray(auto) && auto.includes(kind)))) {
      this.#requests.delete(requestId);
      this.#respond(m.id, { outcome: { outcome: 'selected', optionId: allowId } });
      return;
    }

    const shown = [];
    const allow = options.find((o) => o.kind === 'allow_once') ?? options[0];
    if (allow) shown.push({ id: 'allow', role: 'allow', label: allow.name ?? 'Allow' });
    const always = options.find((o) => o.kind === 'allow_always');
    if (always) shown.push({ id: 'always', role: 'allow-always', label: always.name ?? 'Always allow' });
    const deny = options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind === 'reject_always');
    if (deny) shown.push({ id: 'deny', role: 'deny', label: deny.name ?? 'Deny' });

    this.push('status', { status: 'blocked' });
    this.push('permission.request', {
      requestId, itemId: id, kind, tool, title, detail,
      parentId: p.toolCall?._meta?.['cognition.ai/subagent_context'] ? this.#lastSub : undefined,
      options: shown, defaultTo: 'allow', allowEdit: false,
    });
  }
}
