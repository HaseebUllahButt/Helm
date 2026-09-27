import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Driver, checkVersion, assertFolder } from './index.js';

/**
 * Pi and OMP, headless: `pi --mode rpc` / `omp --mode rpc`.
 *
 * Not ACP - a JSON-line command/event protocol of pi's own. Commands go to
 * stdin as `{id, type, ...}` and answer as `{type:"response", command,
 * success, data}`; everything else on stdout is an event: agent_start /
 * agent_end / agent_settled bracket a full user-message cycle, while
 * turn_start/turn_end are the inner model+tool loop and are not helm turns.
 *
 * Pi never asks permission for its own tools - approval lives in extensions
 * (bash-guard and friends), which reach us as `extension_ui_request` dialog
 * frames. Those become permission.request cards, answered with
 * `extension_ui_response` on stdin.
 *
 * OMP is the same wire protocol plus its own frames: a `ready` hello,
 * `available_commands_update` pushes, and advisor notices.
 *
 * Written against pi 0.x (docs/rpc.md in the installed package) and
 * omp live on this machine, probed 2026-09.
 */

const MAX_OUTPUT = 32_000;
const clip = (s, n = MAX_OUTPUT) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s);

/** Tools that spawn a child agent - their card is the parent. */
const SUBAGENT_TOOLS = new Set(['task', 'agent', 'subagent', 'spawn_agent', 'dispatch']);

const contentText = (content) =>
  Array.isArray(content) ? content.map((b) => (b?.type === 'text' ? b.text : '')).filter(Boolean).join('\n') : '';

class PiRpcDriver extends Driver {
  #pipe = null;
  #hosted = false;
  #exited = null;
  #seq = 0;
  /** request id -> resolve, for commands we sent */
  #calls = new Map();
  /** extension_ui_request id -> the request itself */
  #requests = new Map();
  /** toolCallId -> buffered argument JSON so far */
  #toolArgs = new Map();
  /** contentIndex -> open text/thinking item id */
  #blocks = new Map();
  /** contentIndex that streamed this message (vs. arrived only in the end snapshot) */
  #seen = new Set();
  /** contentIndex already emitted whole from a snapshot */
  #done = new Set();
  #msgSeq = 0;
  #turnId = null;
  /** prompts sent but not yet settled, oldest first - followUps queue */
  #turnQueue = [];
  /** compaction item currently open, if any */
  #compacting = null;
  /** user-message cycle in flight (agent_start .. agent_settled) */
  #working = false;
  #interrupting = false;
  /** usage reported by the latest message_update, for the turn summary */
  #usage = null;
  #commands = [];
  /** resolves when the start-up command/level probes have answered */
  #ready = null;

  constructor(spec, opts) {
    super({ engine: spec.engine, ...opts });
    this.spec = spec;
  }

  get args() {
    const a = [...this.profileArgs, '--mode', 'rpc'];
    if (this.model) a.push('--model', this.model);
    if (this.effort) a.push('--thinking', this.effort);
    // Resume is an id, not a path - a path would create an empty session at
    // that location when the file is gone.
    if (this.engineSessionId) a.push('--session', this.engineSessionId);
    return a;
  }

  async start() {
    if (this.#pipe) return;
    assertFolder(this);
    if (this.spec.min) await checkVersion(this.engine, this.cmd, this.env, this.spec.min, this.log);

    if (this.procId && this.procHost?.hasProc(this.procId)) {
      const pipe = this.procHost.procPipe(this.procId);
      if (pipe) return this.#adoptPipe(pipe);
    }

    let pipe = null;
    if (this.procId && this.procHost) {
      try {
        await this.procHost.openProc(this.procId, {
          cmd: this.cmd, args: this.args, cwd: this.cwd, env: this.env,
        });
        pipe = this.procHost.procPipe(this.procId);
      } catch (e) {
        this.log(`${this.engine}: no proc host (${e.message}); running under the daemon`);
      }
    }
    this.#hosted = !!pipe;
    if (!pipe) {
      const child = spawn(this.cmd, this.args, {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      pipe = this.#localPipe(child);
    }
    this.#bindPipe(pipe);

    // There is no handshake to wait on: commands are accepted as soon as the
    // process is up. Read the state the session already has - a resumed one
    // reports its id, model and whether it is mid-run.
    const state = await this.#call('get_state');
    if (state?.success) {
      const d = state.data ?? {};
      this.engineSessionId = d.sessionId ?? this.engineSessionId;
      this.info = {
        // `provider/id` is the selector pi itself takes - the bare id loses
        // which account it runs through.
        model: (d.model?.provider && d.model?.id ? `${d.model.provider}/${d.model.id}` : d.model?.id) ?? this.model,
        effort: d.thinkingLevel ?? this.effort,
      };
      if (d.isStreaming) {
        this.#working = true;
        this.push('status', { status: 'working' });
      }
      if (d.sessionName) this.push('title', { title: d.sessionName });
    }
    this.#ready = Promise.all([
      this.#call('get_commands').then((r) => {
        if (r?.success) this.#commands = this.#palette(r.data?.commands ?? []);
      }),
      this.#call('get_available_thinking_levels').then((r) => {
        if (r?.success && this.info) this.info.efforts = r.data?.levels ?? [];
      }),
    ]);
    this.emit('init', this.info ?? { model: this.model, effort: this.effort });
  }

  /**
   * The pickers the session can offer: the model list lives in models.js,
   * but the effort ladder the live agent answered is the truth for the
   * model it is running - surface it when the probe answered.
   */
  catalog() {
    const efforts = this.info?.efforts;
    return efforts?.length ? { efforts, current: this.info.model ?? null } : null;
  }

  async availableCommands() {
    await this.start();
    await this.#ready;
    return this.#commands;
  }

  #palette(commands) {
    return (commands ?? [])
      .filter((c) => c?.name)
      .map((c) => ({
        name: c.name,
        description: c.description,
        source: c.source ?? this.engine,
      }));
  }

  // -------------------------------------------------------------- transport

  #localPipe(child) {
    child.stderr.setEncoding('utf8');
    let tail = '';
    child.stderr.on('data', (d) => {
      tail = (tail + d).slice(-4000);
      if (process.env.HELM_DEBUG_DRIVER) process.stderr.write(d);
    });
    let exitResult = null;
    let exitHandler = null;
    const finish = (result) => {
      if (exitResult) return;
      exitResult = result;
      if (exitHandler) exitHandler(result);
    };
    child.on('exit', (code, signal) => finish({ code, signal, stderr: tail.trim().split('\n').pop() || null }));
    child.on('error', (err) => {
      const message = `could not start ${this.cmd}: ${err.message}`;
      tail = (tail + message).slice(-4000);
      this.push('error', { message, kind: 'spawn' });
      finish({ code: -1, signal: null, stderr: message });
    });
    return {
      write: (d) => child.stdin.write(d),
      end: () => child.stdin.end(),
      kill: (s) => child.kill(s),
      onData: (cb) => child.stdout.on('data', (c) => cb(typeof c === 'string' ? c : c.toString('utf8'))),
      onExit: (cb) => {
        exitHandler = cb;
        if (exitResult) queueMicrotask(() => cb(exitResult));
      },
      detach: () => {},
    };
  }

  #bindPipe(pipe) {
    this.#pipe = pipe;
    this.#exited = new Promise((resolve) => {
      pipe.onExit(({ code, stderr }) => {
        this.#pipe = null;
        for (const resolve of this.#calls.values()) resolve(null);
        this.#calls.clear();
        for (const requestId of [...this.pending.keys()]) {
          this.push('permission.resolved', { requestId, decision: 'cancelled' });
        }
        if (code && code !== 0 && !this.killed) {
          this.push('error', { message: `${this.engine} exited with code ${code}${stderr ? `: ${stderr}` : ''}`, kind: 'exit' });
        }
        if (this.#turnId) {
          this.push('turn.done', { turnId: this.#turnId, status: 'error', error: `${this.engine} exited` });
          this.#turnId = null;
        }
        this.push('status', { status: 'exited' });
        resolve({ code });
      });
    });
    let buf = '';
    pipe.onData((chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line);
          if (process.env.HELM_DEBUG_DRIVER) this.log(`${this.engine} <- ${line.slice(0, 300)}`);
          this.#onMessage(m);
        }
        catch { this.log(`${this.engine}: ${line.slice(0, 200)}`); }
      }
    });
  }

  /**
   * Rebind a process the host kept across a restart. Its state is intact -
   * the session is loaded, a turn may still be running - so there is no
   * get_state; recover what the event log still holds open and listen.
   */
  #adoptPipe(pipe) {
    this.#hosted = true;
    this.#bindPipe(pipe);
    this.#turnId = this.openTurn?.() ?? null;
    if (this.#turnId) { this.#working = true; this.#turnQueue = [this.#turnId]; }
    for (const e of this.pendingEvents?.() ?? []) {
      this.#requests.set(e.requestId, { id: e.requestId, method: e.dialogMethod });
      this.pending.set(e.requestId, e);
    }
    this.emit('init', this.info ?? { model: this.model, effort: this.effort });
  }

  #write(obj) {
    if (!this.#pipe) throw new Error(`${this.engine} is not running`);
    this.#pipe.write(JSON.stringify(obj) + '\n');
  }

  #call(type, fields = {}) {
    const id = `helm-${++this.#seq}`;
    return new Promise((resolve) => {
      this.#calls.set(id, resolve);
      try { this.#write({ id, type, ...fields }); }
      catch (e) { this.#calls.delete(id); resolve(null); }
      setTimeout(() => { if (this.#calls.delete(id)) resolve(null); }, 20_000).unref?.();
    });
  }

  // ----------------------------------------------------------------- verbs

  async send(text) {
    await this.start();
    const turnId = `turn-${randomUUID().slice(0, 8)}`;
    this.#turnQueue.push(turnId);
    this.#turnId ??= turnId;
    // Only a fresh cycle clears the counters; a followUp queued behind a
    // live turn must not zero the usage that turn is still accumulating.
    if (!this.#working) this.#usage = null;
    this.push('turn.start', { turnId, text });
    this.push('status', { status: 'working' });
    // A prompt sent while the agent is running is queued behind the current
    // cycle rather than steering it - followUp is helm's send-while-busy
    // semantics. Commands (/name) execute immediately either way.
    const r = await this.#call('prompt', {
      message: text,
      ...(this.#working ? { streamingBehavior: 'followUp' } : {}),
    });
    if (r && !r.success) {
      this.push('error', { message: r.error ?? `${this.engine} refused the prompt`, kind: 'turn' });
      this.#turnDone('error', r.error);
    }
  }

  async sendWithAttachments(text, attachments) {
    await this.start();
    const images = (attachments ?? [])
      .filter((a) => String(a?.mime ?? '').startsWith('image/') && a?.data)
      .map((a) => ({ type: 'image', data: a.data, mimeType: a.mime }));
    if (!images.length) return this.send(text || '(empty message)');
    const turnId = `turn-${randomUUID().slice(0, 8)}`;
    this.#turnQueue.push(turnId);
    this.#turnId ??= turnId;
    if (!this.#working) this.#usage = null;
    this.push('turn.start', { turnId, text });
    this.push('status', { status: 'working' });
    const r = await this.#call('prompt', {
      message: text || '', images,
      ...(this.#working ? { streamingBehavior: 'followUp' } : {}),
    });
    if (r && !r.success) {
      this.push('error', { message: r.error ?? `${this.engine} refused the prompt`, kind: 'turn' });
      this.#turnDone('error', r.error);
    }
  }

  acceptsImages() { return true; }

  /**
   * Answer an extension dialog. The wire shape depends on the method the
   * extension called: confirm wants `confirmed`, select/input/editor want
   * `value`, and any of them may take `cancelled`.
   */
  async answer(requestId, decision) {
    const req = this.pending.get(requestId);
    const raw = this.#requests.get(requestId);
    if (!req || !raw) throw new Error(`no pending request ${requestId}`);
    let response;
    if (decision.option === 'deny') {
      response = raw.method === 'confirm' ? { confirmed: false } : { cancelled: true };
    } else if (raw.method === 'confirm') {
      response = { confirmed: true };
    } else {
      // select, input, editor: the picked label or the typed text. The
      // QuestionSheet puts it in answers keyed by the question we sent.
      const answers = decision.answers ?? {};
      const value = answers[req.title] ?? Object.values(answers)[0] ?? decision.message ?? '';
      response = { value };
    }
    this.#write({ type: 'extension_ui_response', id: raw.id, ...response });
    this.#requests.delete(requestId);
    this.push('permission.resolved', { requestId, decision: decision.option });
    this.push('status', { status: 'working' });
  }

  async interrupt() {
    if (!this.#pipe) return;
    this.#interrupting = true;
    this.#write({ type: 'abort' });
  }

  async setModel(model) {
    this.model = model || null;
    if (!this.#pipe || !model) return;
    const [provider, ...rest] = model.split('/');
    const r = rest.length
      ? await this.#call('set_model', { provider, modelId: rest.join('/') })
      : await this.#call('set_model', { modelId: model });
    if (r && !r.success) {
      this.push('error', { message: `${this.spec.label ?? this.engine} does not offer "${model}" here. (${r.error})`, kind: 'settings' });
    }
  }

  async setEffort(effort) {
    this.effort = effort || null;
    if (!this.#pipe || !effort) return;
    const r = await this.#call('set_thinking_level', { level: effort });
    if (r && !r.success) {
      this.push('error', { message: `${this.spec.label ?? this.engine} does not offer effort "${effort}" here. (${r.error})`, kind: 'settings' });
    }
  }

  /** Pi has no permission modes - the engine either runs tools or not. */
  async setMode(id) { this.mode = id; }

  async compact(hint) {
    await this.start();
    await this.#call('compact', hint ? { customInstructions: hint } : {});
  }

  async kill() {
    this.killed = true;
    const pipe = this.#pipe;
    if (!pipe) return;
    for (const requestId of [...this.pending.keys()]) {
      try { await this.answer(requestId, { option: 'deny' }); } catch { /* already gone */ }
    }
    try { pipe.end(); } catch { /* closed */ }
    const done = await Promise.race([this.#exited, new Promise((r) => setTimeout(() => r(null), 3000))]);
    if (!done) pipe.kill('SIGTERM');
    const done2 = await Promise.race([this.#exited, new Promise((r) => setTimeout(() => r(null), 2000))]);
    if (!done2) pipe.kill('SIGKILL');
    await Promise.race([this.#exited, new Promise((r) => setTimeout(() => r(null), 2000))]);
  }

  /** Keep a hosted process alive while this daemon is being replaced. */
  async suspend() {
    if (this.#hosted && this.#pipe) {
      this.#pipe.detach();
      this.#pipe = null;
      return;
    }
    return this.kill();
  }

  // ------------------------------------------------------------- the stream

  #onMessage(m) {
    // A command response, correlated by id.
    if (m.type === 'response') {
      const resolve = m.id !== undefined ? this.#calls.get(m.id) : null;
      if (resolve) { this.#calls.delete(m.id); resolve(m); }
      return;
    }
    switch (m.type) {
      // omp's hello; pi emits nothing until asked.
      case 'ready': return;
      case 'available_commands_update':
        this.#commands = this.#palette(m.commands);
        return;
      case 'agent_start':
        this.#working = true;
        if (!this.pending.size) this.push('status', { status: 'working' });
        return;
      case 'agent_end': {
        // The final messages carry the last word on text and usage - a
        // model that does not stream deltas still reports them here.
        const last = Array.isArray(m.messages) ? m.messages.filter((x) => x?.role === 'assistant').at(-1) : null;
        if (last?.usage) this.#usage = last.usage;
        if (last) this.#onAssistantSnapshot(last, true);
        // willRetry (pi) / willContinue (omp) mean the cycle is not over.
        if (m.willRetry || m.willContinue) return;
        // omp does not always follow with agent_settled; an agent_end with
        // no continuation flagged settles the turn either way.
        return this.#settled();
      }
      case 'agent_settled':
        return this.#settled();
      case 'turn_start': case 'turn_end':
        return; // the model+tool loop inside one agent cycle
      case 'message_start':
        this.#msgSeq += 1;
        this.#blocks = new Map();
        this.#seen = new Set();
        this.#done = new Set();
        // The message at message_start can already carry partial text; only
        // tool inputs are authoritative this early.
        this.#onAssistantSnapshot(m.message, false);
        return;
      case 'message_update': {
        if (m.usage) this.#usage = m.usage;
        return this.#onDelta(m.assistantMessageEvent);
      }
      case 'message_end':
        // Close any content block still open, then apply the final message
        // (complete tool inputs, final text) as the authoritative snapshot.
        for (const id of this.#blocks.values()) this.push('item.done', { id, status: 'ok' });
        this.#blocks.clear();
        if (m.message?.usage) this.#usage = m.message.usage;
        this.#onAssistantSnapshot(m.message, true);
        return;
      case 'tool_execution_start': {
        const kind = SUBAGENT_TOOLS.has(m.toolName) ? 'subagent' : 'tool';
        this.#toolArgs.delete(m.toolCallId);
        this.push('item.start', {
          id: m.toolCallId, kind, turnId: this.#turnId,
          name: m.toolName, input: m.args ?? {},
        });
        return;
      }
      case 'tool_execution_update': {
        const text = contentText(m.partialResult?.content);
        if (text) this.push('item.update', { id: m.toolCallId, output: clip(text) });
        return;
      }
      case 'tool_execution_end': {
        const text = contentText(m.result?.content);
        this.push('item.done', {
          id: m.toolCallId,
          status: m.isError ? 'error' : 'ok',
          output: clip(text),
        });
        return;
      }
      case 'extension_ui_request': return this.#onUiRequest(m);
      case 'extension_error':
        this.push('error', { message: m.error ?? m.message ?? 'extension error', kind: 'extension' });
        return;
      case 'compaction_start': {
        const id = `compact-${randomUUID().slice(0, 8)}`;
        this.#compacting = id;
        this.push('item.start', { id, kind: 'tool', turnId: this.#turnId, name: 'compact', input: {} });
        return;
      }
      case 'compaction_end':
        if (this.#compacting) {
          this.push('item.done', { id: this.#compacting, status: m.aborted ? 'declined' : 'ok' });
          this.#compacting = null;
        }
        return;
      case 'auto_retry_start':
        this.push('status', { status: 'working' });
        return;
      case 'auto_retry_end':
        if (m.success === false) this.push('error', { message: m.error ?? 'retry failed', kind: 'retry' });
        return;
      // queue_update, bash_execution_update, summarization_retry_* - client
      // plumbing the transcript does not need.
      default: return;
    }
  }

  /**
   * An extension is asking the owner something. Dialog methods block the
   * agent until `extension_ui_response` arrives; fire-and-forget ones are
   * surfaced but never answered.
   */
  #onUiRequest(m) {
    switch (m.method) {
      case 'confirm': {
        this.#requests.set(m.id, m);
        this.push('permission.request', {
          requestId: m.id, kind: 'tool', dialogMethod: 'confirm', title: m.title ?? 'Allow?',
          detail: m.message, options: [
            { id: 'allow', role: 'allow', label: 'Yes' },
            { id: 'deny', role: 'deny', label: 'No' },
          ], defaultTo: 'allow',
        });
        this.push('status', { status: 'blocked' });
        return;
      }
      case 'select': {
        this.#requests.set(m.id, m);
        this.push('permission.request', {
          requestId: m.id, kind: 'question', dialogMethod: 'select',
          title: m.title ?? 'Choose',
          questions: [{
            question: m.title ?? 'Choose',
            options: (m.options ?? []).map((o) => ({ label: String(o) })),
          }],
          options: [], defaultTo: 'allow',
        });
        this.push('status', { status: 'blocked' });
        return;
      }
      case 'input': case 'editor': {
        this.#requests.set(m.id, m);
        this.push('permission.request', {
          requestId: m.id, kind: 'question', dialogMethod: m.method,
          title: m.title ?? (m.method === 'editor' ? 'Edit text' : 'Enter a value'),
          questions: [{ question: m.title ?? 'Input', options: [] }],
          options: [], defaultTo: 'allow',
        });
        this.push('status', { status: 'blocked' });
        return;
      }
      case 'notify':
        this.push('error', { message: m.message ?? 'notification', kind: 'notify' });
        return;
      // setStatus, setWidget, setTitle, set_editor_text - composer furniture
      // with no phone equivalent.
      default: return;
    }
  }

  /** One streamed content block inside an assistant message. */
  #onDelta(e) {
    if (!e) return;
    const key = e.contentIndex ?? 0;
    switch (e.type) {
      case 'text_start': {
        const id = `m${this.#msgSeq}:${key}`;
        this.#blocks.set(key, id);
        this.#seen.add(key);
        this.push('item.start', { id, kind: 'text', turnId: this.#turnId });
        return;
      }
      case 'thinking_start': {
        const id = `k${this.#msgSeq}:${key}`;
        this.#blocks.set(key, id);
        this.#seen.add(key);
        this.push('item.start', { id, kind: 'thinking', turnId: this.#turnId });
        return;
      }
      case 'text_delta': case 'thinking_delta': {
        const id = this.#blocks.get(key);
        if (id && e.delta) this.push('item.delta', { id, text: e.delta });
        return;
      }
      case 'text_end': case 'thinking_end': {
        const id = this.#blocks.get(key);
        if (id) { this.push('item.done', { id, status: 'ok' }); this.#blocks.delete(key); }
        return;
      }
      case 'toolcall_start': {
        this.#toolArgs.set(e.id, '');
        const kind = SUBAGENT_TOOLS.has(e.toolName) ? 'subagent' : 'tool';
        this.push('item.start', { id: e.id, kind, turnId: this.#turnId, name: e.toolName, input: {} });
        return;
      }
      case 'toolcall_delta': {
        if (!e.id) return;
        const soFar = (this.#toolArgs.get(e.id) ?? '') + (e.delta ?? '');
        this.#toolArgs.set(e.id, soFar);
        if (e.delta) this.push('item.delta', { id: e.id, text: e.delta });
        return;
      }
      case 'toolcall_end': {
        this.#toolArgs.delete(e.id);
        const input = e.toolCall?.args ?? e.toolCall?.arguments ?? {};
        this.push('item.update', { id: e.id ?? e.toolCall?.id, input });
        return;
      }
      default: return;
    }
  }

  /**
   * A completed message carries authoritative content - the streaming deltas
   * may have skipped blocks entirely (a model that answers in one shot, or
   * a tool that never got a toolcall_start). Emit whole any text/thinking
   * block that never streamed and update the input of any tool we know.
   */
  #onAssistantSnapshot(message, final) {
    if (!message || message.role !== 'assistant') return;
    for (const [i, block] of (message.content ?? []).entries()) {
      if (block?.type === 'toolCall') {
        if (block.id) this.push('item.update', { id: block.id, input: block.args ?? block.arguments ?? {} });
        continue;
      }
      // Whole-block emit only once the message is complete - message_start
      // can already carry a partial block whose own text_start then streams.
      if (!final) continue;
      // omp calls a thinking block's body `thinking`; pi uses `text`.
      const body = block?.type === 'thinking' ? (block.thinking ?? block.text) : block?.text;
      if ((block?.type !== 'text' && block?.type !== 'thinking') || !body) continue;
      if (this.#seen.has(i) || this.#done.has(i)) continue;
      this.#done.add(i);
      const id = `${block.type === 'thinking' ? 'k' : 'm'}${this.#msgSeq}:${i}`;
      const kind = block.type === 'thinking' ? 'thinking' : 'text';
      this.push('item.start', { id, kind, turnId: this.#turnId });
      this.push('item.delta', { id, text: body });
      this.push('item.done', { id, status: 'ok' });
    }
  }

  /**
   * The agent's whole cycle settled. The front of the queue is the prompt
   * it was answering; a queued followUp becomes the live turn next.
   */
  #settled() {
    this.#working = false;
    const status = this.#interrupting ? 'interrupted' : 'ok';
    this.#interrupting = false;
    const turnId = this.#turnQueue.shift() ?? this.#turnId;
    if (turnId) {
      this.flush();
      const u = this.#usage;
      this.push('turn.done', {
        turnId, status,
        usage: u && { input: u.input, output: u.output, cacheRead: u.cacheRead },
        costUsd: u?.cost?.total ?? undefined,
      });
    }
    this.#turnId = this.#turnQueue[0] ?? null;
    this.#usage = null;
    if (this.#turnId) this.push('status', { status: 'working' });
    else if (!this.pending.size) this.push('status', { status: 'idle' });
  }

  #turnDone(status, error) {
    const turnId = this.#turnQueue.shift() ?? this.#turnId;
    if (!turnId) return;
    if (this.#turnId === turnId) this.#turnId = this.#turnQueue[0] ?? null;
    this.#interrupting = false;
    this.flush();
    const u = this.#usage;
    this.push('turn.done', {
      turnId, status, error,
      usage: u && { input: u.input, output: u.output, cacheRead: u.cacheRead },
      costUsd: u?.cost?.total ?? undefined,
    });
    if (!this.pending.size && !this.#turnId) this.push('status', { status: 'idle' });
  }
}

export class PiDriver extends PiRpcDriver {
  constructor(opts) {
    super({ engine: 'pi', label: 'Pi' }, opts);
  }
}

/** OMP is the same wire protocol with extra frames; the base driver covers it. */
export class OmpDriver extends PiRpcDriver {
  constructor(opts) {
    super({ engine: 'omp', label: 'OMP' }, opts);
  }
}
