import { spawn } from 'node:child_process';
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
const clip = (s, n = MAX_OUTPUT) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s);

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
    if (!this.#drivers.size) this.#stop();
  }

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
      const d = this.#drivers.get(m.params?.threadId);
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
      if (threadId) this.#drivers.get(threadId)?.onNotification(m.method, m.params);
      else if (m.method === 'account/rateLimits/updated') {
        for (const d of this.#drivers.values()) d.push('limits', { codex: m.params?.rateLimits });
      }
    }
  }
}

// -------------------------------------------------------------- the driver

export class CodexDriver extends Driver {
  #server = null;
  #turnId = null;
  #usage = null;
  #interrupting = false;
  /** itemId -> what we know about it (kind, changes) */
  #items = new Map();
  /** server request id -> { method, params } */
  #requests = new Map();

  constructor(opts) {
    super({ engine: 'codex', ...opts });
    this.threadId = this.engineSessionId ?? null;
  }

  #policy() {
    const mode = modeFor('codex', this.mode);
    return { approvalPolicy: mode?.approvalPolicy ?? 'on-request', sandbox: mode?.sandbox ?? 'workspace-write' };
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
    await this.start();
    // Per-turn overrides stick to the thread, so a mode or model changed
    // mid-session takes effect on the next message.
    const params = {
      threadId: this.threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      clientUserMessageId: randomUUID(),
      approvalPolicy: this.#policy().approvalPolicy,
      ...(this.model ? { model: this.model } : {}),
      ...(this.effort ? { effort: this.effort } : {}),
    };
    this.push('status', { status: 'working' });
    const res = await this.#server.call('turn/start', params);
    if (res.error) {
      this.push('error', { message: res.error.message, kind: 'turn' });
      this.push('status', { status: 'idle' });
      return;
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
    return (changes ?? []).map((c) => ({ path: c.path, kind: c.kind?.type ?? 'update', diff: clip(c.diff, 20_000) }));
  }

  #onItemStarted(item, turnId) {
    if (!item) return;
    const base = { id: item.id, turnId: turnId ?? this.#turnId };
    switch (item.type) {
      case 'userMessage': return;
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
      reason: p.reason ?? undefined, questions, options, defaultTo: 'allow', allowEdit: false,
    });
  }
}
