import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Driver, checkVersion, assertFolder } from './index.js';
import { modeFor } from '../modes.js';

/**
 * Antigravity, headless: `agy --input-format stream-json --output-format
 * stream-json` - a persistent NDJSON session, not ACP.
 *
 * stdin takes one message per line, `{event:"user", message:{content}}`, and
 * each produces a turn's worth of `step_update` events closed by a `result`:
 *
 *   {"event":"init","conversation_id":"…","init":{"cwd":…,"tools":[…],"permission_mode":"…"}}
 *   {"event":"step_update","step_update":{"step_index":3,"state":"ACTIVE","step_type":"agent_response","text_delta":"…"}}
 *   {"event":"result","result":{"status":"SUCCESS","response":"…","conversation_id":"…","usage":{…}}}
 *
 * Verified against agy 1.2.12 and the published headless docs:
 *  - No `-p` flag: in stream mode it is ignored, and worse it swallows the
 *    next argument as its prompt value.
 *  - Only `text` content blocks exist; images are a session-ending error, so
 *    this driver deliberately has no attachment verbs.
 *  - Slash commands handled by the CLI itself (/model, /usage) also end the
 *    session, so spawn passes --disable-slash-commands: typed "/x" reaches
 *    the model as text instead of killing the process.
 *  - `result.usage` counters are cumulative for the whole conversation, so
 *    per-turn usage is the delta from the previous result.
 *  - There is no mid-turn cancel: an unrecognized input event is skipped,
 *    anything control-shaped ends the session. interrupt() writes the
 *    forward-compatible `interrupt` event, gives it a moment, then stops the
 *    process - the next prompt respawns on the same --conversation id, which
 *    is also how model/effort/mode changes take effect mid-session.
 *  - An account that fails the eligibility check emits an ERROR `result`
 *    before any input arrives; surfaced as an init error, not a turn.
 *
 * Conversation steps are protobuf blobs in conversations/<id>.db, so there is
 * no transcript reader - inventory lists past conversations, and continuing
 * one runs through --conversation.
 */

const AGY_MIN_VERSION = '1.2.0';
/** A turn this driver opened - a prompt, or work the agent began itself - as opposed to one of helm's own queue tickets. */
const isDriverTurn = (turnId) => /^(turn|wake)-/.test(String(turnId));
const MAX_OUTPUT = 32_000;
const clip = (s, n = MAX_OUTPUT) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s);

/** step_type values that are streamed text versus tool-ish work. */
const TEXT_KIND = { agent_response: 'text', thinking: 'thinking', thought: 'thinking', thought_summary: 'thinking' };
const USAGE = (u) => u && ({
  input: u.input_tokens ?? u.inputTokens ?? u.input ?? 0,
  output: u.output_tokens ?? u.outputTokens ?? u.output ?? 0,
  cacheRead: u.cache_read_tokens ?? u.cacheReadTokens ?? u.cacheRead ?? 0,
});

export class AgyDriver extends Driver {
  #pipe = null;
  #hosted = false;
  #exited = null;
  /** prompts written, awaiting their result event */
  #turnQueue = [];
  /** {turnId, text} accepted but not yet written - one turn in flight at a time */
  #outbox = [];
  /** step_index -> {id, kind} of the currently open streamed item */
  #open = new Map();
  /** text actually streamed this turn - the result's response is a fallback */
  #streamed = false;
  /** last usage seen on a step, a fallback when the result lacks it */
  #stepUsage = null;
  /** cumulative usage snapshot at the previous result, for per-turn deltas */
  #prevUsage = null;
  #interrupting = false;
  /** process is gone; the next send respawns on --conversation */
  #dead = true;
  #spawning = null;
  /** model/effort/mode changed while a turn ran - restart after it settles */
  #wantRespawn = false;
  /** a deliberate settings restart is in flight - not a session exit */
  #restarting = false;
  /** the in-flight restart, so a send can wait for the fresh process */
  #restartJob = null;
  /** resolves start() once the CLI has said hello (or refused to) */
  #initWait = null;
  /** the refusal the CLI gave at start-up, so a stranded turn can say why */
  #initError = null;
  /** the highest step index seen: a step beyond it, with no prompt behind it, is new work */
  #lastStep = -1;

  constructor(opts) {
    super({ engine: 'agy', ...opts });
  }

  get args() {
    const a = [
      ...this.profileArgs,
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      // A slash command the CLI answers itself (/model, /usage) ends the
      // stream session outright; with expansion off it is ordinary text.
      '--disable-slash-commands',
    ];
    if (this.model) a.push('--model', this.model);
    if (this.effort) a.push('--effort', this.effort);
    const mode = modeFor('agy', this.mode);
    if (mode?.agyMode) a.push('--mode', mode.agyMode);
    if (mode?.skipPermissions) a.push('--dangerously-skip-permissions');
    if (this.engineSessionId) a.push('--conversation', this.engineSessionId);
    return a;
  }

  async start() {
    // The spawn binds the pipe before agy has said hello; a second caller
    // in that window waits for the same start instead of writing to a
    // process whose conversation id is not known yet.
    if (this.#spawning) return this.#spawning;
    if (this.#pipe && !this.#dead) return;
    this.#spawning = this.#spawn().finally(() => { this.#spawning = null; });
    return this.#spawning;
  }

  async #spawn() {
    if (this.#pipe && !this.#dead) return;
    assertFolder(this);
    await checkVersion(this.engine, this.cmd, this.env, AGY_MIN_VERSION, this.log);

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
        this.log(`agy: no proc host (${e.message}); running under the daemon`);
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
    this.#dead = false;
    this.#initError = null;
    const ready = new Promise((res) => { this.#initWait = res; });
    this.#bindPipe(pipe);
    this.emit('init', this.info = { model: this.model, effort: this.effort });
    // agy opens the stream with `init`; an account the provider refuses gets
    // an ERROR result and exit instead. "Started" means the CLI answered one
    // or the other - otherwise sessions reads an engineSessionId that has
    // not been bound yet.
    const timer = setTimeout(() => this.#initWait?.(), 30_000);
    timer.unref?.();
    await Promise.race([ready, this.#exited]);
    clearTimeout(timer);
    this.#initWait = null;
    this.#pump();
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
        this.#dead = true;
        // The stream died mid-turn: the live prompt is interrupted (helm
        // asked) or failed (agy ended it); queued prompts stay queued - the
        // conversation id survives, so the next pump respawns onto it.
        const turnId = this.#turnQueue.shift();
        if (turnId) {
          const status = this.#interrupting ? 'interrupted' : 'error';
          const error = this.#interrupting
            ? undefined
            : (this.#initError ?? `${this.engine} exited${stderr ? `: ${stderr}` : ''}`);
          if (error) this.push('error', { message: error, kind: 'exit' });
          this.#settleTurn(turnId, status, error);
        }
        this.#interrupting = false;
        for (const id of this.#open.values()) this.push('item.done', { id, status: 'error' });
        this.#open.clear();
        if (!this.#restarting) this.push('status', { status: 'exited' });
        resolve({ code });
        this.#pump();
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
          if (process.env.HELM_DEBUG_DRIVER) this.log(`agy <- ${line.slice(0, 300)}`);
          this.#onEvent(m);
        } catch { this.log(`agy: ${line.slice(0, 200)}`); }
      }
    });
  }

  /**
   * Rebind a process the host kept across a restart. Any open turn is still
   * open in the event log's view; the rest re-queues.
   */
  #adoptPipe(pipe) {
    this.#hosted = true;
    this.#dead = false;
    this.#bindPipe(pipe);
    const open = this.openTurn?.() ?? null;
    if (open && !isDriverTurn(open)) {
      // helm's own ticket, never echoed: send() echoes before the prompt is
      // queued for writing, so this one never reached agy. Close it as
      // undelivered rather than adopt a turn agy knows nothing about.
      this.push('turn.done', { turnId: open, status: 'interrupted', error: 'helm restarted before this message reached the agent' });
    }
    if (open && isDriverTurn(open)) this.#turnQueue = [open];
    this.emit('init', this.info ?? { model: this.model, effort: this.effort });
    // agy has no state to ask for; what the log holds open is the state.
    // A turn still open is running - its result is replayed or still to
    // come - and with none, agy is waiting for input whatever the record
    // remembered.
    this.push('status', { status: this.#turnQueue.length ? 'working' : 'idle' });
  }

  #write(obj) {
    if (!this.#pipe || this.#dead) return false;
    try { this.#pipe.write(JSON.stringify(obj) + '\n'); return true; }
    catch { return false; }
  }

  /** Write the next queued prompt, spawning first if the process is down. */
  async #pump() {
    if (this.#dead) {
      if (!this.#outbox.length || this.#spawning) return;
      try {
        await this.start();
      } catch (e) {
        const { turnId } = this.#outbox.shift() ?? {};
        if (turnId) this.#settleTurn(turnId, 'error', e.message);
        return;
      }
      if (this.#dead) return;
    }
    if (!this.#pipe || this.#turnQueue.length || !this.#outbox.length) return;
    const { turnId, text } = this.#outbox.shift();
    this.#turnQueue.push(turnId);
    this.#streamed = false;
    if (!this.#write({ event: 'user', message: { content: text } })) {
      // Could not write; keep the turn queued for the respawned process.
      this.#turnQueue.pop();
      this.#outbox.unshift({ turnId, text });
      this.#dead = true;
      await this.start();
      return this.#pump();
    }
  }

  // ----------------------------------------------------------------- verbs

  async send(text) {
    // Starting agy is part of answering: working from the spawn on, and
    // back to idle if it never comes up.
    if (this.#dead || this.#spawning) this.push('status', { status: 'working' });
    try {
      await this.start();
    } catch (err) {
      if (!this.#turnQueue.length && !this.#outbox.length && !this.pending.size) this.push('status', { status: 'idle' });
      throw err;
    }
    // A settings restart may still be swapping the process underneath - the
    // prompt belongs on the fresh one, not the one being torn down.
    if (this.#restartJob) await this.#restartJob;
    const turnId = `turn-${randomUUID().slice(0, 8)}`;
    this.#outbox.push({ turnId, text });
    this.push('turn.start', { turnId, text });
    this.push('status', { status: 'working' });
    await this.#pump();
  }

  /**
   * agy has no mid-turn abort. The `interrupt` event is skipped harmlessly by
   * older builds and may be honoured by newer ones; after a beat, the process
   * is stopped instead - --conversation makes the next prompt a continuation,
   * so nothing typed before is lost.
   */
  async interrupt() {
    if (!this.#pipe || this.#dead || !this.#turnQueue.length) return;
    this.#interrupting = true;
    this.#write({ event: 'interrupt' });
    setTimeout(() => {
      if (this.#interrupting && this.#pipe && !this.#dead && this.#turnQueue.length) {
        try { this.#pipe.end(); } catch { /* closed */ }
        this.#pipe?.kill?.('SIGTERM');
      }
    }, 1500).unref?.();
  }

  async answer() {
    throw new Error('agy has no interactive permission protocol in stream-json mode');
  }

  /**
   * Settings live on argv, so changing one mid-session means a restart on the
   * same conversation. With a turn in flight it lands when the turn settles.
   */
  async setModel(model) {
    this.model = model || null;
    this.#restartForArgs();
  }

  async setEffort(effort) {
    this.effort = effort || null;
    this.#restartForArgs();
  }

  async setMode(id) {
    this.mode = id;
    this.#restartForArgs();
  }

  #restartForArgs() {
    if (this.#dead) return; // next spawn already builds fresh args
    if (this.#turnQueue.length) { this.#wantRespawn = true; return; }
    this.#restartJob ??= this.#restart().finally(() => { this.#restartJob = null; });
    this.#restartJob.catch((e) => this.push('error', { message: e.message, kind: 'spawn' }));
  }

  async #restart() {
    const pipe = this.#pipe;
    this.#wantRespawn = false;
    this.#restarting = true;
    try {
      if (pipe) {
        try { pipe.end(); } catch { /* closed */ }
        pipe.kill?.('SIGTERM');
        await Promise.race([this.#exited, new Promise((r) => setTimeout(r, 2000))]);
      }
      await this.start();
    } finally {
      this.#restarting = false;
    }
  }

  /**
   * Slash commands do not exist over stream-json (/compact would end the
   * session), and there is no context-window compaction verb to call.
   */
  async compact() {
    this.push('error', { message: 'agy has no compaction over stream-json; continuing the conversation is the only shrink', kind: 'settings' });
  }

  async availableCommands() { return []; }

  catalog() { return null; }

  async kill() {
    this.killed = true;
    const pipe = this.#pipe;
    if (!pipe || this.#dead) return;
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

  #onEvent(m) {
    const event = m.event ?? m.type;
    const payload = m[event] ?? m;
    switch (event) {
      case 'init': {
        const id = payload?.conversation_id ?? m.conversation_id;
        if (id) this.engineSessionId = id;
        this.#initWait?.();
        return;
      }
      case 'step_update':
        return this.#onStep(payload ?? {});
      case 'result':
        // A result before init is the refusal answer start() is waiting on.
        this.#initWait?.();
        return this.#onResult(payload ?? {});
      default:
        // interaction.* / step.* internals, warnings - not the print stream.
        return;
    }
  }

  #onStep(s) {
    const index = s.step_index ?? s.index ?? 0;
    const type = s.step_type ?? s.type ?? '';
    const done = (s.state ?? '').toUpperCase() === 'DONE' || s.state === 'done';
    if (s.usage) this.#stepUsage = s.usage;

    const kind = TEXT_KIND[type]
      ?? (s.subagent_info ? 'subagent' : type === 'tool' || type === 'tool_call' || s.tool_info ? 'tool' : null);
    const fresh = index > this.#lastStep;
    this.#lastStep = Math.max(this.#lastStep, index);
    if (!kind) return; // user_input, checkpoint, unknown steps - plumbing

    // A new step while no prompt of ours is running is the agent working on
    // its own (a background task finished). It is a turn of its own, ended by
    // the `result` agy sends for it - never by a quiet stream.
    if (fresh && !this.#turnQueue.length && !this.#outbox.length && this.#pipe && !this.#dead && !this.#initWait) this.#wake();

    let open = this.#open.get(index);
    if (!open) {
      open = { id: `s${index}`, kind };
      this.#open.set(index, open);
      const info = s.tool_info ?? s.tool ?? {};
      const sub = s.subagent_info ?? {};
      this.push('item.start', {
        id: open.id, kind, turnId: this.#turnQueue[0],
        ...(kind !== 'text' && kind !== 'thinking' ? {
          name: info.name ?? info.tool_name ?? info.tool ?? sub.name ?? type,
          input: info.parameters ?? info.input ?? info.arguments ?? {},
        } : {}),
      });
    }
    if (typeof s.text_delta === 'string' && s.text_delta) {
      this.#streamed = true;
      this.push('item.delta', { id: open.id, text: s.text_delta });
    }
    if (done) {
      this.#open.delete(index);
      const info = s.tool_info ?? s.tool ?? {};
      const output = info.output ?? info.result ?? info.response ?? s.output;
      this.push('item.done', {
        id: open.id,
        status: s.error ? 'error' : 'ok',
        ...(output ? { output: clip(typeof output === 'string' ? output : JSON.stringify(output)) } : {}),
        ...(s.error ? { error: String(s.error) } : {}),
      });
    }
  }

  #wake() {
    const turnId = `wake-${randomUUID().slice(0, 8)}`;
    this.#turnQueue.push(turnId);
    this.#streamed = false;
    this.push('turn.start', { turnId, text: '', wake: true });
    this.push('status', { status: 'working' });
  }

  #onResult(r) {
    const id = r.conversation_id;
    if (id) this.engineSessionId = id;

    const status = String(r.status ?? '').toUpperCase();
    const ok = status === 'SUCCESS' || status === 'OK' || (status === '' && !r.error);
    const turnId = this.#turnQueue.shift();

    // A result with no turn behind it is the CLI failing at start-up (the
    // eligibility check fires before any prompt reaches us).
    if (!turnId) {
      if (!ok) {
        this.#initError = r.error || 'agy refused the session';
        this.push('error', { message: this.#initError, kind: 'init' });
      }
      return;
    }

    // A model that answered without streaming still leaves its text on the
    // result; only emit it when nothing arrived as text_delta.
    if (!this.#streamed && r.response) {
      const id2 = `s-final`;
      this.push('item.start', { id: id2, kind: 'text', turnId });
      this.push('item.delta', { id: id2, text: r.response });
      this.push('item.done', { id: id2, status: 'ok' });
    }
    for (const left of this.#open.values()) this.push('item.done', { id: left.id, status: 'ok' });
    this.#open.clear();

    // usage counters accumulate across the conversation; the turn's share
    // is the delta since the previous result.
    const cur = USAGE(r.usage) ?? USAGE(this.#stepUsage);
    const prev = this.#prevUsage;
    this.#prevUsage = cur ?? prev;
    const usage = cur && {
      input: Math.max(0, cur.input - (prev?.input ?? 0)),
      output: Math.max(0, cur.output - (prev?.output ?? 0)),
      cacheRead: Math.max(0, cur.cacheRead - (prev?.cacheRead ?? 0)),
    };
    this.#stepUsage = null;

    const interrupted = this.#interrupting || status === 'CANCELLED' || status === 'INTERRUPTED' || status === 'ABORTED';
    this.#interrupting = false;
    const turnStatus = interrupted ? 'interrupted' : ok ? 'ok' : 'error';
    this.#settleTurn(turnId, turnStatus, ok || interrupted ? undefined : (r.error || 'agy reported an error'), usage);

    if (this.#wantRespawn) return this.#restartForArgs();
    this.#pump();
  }

  #settleTurn(turnId, status, error, usage) {
    this.flush();
    this.push('turn.done', { turnId, status, error, usage });
    if (!this.#turnQueue.length && !this.#outbox.length && !this.pending.size) {
      this.push('status', { status: 'idle' });
    }
  }
}
