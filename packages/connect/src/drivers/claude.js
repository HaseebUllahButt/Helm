import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Driver, checkVersion, assertFolder } from './index.js';
import { modeFor } from '../modes.js';
import { nonAgentClaudeTask } from '../claude-tasks.js';
import { bareModel, compactWindow, configDir } from '../context-limit.js';
import { WORTH_SAYING } from '@helm/usage/recache';

// Messages that mean the CLI is working: outside a turn, a turn it began itself.
// A bare `result` is not one: a result with no work before it is the last
// turn's result said again.
const WAKE_TYPES = new Set(['user', 'stream_event', 'assistant']);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * Claude Code runs a PreModelSwitch hook before it switches model, with
 * what the switch costs: whether its prompt cache is still warm
 * (`prompt_cache_warm`), the size it re-sends (`context_tokens`) and the
 * price of writing that again on the new model (`estimated_cache_write_usd`).
 * Helm registers for it when the process starts, so the app can ask with
 * Claude's own figures instead of its own estimate.
 *
 * Claude does not say which hooks it knows, and an unknown one is accepted
 * silently. 2.1.300 is the oldest version checked to send this one; on an
 * older Claude the app keeps its estimate.
 */
const MODEL_SWITCH_HOOK = 'helm-model-switch';
const MODEL_SWITCH_SINCE = '2.1.300';
const atLeast = (version, min) => {
  const a = String(version ?? '').split('.').map(Number), b = min.split('.').map(Number);
  if (a.length < 3 || a.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

const BASE_ARGS = [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool', 'stdio',
];

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const MAX_OUTPUT = 32_000;
const clip = (s, n = MAX_OUTPUT) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s);
const stripAnsi = (s) => (typeof s === 'string' ? s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '') : s);
const automaticDecision = (mode, kind) => {
  if (kind === 'question') return null;
  if (mode === 'auto') return {
    option: 'deny',
    message: 'Blocked by Claude Auto safety mode. Switch to Bypass all checks to allow this action.',
  };
  if (mode === 'bypassPermissions') return { option: 'allow' };
  return null;
};

/** The text of a tool_result, whatever shape the CLI sent it in. */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  return '';
}

/**
 * Claude's record of a command it ran itself (/model, /cost, a model change
 * made from the picker): a caveat, the command, and what it printed - each
 * replayed as a user message in Claude's own markup. None of them is
 * something the owner wrote.
 */
const COMMAND_NAME = /^(?:<command-message>[\s\S]*?<\/command-message>\s*)?<command-name>\s*([^<]*?)\s*<\/command-name>/;

export function localCommandRecord(text) {
  const s = String(text ?? '').trim();
  if (s.startsWith('<local-command-caveat>')) return { kind: 'note' };
  // A skill run as a command ("/rpc-action-items for today") opens with
  // <command-message>, a built-in one with <command-name>.
  const name = s.match(COMMAND_NAME);
  if (name) {
    const args = s.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1].trim();
    return { kind: 'command', text: args ? `${name[1]} ${args}` : name[1] };
  }
  const out = [...s.matchAll(/<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/g)];
  if (out.length && /^<local-command-(?:stdout|stderr)>/.test(s)) {
    return { kind: 'output', text: stripAnsi(out.map((m) => m[1]).join('\n')).trim() };
  }
  return null;
}

export class ClaudeDriver extends Driver {
  static canRewind = true;

  async prepareRewind({ first, resumeAt }) {
    if (!first && !UUID.test(resumeAt ?? '')) throw new Error('Claude has no saved boundary before this message.');
    return { engineSessionId: randomUUID(), transcript: null, unsent: true,
      forkFrom: first ? null : { sessionId: this.engineSessionId, at: resumeAt } };
  }

  async validateRewind() {
    await this.start();
    const response = await this.#initialize();
    if (response?.subtype !== 'success') throw new Error(response?.error || 'Claude did not confirm the rewind boundary.');
  }
  /** helm's brief rides in the system prompt, not the first message. */
  static takesInstructions = true;
  #pipe = null;
  #hosted = false;
  #exited = null;
  #ready = null;
  /**
   * `${messageId}#${index}` for text/thinking blocks, the tool_use id for
   * tools - one map per sidechain: a subagent's stream_events interleave
   * with its parent's and carry the parent's tool_use id.
   */
  #scopes = new Map();
  /** task_id -> tool_use_id, from task_started system frames */
  #tasks = new Map();
  /** task_ids started and not yet ended: helpers, background commands, watches. */
  #running = new Set();

  /**
   * Work Claude left running after its turn - a background command, a watch,
   * a helper. Claude wakes up for it when it ends, so a chat waiting on one is
   * not finished, however idle it looks.
   */
  get backgroundTasks() { return this.#running.size; }
  /**
   * Background commands and passive watches use the same task frames as
   * helpers. They stay in the transcript without keeping the chat working
   * or creating a child-task alarm.
   */
  #nonAgentTasks = new Set();
  #turnId = null;
  /** A turn is running: a replayed user message now is one handed over mid-turn. */
  #inTurn = false;
  /** The last top-level assistant message, which is where a branch can be cut. */
  #lastAssistant = null;
  #interrupting = false;
  #capabilities = new Set();
  /** uuid -> { text, inputId } for messages steered into a turn and not yet read. */
  #inputs = new Map();
  /** Commands advertised by this exact Claude Code process at init. */
  #commands = [];
  /**
   * What a command Claude answers itself (/context, /cost, /model) printed,
   * held until its turn opens: the answer arrives before the echo of the
   * command that asked for it.
   */
  #commandOutput = [];
  /** How full the conversation is after the latest top-level reply, and the size it counts against. */
  #contextUsed = null;
  #contextWindow = null;
  /** The model's whole window, before the account's compaction size cuts it down. */
  #contextFull = null;
  #contextModel = null;
  /** The last message sent as a new turn, for an answer that never echoes it. */
  #lastSent = '';
  /** request_id -> resolve, for control requests we sent */
  #controls = new Map();
  #controlSeq = 0;
  /** This process runs Helm's PreModelSwitch hook, so a switch can be priced by Claude. */
  #modelSwitchSignal = false;
  /** The model change Helm asked for, while Claude's hook may still ask about it. */
  #switching = null;

  constructor(opts) {
    super({ engine: 'claude', ...opts });
    this.engineSessionId ??= randomUUID();
    this.resume = !!opts.engineSessionId && !opts.unsent;
    this.instructions = opts.instructions || null;
    this.delegated = !!opts.delegated;
    // Helm is an interactive chat client using Claude's stream protocol.
    // Print mode otherwise labels it sdk-cli, which Claude's native resume
    // picker deliberately hides. Use the supported interactive-client path;
    // child tasks remain SDK sessions rather than cluttering that picker.
    this.env = { ...this.env, CLAUDE_CODE_ENTRYPOINT: this.delegated ? 'sdk-cli' : 'claude-vscode' };
    // Claude keeps a chat's saved context for an hour on a subscription but
    // only five minutes for the helpers its own Agent tool starts, so a
    // helper that pauses for a build re-reads everything at full price.
    // Give helpers the hour too. An API-key account pays extra for the hour
    // and gets five minutes everywhere, so it is left alone, as is any
    // account whose own environment already decides.
    const apiKey = !!(this.env.ANTHROPIC_API_KEY || this.env.ANTHROPIC_AUTH_TOKEN);
    const decided = ['CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', 'FORCE_PROMPT_CACHING_5M', 'ENABLE_PROMPT_CACHING_1H']
      .some((name) => this.env[name] !== undefined);
    if (!apiKey && !decided) this.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL = '1h';
    // A thread branched from another: begin as that conversation was at `at`.
    // Both ids are checked here as well as by whoever asked - they end up as
    // arguments to a process.
    const f = opts.forkFrom;
    this.forkFrom = f && UUID.test(f.sessionId ?? '') && UUID.test(f.at ?? '') ? { sessionId: f.sessionId, at: f.at } : null;
  }

  get args() {
    const mode = modeFor('claude', this.mode);
    const args = [...this.profileArgs, ...BASE_ARGS, '--permission-mode', mode?.cli ?? 'manual'];
    if (this.model) args.push('--model', this.model);
    if (this.effort) args.push('--effort', this.effort);
    // The CLI's own subagents stay on: they show as cards like any other
    // tool. Helm's delegate is only for reaching another CLI or account.
    args.push('--disallowedTools', 'EnterPlanMode,ExitPlanMode');
    if (this.instructions) args.push('--append-system-prompt', this.instructions);
    if (this.forkFrom) {
      // Until the branch has said its first word it is not yet a conversation
      // of its own, so every start - including one after a restart - is the
      // fork, into the id this thread already has.
      args.push(`--resume=${this.forkFrom.sessionId}`, '--fork-session',
        `--resume-session-at=${this.forkFrom.at}`, `--session-id=${this.engineSessionId}`);
    } else {
      args.push(this.resume ? `--resume=${this.engineSessionId}` : `--session-id=${this.engineSessionId}`);
    }
    return args;
  }

  async start() {
    if (this.#pipe) return;
    assertFolder(this);
    await checkVersion('claude', this.cmd, this.env, CLAUDE_MIN_VERSION, this.log);
    if (this.procId && this.procHost?.hasProc(this.procId)) {
      const pipe = this.procHost.procPipe(this.procId);
      if (pipe) {
        this.#hosted = true;
        this.#bindPipe(pipe, { adopted: true });
        return;
      }
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
      child.on('error', (err) => this.push('error', { message: `could not start ${this.cmd}: ${err.message}`, kind: 'spawn' }));
      pipe = this.#localPipe(child);
    }
    this.#bindPipe(pipe);
  }

  #write(obj) {
    if (!this.#pipe) throw new Error('claude is not running');
    this.#pipe.write(JSON.stringify(obj) + '\n');
    // The conversation exists on disk once it has a message, and not
    // before: a process restarted before then (a new effort, picked ahead
    // of the first message) must start the id again, because `--resume`
    // of an id with no transcript fails with "No conversation found".
    if (obj.type === 'user') this.resume = true;
  }

  #localPipe(child) {
    child.stderr.setEncoding('utf8');
    let tail = '';
    child.stderr.on('data', (d) => {
      tail = (tail + d).slice(-4000);
      if (process.env.HELM_DEBUG_DRIVER) process.stderr.write(d);
    });
    return {
      write: (d) => child.stdin.write(d),
      end: () => child.stdin.end(),
      kill: (s) => child.kill(s),
      onData: (cb) => child.stdout.on('data', (c) => cb(typeof c === 'string' ? c : c.toString('utf8'))),
      onExit: (cb) => child.on('exit', (code, signal) => cb({ code, signal, stderr: tail.trim().split('\n').pop() || null })),
      detach: () => {},
    };
  }

  #bindPipe(pipe, { adopted = false } = {}) {
    this.#pipe = pipe;
    let markReady;
    this.#ready = new Promise((r) => { markReady = r; });
    if (adopted) {
      this.resume = true;
      this.#turnId = this.openTurn?.() ?? null;
      this.#inTurn = !!this.#turnId;
      for (const e of this.pendingEvents?.() ?? []) this.pending.set(e.requestId, e);
      // A restart can land between a block's start and its next delta. Recover
      // those stream ids so the remaining text still appends to the same item.
      const agents = new Map();
      for (const e of this.resumeEvents?.() ?? []) {
        if (e.type === 'item.update' && e.agent?.id) this.#tasks.set(e.agent.id, e.id);
        if ((e.type === 'item.start' && nonAgentClaudeTask(e))
          || (e.type === 'item.update' && nonAgentClaudeTask(e.agent))) this.#nonAgentTasks.add(e.id);
        if (e.type === 'item.update' && e.agent?.status) agents.set(e.id, e.agent.status);
        if (e.type === 'item.update' && e.agent?.id && e.agent.status) {
          if (e.agent.status === 'running') this.#running.add(e.agent.id); else this.#running.delete(e.agent.id);
        }
        if (e.type !== 'item.start' || e.turnId !== this.#turnId || !['text', 'thinking'].includes(e.kind)) continue;
        const match = /^(.*)#(\d+)$/.exec(e.id);
        if (!match) continue;
        const scope = this.#scope(e.parentId);
        if (scope.messageId !== match[1]) scope.blocks.clear();
        scope.messageId = match[1];
        scope.blocks.set(Number(match[2]), e.id);
      }
      for (const [id, status] of agents) if (status === 'running' && !this.#nonAgentTasks.has(id)) {
        this.push('subagent.status', { id, status: [...this.pending.values()].some(p => p.parentId === id) ? 'blocked' : 'working' });
      }
      this.push('status', { status: this.pending.size ? 'blocked' : this.#turnId ? 'working' : 'idle' });
      markReady();
      this.emit('init', this.info ?? { model: this.model, effort: this.effort });
    } else {
      this.once('init', markReady);
    }
    void this.#initialize();
    this.#exited = new Promise((resolve) => {
      pipe.onExit(({ code, signal, stderr }) => {
        this.#pipe = null;
        this.#inTurn = false;
        // No process, no hook: a model picked now starts the next process.
        if (this.#modelSwitchSignal) this.#setModelSwitchSignal(false);
        for (const resolve of this.#controls.values()) {
          resolve({ subtype: 'error', error: 'Claude exited before confirming the setting change.' });
        }
        this.#controls.clear();
        // Messages handed over mid-turn that it never read die with it too.
        for (const input of this.#inputs.values()) this.push('input.failed', { ...input, error: 'Claude exited before reading this message.' });
        this.#inputs.clear();
        markReady();
        // A prompt the CLI was holding open dies with it; say so.
        for (const requestId of [...this.pending.keys()]) {
          this.push('permission.resolved', { requestId, decision: 'cancelled' });
        }
        if (code && code !== 0 && !this.killed) {
          this.push('error', { message: `claude exited with code ${code}${stderr ? `: ${stderr}` : ''}`, kind: 'exit' });
        }
        this.push('status', { status: 'exited' });
        resolve({ code, signal });
      });
    });
    let buf = '';
    pipe.onData((chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try { this.#onMessage(JSON.parse(line)); }
        catch { this.log(`claude: ${line.slice(0, 200)}`); }
      }
    });
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

  /**
   * Register Helm's hooks with this process. Sent again on adoption: a
   * process an older daemon started never had them, and registering twice
   * only replaces the list.
   */
  #initialize() {
    const request = this.#control({ subtype: 'initialize',
      hooks: { PreModelSwitch: [{ hookCallbackIds: [MODEL_SWITCH_HOOK] }] } });
    request.then((response) => {
      const on = response?.subtype === 'success' && atLeast(response.response?.claude_code_version, MODEL_SWITCH_SINCE);
      if (on !== this.#modelSwitchSignal) this.#setModelSwitchSignal(on);
    }, () => {});
    return request;
  }

  /**
   * Said through `init`, like the other things Claude reports. Before
   * Claude's own start-up message it waits for that message instead:
   * `init` is also what marks the process ready.
   */
  #setModelSwitchSignal(on) {
    this.#modelSwitchSignal = on;
    if (this.info) {
      this.info = { ...this.info, modelSwitchSignal: on };
      this.emit('init', this.info);
    }
  }

  // ----------------------------------------------------------------- verbs

  async send(text) {
    await this.start();
    this.#lastSent = text;
    this.#write({
      type: 'user', session_id: '', parent_tool_use_id: null, uuid: randomUUID(),
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
    // A message sent while a prompt is open is queued behind it; the agent
    // is still waiting on the person until that prompt is answered.
    if (!this.pending.size) this.push('status', { status: 'working' });
  }

  /**
   * A message for the turn already running. Claude reads its input between
   * steps, so this lands when the step in flight ends - what typing while
   * the CLI works does. The replay says when it was used.
   */
  async steer(text, attachments = [], { inputId } = {}) {
    if (!this.#pipe || !this.#inTurn) throw new Error('claude has no active turn to steer');
    const content = [];
    if (text) content.push({ type: 'text', text });
    // Labelled in order, so "[Image #2]" in the message names this one.
    let n = 0;
    for (const a of attachments ?? []) {
      if (!String(a?.mime ?? '').startsWith('image/') || !a?.data) continue;
      content.push({ type: 'text', text: `[Image #${++n}]` });
      content.push({ type: 'image', source: { type: 'base64', media_type: a.mime, data: a.data } });
    }
    if (!content.length) content.push({ type: 'text', text: '(empty message)' });
    // The replay names this uuid, which is how its read is matched to the
    // right waiting message even when two say the same thing.
    const uuid = randomUUID();
    this.#inputs.set(uuid, { text: resultText(content), inputId });
    try {
      this.#write({
        type: 'user', session_id: '', parent_tool_use_id: null, uuid,
        message: { role: 'user', content },
      });
    } catch (err) {
      this.#inputs.delete(uuid);
      throw err;
    }
  }

  async availableCommands() {
    await this.start();
    await this.#ready;
    return this.#commands;
  }

  /**
   * Text plus image blocks in one user message. Anything that is not an
   * image (or has no bytes) is skipped rather than sent as a placeholder
   * the model would try to read as words.
   */
  async sendWithAttachments(text, attachments) {
    await this.start();
    const content = [];
    if (text) content.push({ type: 'text', text });
    // Labelled in order, so "[Image #2]" in the message names this one.
    let n = 0;
    for (const a of attachments ?? []) {
      if (!String(a?.mime ?? '').startsWith('image/') || !a?.data) continue;
      content.push({ type: 'text', text: `[Image #${++n}]` });
      content.push({ type: 'image', source: { type: 'base64', media_type: a.mime, data: a.data } });
    }
    if (!content.length) return this.send('(empty message)');
    this.#lastSent = text ?? '';
    this.#write({
      type: 'user', session_id: '', parent_tool_use_id: null, uuid: randomUUID(),
      message: { role: 'user', content },
    });
    if (!this.pending.size) this.push('status', { status: 'working' });
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

  /** With `cancel_queued`, a message handed over mid-reply is dropped with the reply. */
  get dropsHandedOnInterrupt() { return this.#capabilities.has('interrupt_cancel_queued_v1'); }

  async interrupt() {
    if (!this.#pipe) return;
    this.#interrupting = true;
    await this.#control({ subtype: 'interrupt', cancel_queued: this.#capabilities.has('interrupt_cancel_queued_v1') });
  }

  /**
   * `ask`: the owner picked this in the app, which wants to confirm first
   * when Claude says the switch rewrites a warm cache worth mentioning. Then
   * Claude's hook cancels the switch and this returns `{ ask }` with
   * Claude's own figures; the app asks and sends the change again without
   * `ask`. Every other change goes ahead exactly as Claude would make it.
   */
  async setModel(model, { ask = false } = {}) {
    if (this.#pipe) {
      const switching = this.#switching = { ask, asked: null };
      let response;
      try { response = await this.#control({ subtype: 'set_model', model: model || null }); }
      finally { if (this.#switching === switching) this.#switching = null; }
      if (switching.asked && response?.error_code === 'blocked_by_hook') return { ask: switching.asked };
      if (response?.subtype !== 'success') {
        throw new Error(response?.error || 'Claude did not confirm the model change. The previous model is still selected; try again.');
      }
    }
    this.model = model || null;
    return {};
  }

  /** Whether a model switch now would be priced by Claude itself. */
  get modelSwitchSignal() { return this.#modelSwitchSignal && !!this.#pipe; }

  async setMode(id) {
    this.mode = id;
    const mode = modeFor('claude', id);
    // A mode change can happen while the owner is already looking at a
    // permission card. Settle those requests under the new policy now; don't
    // leave a stale card open after choosing Auto or Bypass.
    const decision = automaticDecision(id, 'permission');
    if (decision) {
      for (const [requestId, pending] of [...this.pending]) {
        if (pending.kind !== 'question') await this.answer(requestId, decision);
      }
    }
    if (this.#pipe && mode) {
      this.#control({ subtype: 'set_permission_mode', mode: mode.cli === 'manual' ? 'default' : mode.cli })
        .then((response) => {
          if (response?.subtype !== 'success') this.log(`claude: could not switch permission mode to ${mode.cli}`);
        })
        .catch((err) => this.log(`claude: could not switch permission mode to ${mode.cli}: ${err.message}`));
    }
  }

  /** Claude's live /effort setting, with the same acknowledgment as /model. */
  async setEffort(effort) {
    const value = effort === 'auto' ? null : effort || null;
    if (value && !['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'].includes(value)) {
      throw new Error('invalid Claude thinking effort');
    }
    if (this.#pipe) {
      const response = await this.#control({ subtype: 'apply_flag_settings', settings: { effortLevel: value } });
      if (response?.subtype !== 'success') {
        throw new Error(response?.error || 'Claude did not confirm the effort change. The previous effort is still selected; try again.');
      }
    }
    this.effort = value;
    if (this.info) this.info = { ...this.info, effort: value };
  }

  async kill() {
    this.killed = true;
    const pipe = this.#pipe;
    if (!pipe) return;
    // A prompt left unanswered blocks the CLI forever; close them out first.
    for (const requestId of [...this.pending.keys()]) {
      try { await this.answer(requestId, { option: 'deny', message: 'The session was ended.' }); } catch { /* already gone */ }
    }
    try { pipe.end(); } catch { /* closed */ }
    const done = await Promise.race([this.#exited, new Promise((r) => setTimeout(() => r(null), 3000))]);
    if (!done) pipe.kill('SIGTERM');
    const done2 = await Promise.race([this.#exited, new Promise((r) => setTimeout(() => r(null), 2000))]);
    if (!done2) pipe.kill('SIGKILL');
    await this.#exited;
  }

  /** Keep a hosted Claude process alive while this daemon is being replaced. */
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
    // A command Claude answers itself replies with a made-up assistant
    // message and no stream. It is not work the CLI started by itself.
    if (m.type === 'assistant' && !m.parent_tool_use_id && !m.error && m.message?.model === '<synthetic>' && !this.#inTurn) {
      const text = resultText(m.message?.content).trim();
      if (text) this.#commandOutput.push(text);
      return;
    }
    // Work the CLI starts by itself - a background task or a Monitor it set
    // up finishing - arrives with no message from us. It is a turn of its
    // own: folded into the last one, every wake-up closed that turn again and
    // a delegated task reported "finished" once per wake-up.
    if (!this.#inTurn && this.#pipe && WAKE_TYPES.has(m.type) && !(m.type === 'user' && m.isReplay)) this.#wake(m);
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
      case 'stream_event': return this.#onStreamEvent(m.event, m.parent_tool_use_id);
      case 'assistant': return this.#onAssistant(m, m.parent_tool_use_id);
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
      this.#commands = (m.slash_commands ?? [])
        .filter((name) => typeof name === 'string' && name)
        .map((name) => ({ name, source: 'Claude' }));
      // Whether a thinking-level change keeps the prompt cache is Claude's to
      // say: true when it sends effort inside the conversation, false when a
      // change rewrites the cached prefix, absent when it does not know.
      this.info = { model: m.model, permissionMode: m.permissionMode, version: m.claude_code_version, effort: m.effort,
        effortKeepsCache: typeof m.per_turn_effort_active === 'boolean' ? m.per_turn_effort_active : null,
        modelSwitchSignal: this.#modelSwitchSignal };
      this.emit('init', this.info);
      return;
    }
    // Claude stopped sending effort per turn (the server refused it): from
    // now on a thinking-level change does rewrite the cache.
    if (m.subtype === 'per_turn_effort_changed') {
      this.info = { ...(this.info ?? { model: this.model, effort: this.effort }), effortKeepsCache: m.per_turn_effort_active === true };
      this.emit('init', this.info);
      return;
    }
    // Compacting: `status: 'compacting'` (repeated while it runs), then a
    // status without it, and a boundary once the summary is in place.
    if (m.subtype === 'status') {
      if (m.status === 'compacting') {
        this.compactionStarted(this.#inTurn ? this.#turnId : null);
        if (!this.pending.size) this.push('status', { status: 'working' });
      } else if (this.compacting) {
        const failed = m.compact_result === 'failed' || !!m.compact_error;
        this.compactionEnded(failed ? 'error' : 'ok', m.compact_error);
      }
      return;
    }
    if (m.subtype === 'compact_boundary') {
      // The ring drops to the summary's size now, not after the next reply:
      // Claude says what is left in `post_tokens`.
      const meta = m.compact_metadata ?? m.compactMetadata ?? {};
      const post = Number(meta.post_tokens ?? meta.postTokens);
      if (post > 0) { this.#contextUsed = post; this.#pushContext(); }
      else if (this.#contextWindow) { this.#contextUsed = null; this.push('context', { used: 0, window: this.#contextWindow, compacted: true }); }
      return this.compactionEnded('ok');
    }
    // Task lifecycle frames. `tool_use_id` is the spawn card; `task_id` is
    // what progress and completion frames key off.
    if (m.subtype === 'task_started') {
      if (m.task_id && m.tool_use_id) this.#tasks.set(m.task_id, m.tool_use_id);
      if (m.task_id) this.#running.add(m.task_id);
      if (m.tool_use_id) {
        const service = this.#nonAgentTasks.has(m.tool_use_id)
          || nonAgentClaudeTask({ type: m.task_type, ambient: m.ambient, skipTranscript: m.skip_transcript });
        if (service) this.#nonAgentTasks.add(m.tool_use_id);
        else this.push('subagent.status', { id: m.tool_use_id, status: 'working' });
        this.push('item.update', { id: m.tool_use_id, agent: { id: m.task_id, status: 'running', description: m.description,
          ...(m.task_type ? { type: m.task_type } : {}), ...(m.ambient ? { ambient: true } : {}),
          ...(m.skip_transcript ? { skipTranscript: true } : {}) } });
      }
      return;
    }
    if (m.subtype === 'task_progress' || m.subtype === 'task_updated') {
      const id = this.#tasks.get(m.task_id) ?? m.tool_use_id;
      if (id) {
        if (!this.#nonAgentTasks.has(id)) this.push('subagent.status', { id, status: 'working' });
        this.push('item.update', {
          id,
          agent: {
            id: m.task_id, status: 'running', description: m.description,
            lastTool: m.last_tool_name, toolUses: m.usage?.tool_uses, tokens: m.usage?.total_tokens,
          },
        });
      }
      return;
    }
    if (m.subtype === 'task_notification') {
      if (['completed', 'failed', 'stopped'].includes(m.status)) this.#running.delete(m.task_id);
      const id = this.#tasks.get(m.task_id) ?? m.tool_use_id;
      if (!id) return;
      if (nonAgentClaudeTask({ type: m.task_type, summary: m.summary })) this.#nonAgentTasks.add(id);
      const status = m.status === 'failed' ? 'error' : m.status === 'stopped' ? 'declined' : 'ok';
      this.push('item.update', { id, agent: { id: m.task_id, status: m.status, summary: m.summary,
        ...(this.#nonAgentTasks.has(id) ? { type: m.task_type || 'local_bash' } : {}) } });
      // Terminal: the card is done. A foreground Task's tool_result lands
      // too and overwrites this with the agent's own report.
      if (['completed', 'failed', 'stopped'].includes(m.status)) {
        if (!this.#nonAgentTasks.has(id)) this.push('subagent.status', { id, status: m.status === 'failed' ? 'error' : 'idle' });
        this.push('item.done', { id, status, output: clip(m.summary) });
      }
    }
  }

  /** A held command answer, as the open turn's reply. */
  #flushCommandOutput() {
    const text = this.#commandOutput.join('\n\n');
    this.#commandOutput = [];
    if (!text || !this.#inTurn) return;
    const id = `${this.#turnId}#answer`;
    this.push('item.start', { id, turnId: this.#turnId, kind: 'text' });
    this.push('item.delta', { id, text });
    this.push('item.done', { id, status: 'ok' });
  }

  /** An answer complete on arrival, beside whatever else is going on. */
  #commandCard(id, body) {
    const turnId = `command-${id}`;
    const itemId = `command-result-${id}`;
    this.push('turn.start', { turnId, text: '', local: true });
    this.push('item.start', { id: itemId, turnId, kind: 'text' });
    this.push('item.delta', { id: itemId, text: body });
    this.push('item.done', { id: itemId, status: 'ok' });
    this.push('turn.done', { turnId, status: 'ok' });
  }

  #wake(m) {
    this.#turnId = `wake-${m.uuid ?? randomUUID()}`;
    this.#inTurn = true;
    this.push('turn.start', { turnId: this.#turnId, text: '', wake: true });
    // The last turn said idle. Without this the chat reads "done" for the
    // whole wake-up while Claude runs tools.
    if (!this.pending.size) this.push('status', { status: 'working' });
  }

  #onUser(m) {
    if (m.isReplay) {
      // A subagent's own prompt is not one of the owner's messages.
      if (m.parent_tool_use_id) return;
      let text = resultText(m.message?.content);
      const record = localCommandRecord(text);
      if (record?.kind === 'note') return;
      if (record?.kind === 'output') {
        // What the command printed. Mid-turn it is noise; between turns it
        // is a quiet answer card, never a message and never a turn the next
        // real message gets folded into.
        if (!this.#inTurn && record.text) this.#commandCard(m.uuid ?? randomUUID(), record.text);
        return;
      }
      // Claude echoes some commands under another name (/cost as /usage).
      // The words the owner sent are the ones their message is matched by.
      if (record?.kind === 'command') text = !this.#inTurn && this.#lastSent.trim().startsWith('/') ? this.#lastSent.trim() : record.text;
      const input = this.#inputs.get(m.uuid);
      if (input) this.#inputs.delete(m.uuid);
      // A message written while a turn runs is read at the end of the step
      // in flight and joins that turn - the turn keeps its id. A replay
      // under a uuid helm never wrote is not one of its waiting messages.
      if (this.#inTurn) {
        if (input) this.push('input.consumed', input);
        else if (!m.uuid) this.push('input.consumed', { text });
        return;
      }
      // The CLI accepted our message; this uuid is the turn. A steer that
      // arrived after the turn ended runs as this one, under its ticket.
      this.#turnId = m.uuid;
      this.#inTurn = true;
      this.#lastSent = '';
      this.push('turn.start', { turnId: m.uuid, text, ...(input?.inputId ? { inputId: input.inputId } : {}) });
      this.#flushCommandOutput();
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

  #scope(parentId) {
    const key = parentId ?? '';
    let s = this.#scopes.get(key);
    if (!s) { s = { messageId: null, blocks: new Map() }; this.#scopes.set(key, s); }
    return s;
  }

  #onStreamEvent(e, parentId) {
    const scope = this.#scope(parentId);
    switch (e?.type) {
      case 'message_start':
        scope.messageId = e.message?.id ?? randomUUID();
        return;
      case 'content_block_start': {
        const b = e.content_block;
        if (b.type === 'tool_use') {
          scope.blocks.set(e.index, b.id);
          if (nonAgentClaudeTask(b)) this.#nonAgentTasks.add(b.id);
          // Task spawns a subagent: the card is the child, and what it runs
          // arrives tagged with this block's id as their parent.
          const kind = b.name === 'Task' || b.name === 'Agent' ? 'subagent' : 'tool';
          this.push('item.start', { id: b.id, kind, turnId: this.#turnId, name: b.name, input: b.input ?? {}, parentId: parentId ?? undefined });
        } else if (b.type === 'text' || b.type === 'thinking') {
          const id = `${scope.messageId}#${e.index}`;
          scope.blocks.set(e.index, id);
          this.push('item.start', { id, kind: b.type, turnId: this.#turnId, parentId: parentId ?? undefined });
        }
        return;
      }
      case 'content_block_delta': {
        const id = scope.blocks.get(e.index);
        if (!id) return;
        const d = e.delta;
        if (d.type === 'text_delta' && d.text) this.push('item.delta', { id, text: d.text });
        else if (d.type === 'thinking_delta' && d.thinking) this.push('item.delta', { id, text: d.thinking });
        else if (d.type === 'input_json_delta' && d.partial_json) this.push('item.delta', { id, text: d.partial_json });
        return;
      }
      case 'content_block_stop': {
        const id = scope.blocks.get(e.index);
        if (id && !id.startsWith('toolu_')) this.push('item.done', { id, status: 'ok' });
        return;
      }
      default: return;
    }
  }

  #onAssistant(m, parentId) {
    if (!parentId && m.uuid) this.#lastAssistant = m.uuid;
    // The result's usage adds up the whole turn. What the conversation weighs
    // is the latest top-level reply: all it read, plus what it wrote.
    const u = m.message?.usage;
    if (!parentId && u && m.message.model !== '<synthetic>') {
      this.#contextUsed = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
        + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
      this.#contextModel = m.message.model;
      this.#pushContext();
    }
    if (m.error) this.push('error', { message: resultText(m.message?.content) || m.error, kind: m.error });
    for (const block of m.message?.content ?? []) {
      if (block.type === 'tool_use') {
        if (nonAgentClaudeTask(block)) this.#nonAgentTasks.add(block.id);
        // A sidechain tool_use may never have streamed as a content_block;
        // item.start is deduped downstream, so announce it defensively.
        if (parentId) {
          this.push('item.start', {
            id: block.id, kind: block.name === 'Task' || block.name === 'Agent' ? 'subagent' : 'tool',
            turnId: this.#turnId, name: block.name, input: block.input, parentId,
          });
        }
        // The complete input, after the partial JSON that streamed in.
        this.push('item.update', { id: block.id, input: block.input });
      }
    }
  }

  /** Tell the thread how full its context is, once the size is known. */
  #pushContext() {
    if (this.#contextUsed && this.#contextWindow) this.push('context', { used: this.#contextUsed, window: this.#contextWindow, full: this.#contextFull, model: bareModel(this.#contextModel ?? '') || undefined });
  }

  /**
   * The size Claude counts the conversation against. A smaller compaction
   * window in the account's settings is what its own /context shows, so it
   * wins over the model's full window. This is only the first answer: Claude
   * then says its window itself (`#askWindow`), which also counts settings
   * this does not read - project and managed settings, its environment.
   */
  #windowFrom(m) {
    // A helper on another model is listed too; ours is the one that replied.
    const used = Object.entries(m.modelUsage ?? {}).filter(([, v]) => v?.contextWindow);
    const [model, usage] = used.find(([id]) => this.#contextModel && bareModel(id) === bareModel(this.#contextModel)) ?? used[0] ?? [];
    if (!usage) return;
    this.#contextWindow = this.#contextFull = usage.contextWindow;
    // Read again whenever the file changed, so a new size chosen in the app
    // applies from this reply on.
    const compact = compactWindow(configDir(this.env), model);
    if (compact > 0 && compact < this.#contextWindow) this.#contextWindow = compact;
  }

  /**
   * Claude's own word on the window, from the same count its /context shows
   * (`get_context_usage`, the summary that makes no API call). `maxTokens`
   * is the size it compacts against, wherever that size was set. A Claude
   * that does not know the request leaves the settings read standing.
   */
  #askWindow() {
    if (!this.#contextUsed) return;
    this.#control({ subtype: 'get_context_usage', detail: 'summary' }).then((r) => {
      const max = r?.subtype === 'success' ? Number(r.response?.maxTokens) : 0;
      if (!(max > 0) || max === this.#contextWindow) return;
      this.#contextWindow = max;
      if (!(this.#contextFull >= max)) this.#contextFull = max;
      this.#pushContext();
    }, () => {});
  }

  #onResult(m) {
    this.#windowFrom(m);
    this.#pushContext();
    this.#askWindow();
    if (this.compacting) this.compactionEnded(m.is_error ? 'error' : 'ok');
    // A command answered with no echo ("/status isn't available here"):
    // its answer opens the turn under the words that asked for it.
    if (this.#commandOutput.length && !this.#inTurn) {
      this.#turnId = `command-${m.uuid ?? randomUUID()}`;
      this.#inTurn = true;
      this.push('turn.start', { turnId: this.#turnId, text: this.#lastSent });
      this.#lastSent = '';
    }
    this.#flushCommandOutput();
    // A result outside any turn closes nothing that is open. A failure still
    // says so - the CLI can refuse a message before it echoes it - but with no
    // turn id, never the last turn's again; a success is that turn's repeated.
    if (!this.#inTurn && this.#turnId && !m.is_error) return;
    const turnId = this.#inTurn ? this.#turnId : null;
    this.#inTurn = false;
    const interrupted = this.#interrupting && m.is_error;
    this.#interrupting = false;
    // From here the thread stands on its own; a restart resumes it as usual.
    this.forkFrom = null;
    this.push('turn.done', {
      turnId,
      // Where a branch could be cut so that it holds everything up to and
      // including this turn's answer.
      resumeAt: this.#lastAssistant ?? undefined,
      status: interrupted ? 'interrupted' : m.is_error ? 'error' : 'ok',
      // A running total for the conversation, not this turn's cost - the
      // CLI says to read the latest rather than sum them. Sessions turns it
      // back into a per-turn figure against the last total it saw.
      costTotalUsd: m.total_cost_usd,
      usage: m.usage && { input: m.usage.input_tokens, output: m.usage.output_tokens, cacheRead: m.usage.cache_read_input_tokens, cacheWrite: m.usage.cache_creation_input_tokens, inputIncludesCache: false },
      durationMs: m.duration_ms,
      error: m.is_error && !interrupted ? (m.errors?.join('; ') || m.result || m.subtype) : undefined,
    });
    this.push('status', { status: 'idle' });
  }

  /**
   * Claude's PreModelSwitch hook. Only a switch the owner picked in the app,
   * with a warm cache big enough to be worth a question, is held back; its
   * figures go to the app. Anything else - a cold cache, a small one, a
   * confirmed pick, `/model` typed in the chat - goes on as Claude decides.
   */
  #onModelSwitch(requestId, input) {
    const switching = this.#switching;
    const tokens = Number(input.context_tokens);
    let response = {};
    if (switching?.ask && input.prompt_cache_warm === true && tokens >= WORTH_SAYING) {
      const usd = Number(input.estimated_cache_write_usd);
      switching.asked = { tokens, costUsd: Number.isFinite(usd) ? usd : null,
        ...(typeof input.cache_ttl === 'string' && { ttl: input.cache_ttl }) };
      response = { hookSpecificOutput: { hookEventName: 'PreModelSwitch', permissionDecision: 'deny',
        permissionDecisionReason: 'Helm is asking the owner first: this switch rewrites a warm prompt cache.' } };
    }
    this.#write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  }

  #onControlRequest(m) {
    const r = m.request;
    if (r?.subtype === 'hook_callback' && r.callback_id === MODEL_SWITCH_HOOK) return this.#onModelSwitch(m.request_id, r.input ?? {});
    if (r?.subtype !== 'can_use_tool') {
      this.log(`claude: unanswered control request ${r?.subtype}`);
      return;
    }
    const tool = r.tool_name;
    const input = r.input ?? {};
    if (tool === 'EnterPlanMode' || tool === 'ExitPlanMode') {
      this.#write({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id,
        response: { behavior: 'deny', message: 'Plan mode is disabled in Helm. Execute the assigned task directly; do not request plan approval.' } } });
      return;
    }
    const kind = permissionKind(tool);

    // `auto` lets Claude's safety classifier make the call. If Claude still
    // sends a permission request here, don't turn that safety stop into a
    // phone notification: deny it and let the model continue safely. The
    // explicit bypass mode does the opposite. AskUserQuestion is a real
    // conversation with the owner, not a permission check, so it stays
    // interactive in both modes.
    const decision = automaticDecision(this.mode, kind);
    if (decision) {
      this.#write({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: m.request_id,
          response: decision.option === 'allow'
            ? { behavior: 'allow' }
            : { behavior: 'deny', message: decision.message },
        },
      });
      return;
    }

    this.push('status', { status: 'blocked' });
    this.push('permission.request', {
      requestId: m.request_id,
      itemId: r.tool_use_id,
      parentId: m.parent_tool_use_id ?? r.parent_tool_use_id ?? undefined,
      ...permissionCard(tool, input, r),
    });
  }


}

/** What kind of card a tool's permission request is. */
export const permissionKind = (tool) => tool === 'AskUserQuestion' ? 'question'
  : tool === 'ExitPlanMode' ? 'plan'
  : tool === 'Bash' ? 'command'
  : EDIT_TOOLS.has(tool) ? 'edit' : 'tool';

function alwaysLabel(suggestions, tool) {
  const s = suggestions[0];
  if (s?.type === 'setMode' && s.mode === 'acceptEdits') return 'Allow all edits this session';
  if (s?.type === 'addRules') {
    const rule = s.rules?.[0]?.ruleContent;
    return rule ? `Always allow ${tool}(${rule.length > 24 ? rule.slice(0, 24) + '…' : rule})` : `Always allow ${tool}`;
  }
  return 'Always allow';
}

function editDetail(tool, input) {
  if (tool === 'Write') return { path: input.file_path, content: clip(input.content, 20_000) };
  if (tool === 'Edit') return { path: input.file_path, old: clip(input.old_string, 10_000), new: clip(input.new_string, 10_000), all: !!input.replace_all };
  if (tool === 'MultiEdit') return { path: input.file_path, edits: (input.edits ?? []).slice(0, 20).map((e) => ({ old: clip(e.old_string, 4000), new: clip(e.new_string, 4000) })) };
  return { path: input.notebook_path ?? input.file_path, content: clip(input.new_source, 10_000) };
}

/**
 * The card for one permission request, from what Claude says about it -
 * the same whether it came over `claude -p`'s control channel or from a
 * terminal Claude's PermissionRequest hook. `r` carries the extras only the
 * control channel has (title, description, reason, defaults).
 */
export function permissionCard(tool, input = {}, r = {}) {
  const kind = permissionKind(tool);
  const title = stripAnsi(r.title) || (
    kind === 'command' ? 'Run a command'
    : kind === 'edit' ? `${tool === 'Write' ? 'Write' : 'Edit'} ${r.description || input.file_path?.split('/').pop() || 'a file'}`
    : kind === 'question' ? 'Claude has a question'
    : kind === 'plan' ? 'Claude has a plan'
    : tool === 'Task' ? `Spawn a subagent${input.subagent_type ? ` (${input.subagent_type})` : ''}`
    : `${r.display_name || tool}${r.description ? ` · ${r.description}` : ''}`);
  const detail = kind === 'command' ? input.command
    : kind === 'plan' ? input.plan
    : kind === 'edit' ? editDetail(tool, input)
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
      options.push({ id: 'always', role: 'allow-always', label: alwaysLabel(r.permission_suggestions, tool) });
    }
    options.push({ id: 'deny', role: 'deny', label: 'Deny' });
  }
  return {
    kind, tool, title,
    detail: stripAnsi(detail),
    reason: stripAnsi(r.decision_reason) || undefined,
    input: kind === 'question' || kind === 'plan' ? undefined : input,
    questions: kind === 'question' ? input.questions : undefined,
    options,
    defaultTo: r.default_to_no ? 'deny' : 'allow',
    allowEdit: kind === 'command' || kind === 'plan',
    raw: { input, permission_suggestions: r.permission_suggestions },
  };
}
