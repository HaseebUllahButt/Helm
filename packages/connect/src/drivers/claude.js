import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Driver, readJsonLines, checkVersion } from './index.js';
import { modeFor } from '../modes.js';

/**
 * Claude Code, headless.
 *
 * One process per session: `claude -p` with stream-json on both stdin and
 * stdout. Text, thinking and tool inputs arrive as partial message chunks;
 * tool results come back as `user` messages; permission prompts arrive as
 * `can_use_tool` control requests that we answer on stdin. Stdin stays open
 * for the life of the session - closing it tells the CLI to finish and exit.
 *
 * Written against Claude Code 2.1.260 and the streams recorded in
 * test/fixtures/claude by scripts/record-driver.mjs.
 */

export const CLAUDE_MIN_VERSION = '2.1.260';

const BASE_ARGS = [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool', 'stdio',
];

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const MAX_OUTPUT = 32_000;
const clip = (s, n = MAX_OUTPUT) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s);
const stripAnsi = (s) => (typeof s === 'string' ? s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') : s);

/** The text of a tool_result, whatever shape the CLI sent it in. */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  return '';
}

export class ClaudeDriver extends Driver {
  #child = null;
  #exited = null;
  #ready = null;
  /** `${messageId}#${index}` for text/thinking blocks, the tool_use id for tools */
  #blocks = new Map();
  #messageId = null;
  #turnId = null;
  #interrupting = false;
  #capabilities = new Set();
  /** request_id -> resolve, for control requests we sent */
  #controls = new Map();
  #controlSeq = 0;

  constructor(opts) {
    super({ engine: 'claude', ...opts });
    this.engineSessionId ??= randomUUID();
    this.resume = !!opts.engineSessionId;
  }

  get args() {
    const mode = modeFor('claude', this.mode);
    const args = [...this.profileArgs, ...BASE_ARGS, '--permission-mode', mode?.cli ?? 'manual'];
    if (this.model) args.push('--model', this.model);
    if (this.effort) args.push('--effort', this.effort);
    args.push(this.resume ? `--resume=${this.engineSessionId}` : `--session-id=${this.engineSessionId}`);
    return args;
  }

  async start() {
    if (this.#child) return;
    await checkVersion('claude', this.cmd, this.env, CLAUDE_MIN_VERSION, this.log);
    const child = spawn(this.cmd, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); if (process.env.HELM_DEBUG_DRIVER) process.stderr.write(d); });
    readJsonLines(child.stdout, (m) => this.#onMessage(m), (line) => this.log(`claude: ${line.slice(0, 200)}`));

    let markReady;
    this.#ready = new Promise((r) => { markReady = r; });
    this.once('init', markReady);

    this.#exited = new Promise((resolve) => {
      child.on('exit', (code, signal) => {
        this.#child = null;
        markReady();
        // A prompt the CLI was holding open dies with it; say so.
        for (const requestId of [...this.pending.keys()]) {
          this.push('permission.resolved', { requestId, decision: 'cancelled' });
        }
        if (code && code !== 0 && !this.killed) {
          this.push('error', { message: `claude exited with code ${code}${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`, kind: 'exit' });
        }
        this.push('status', { status: 'exited' });
        resolve({ code, signal });
      });
    });
    child.on('error', (err) => this.push('error', { message: `could not start ${this.cmd}: ${err.message}`, kind: 'spawn' }));
    // The next turn resumes this session.
    this.resume = true;
  }

  #write(obj) {
    if (!this.#child?.stdin.writable) throw new Error('claude is not running');
    this.#child.stdin.write(JSON.stringify(obj) + '\n');
  }

  #control(request) {
    const request_id = `helm-${++this.#controlSeq}`;
    return new Promise((resolve, reject) => {
      this.#controls.set(request_id, resolve);
      try { this.#write({ type: 'control_request', request_id, request }); }
      catch (e) { this.#controls.delete(request_id); reject(e); }
      setTimeout(() => { if (this.#controls.delete(request_id)) resolve(null); }, 15_000).unref?.();
    });
  }

  // ----------------------------------------------------------------- verbs

  async send(text) {
    await this.start();
    this.#write({
      type: 'user', session_id: '', parent_tool_use_id: null, uuid: randomUUID(),
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
    this.push('status', { status: 'working' });
  }

  /**
   * Answer a permission request. `decision` is what the phone chose:
   *   { option: 'allow' | 'always' | 'deny', message?, answers?, updatedInput? }
   */
  async answer(requestId, decision) {
    const req = this.pending.get(requestId);
    if (!req) throw new Error(`no pending request ${requestId}`);
    const raw = req.raw;
    let response;
    if (decision.option === 'deny') {
      response = { behavior: 'deny', message: decision.message || 'The owner declined this from helm.' };
    } else {
      response = { behavior: 'allow' };
      if (decision.option === 'always' && raw.permission_suggestions?.length) {
        response.updatedPermissions = raw.permission_suggestions;
      }
      if (req.kind === 'question' && decision.answers) {
        // The permission component fills in `answers` (question -> label).
        response.updatedInput = { ...raw.input, answers: decision.answers };
      } else if (decision.updatedInput) {
        response.updatedInput = decision.updatedInput;
      }
    }
    this.#write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    this.push('permission.resolved', { requestId, decision: decision.option });
    this.push('status', { status: 'working' });
  }

  async interrupt() {
    if (!this.#child) return;
    this.#interrupting = true;
    await this.#control({ subtype: 'interrupt', cancel_queued: this.#capabilities.has('interrupt_cancel_queued_v1') });
  }

  async setModel(model) {
    this.model = model || null;
    if (this.#child) await this.#control({ subtype: 'set_model', model: model || null });
  }

  async setMode(id) {
    this.mode = id;
    const mode = modeFor('claude', id);
    if (this.#child && mode) await this.#control({ subtype: 'set_permission_mode', mode: mode.cli === 'manual' ? 'default' : mode.cli });
  }

  async kill() {
    this.killed = true;
    const child = this.#child;
    if (!child) return;
    // A prompt left unanswered blocks the CLI forever; close them out first.
    for (const requestId of [...this.pending.keys()]) {
      try { await this.answer(requestId, { option: 'deny', message: 'The session was ended.' }); } catch { /* already gone */ }
    }
    try { child.stdin.end(); } catch { /* closed */ }
    const done = await Promise.race([this.#exited, new Promise((r) => setTimeout(() => r(null), 3000))]);
    if (!done) child.kill('SIGTERM');
    const done2 = await Promise.race([this.#exited, new Promise((r) => setTimeout(() => r(null), 2000))]);
    if (!done2) child.kill('SIGKILL');
    await this.#exited;
  }

  // ------------------------------------------------------------- the stream

  #onMessage(m) {
    switch (m.type) {
      case 'control_request': return this.#onControlRequest(m);
      case 'control_response': {
        const resolve = this.#controls.get(m.response?.request_id);
        if (resolve) { this.#controls.delete(m.response.request_id); resolve(m.response); }
        return;
      }
      case 'control_cancel_request':
        if (this.pending.has(m.request_id)) this.push('permission.resolved', { requestId: m.request_id, decision: 'cancelled' });
        return;
      case 'keep_alive': case 'command_lifecycle': return;
      case 'system': return this.#onSystem(m);
      case 'user': return this.#onUser(m);
      case 'stream_event': return this.#onStreamEvent(m.event);
      case 'assistant': return this.#onAssistant(m);
      case 'tool_progress':
        this.push('item.update', { id: m.tool_use_id, elapsed: m.elapsed_time_seconds });
        return;
      case 'rate_limit_event':
        this.push('limits', { claude: m.rate_limit_info });
        return;
      case 'result': return this.#onResult(m);
      default: return;
    }
  }

  #onSystem(m) {
    if (m.subtype === 'init') {
      this.engineSessionId = m.session_id ?? this.engineSessionId;
      this.#capabilities = new Set(m.capabilities ?? []);
      this.info = { model: m.model, permissionMode: m.permissionMode, version: m.claude_code_version, effort: m.effort };
      this.emit('init', this.info);
    }
  }

  #onUser(m) {
    if (m.isReplay) {
      // The CLI accepted our message; this uuid is the turn.
      this.#turnId = m.uuid;
      const text = resultText(m.message?.content);
      this.push('turn.start', { turnId: m.uuid, text });
      return;
    }
    for (const block of m.message?.content ?? []) {
      if (block.type !== 'tool_result') continue;
      const output = resultText(block.content);
      this.push('item.done', {
        id: block.tool_use_id,
        status: block.is_error ? 'error' : 'ok',
        output: clip(output),
        result: this.#summariseResult(m.tool_use_result),
      });
    }
  }

  /** The structured tool output, minus anything huge. */
  #summariseResult(r) {
    if (!r || typeof r !== 'object') return typeof r === 'string' ? clip(r, 2000) : undefined;
    const out = {};
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'string') out[k] = clip(v, 4000);
      else if (v == null || typeof v !== 'object') out[k] = v;
      else if (k === 'structuredPatch' || k === 'answers' || k === 'questions') out[k] = v;
    }
    return out;
  }

  #onStreamEvent(e) {
    switch (e?.type) {
      case 'message_start':
        this.#messageId = e.message?.id ?? randomUUID();
        return;
      case 'content_block_start': {
        const b = e.content_block;
        if (b.type === 'tool_use') {
          this.#blocks.set(e.index, b.id);
          this.push('item.start', { id: b.id, kind: 'tool', turnId: this.#turnId, name: b.name, input: b.input ?? {} });
        } else if (b.type === 'text' || b.type === 'thinking') {
          const id = `${this.#messageId}#${e.index}`;
          this.#blocks.set(e.index, id);
          this.push('item.start', { id, kind: b.type, turnId: this.#turnId });
        }
        return;
      }
      case 'content_block_delta': {
        const id = this.#blocks.get(e.index);
        if (!id) return;
        const d = e.delta;
        if (d.type === 'text_delta' && d.text) this.push('item.delta', { id, text: d.text });
        else if (d.type === 'thinking_delta' && d.thinking) this.push('item.delta', { id, text: d.thinking });
        else if (d.type === 'input_json_delta' && d.partial_json) this.push('item.delta', { id, text: d.partial_json });
        return;
      }
      case 'content_block_stop': {
        const id = this.#blocks.get(e.index);
        if (id && !id.startsWith('toolu_')) this.push('item.done', { id, status: 'ok' });
        return;
      }
      default: return;
    }
  }

  #onAssistant(m) {
    if (m.error) this.push('error', { message: resultText(m.message?.content) || m.error, kind: m.error });
    for (const block of m.message?.content ?? []) {
      if (block.type === 'tool_use') {
        // The complete input, after the partial JSON that streamed in.
        this.push('item.update', { id: block.id, input: block.input });
      }
    }
  }

  #onResult(m) {
    const interrupted = this.#interrupting && m.is_error;
    this.#interrupting = false;
    this.push('turn.done', {
      turnId: this.#turnId,
      status: interrupted ? 'interrupted' : m.is_error ? 'error' : 'ok',
      costUsd: m.total_cost_usd,
      usage: m.usage && { input: m.usage.input_tokens, output: m.usage.output_tokens, cacheRead: m.usage.cache_read_input_tokens },
      durationMs: m.duration_ms,
      error: m.is_error && !interrupted ? (m.errors?.join('; ') || m.result || m.subtype) : undefined,
    });
    this.push('status', { status: 'idle' });
  }

  #onControlRequest(m) {
    const r = m.request;
    if (r?.subtype !== 'can_use_tool') {
      this.log(`claude: unanswered control request ${r?.subtype}`);
      return;
    }
    const tool = r.tool_name;
    const input = r.input ?? {};
    const kind = tool === 'AskUserQuestion' ? 'question'
      : tool === 'ExitPlanMode' ? 'plan'
      : tool === 'Bash' ? 'command'
      : EDIT_TOOLS.has(tool) ? 'edit' : 'tool';

    const title = stripAnsi(r.title) || (
      kind === 'command' ? 'Run a command'
      : kind === 'edit' ? `${tool === 'Write' ? 'Write' : 'Edit'} ${r.description || input.file_path?.split('/').pop() || 'a file'}`
      : kind === 'question' ? 'Claude has a question'
      : kind === 'plan' ? 'Claude has a plan'
      : `${r.display_name || tool}${r.description ? ` · ${r.description}` : ''}`);

    const detail = kind === 'command' ? input.command
      : kind === 'plan' ? input.plan
      : kind === 'edit' ? this.#editDetail(tool, input)
      : kind === 'question' ? undefined
      : clip(JSON.stringify(input, null, 2), 4000);

    const options = [];
    if (kind === 'question') {
      // The card is the answer surface; the options are the questions'.
    } else if (kind === 'plan') {
      options.push({ id: 'allow', role: 'allow', label: 'Approve plan' }, { id: 'deny', role: 'deny', label: 'Keep planning' });
    } else {
      options.push({ id: 'allow', role: 'allow', label: 'Allow' });
      if (r.permission_suggestions?.length && !r.suppress_always_allow_rule) {
        options.push({ id: 'always', role: 'allow-always', label: this.#alwaysLabel(r.permission_suggestions, tool) });
      }
      options.push({ id: 'deny', role: 'deny', label: 'Deny' });
    }

    this.push('status', { status: 'blocked' });
    this.push('permission.request', {
      requestId: m.request_id,
      itemId: r.tool_use_id,
      kind, tool, title,
      detail: stripAnsi(detail),
      reason: stripAnsi(r.decision_reason) || undefined,
      input: kind === 'question' || kind === 'plan' ? undefined : input,
      questions: kind === 'question' ? input.questions : undefined,
      options,
      defaultTo: r.default_to_no ? 'deny' : 'allow',
      allowEdit: kind === 'command' || kind === 'plan',
      raw: { input, permission_suggestions: r.permission_suggestions },
    });
  }

  #alwaysLabel(suggestions, tool) {
    const s = suggestions[0];
    if (s?.type === 'setMode' && s.mode === 'acceptEdits') return 'Allow all edits this session';
    if (s?.type === 'addRules') {
      const rule = s.rules?.[0]?.ruleContent;
      return rule ? `Always allow ${tool}(${rule.length > 24 ? rule.slice(0, 24) + '…' : rule})` : `Always allow ${tool}`;
    }
    return 'Always allow';
  }

  #editDetail(tool, input) {
    if (tool === 'Write') return { path: input.file_path, content: clip(input.content, 20_000) };
    if (tool === 'Edit') return { path: input.file_path, old: clip(input.old_string, 10_000), new: clip(input.new_string, 10_000), all: !!input.replace_all };
    if (tool === 'MultiEdit') return { path: input.file_path, edits: (input.edits ?? []).slice(0, 20).map((e) => ({ old: clip(e.old_string, 4000), new: clip(e.new_string, 4000) })) };
    return { path: input.notebook_path ?? input.file_path, content: clip(input.new_source, 10_000) };
  }
}
