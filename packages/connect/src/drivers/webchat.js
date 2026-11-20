import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Driver, waitForExit } from './index.js';
import { ownNode } from '../own-node.js';
import { HELM_DIR } from '../paths.js';
import { webchatConfig, ENGINE } from '../webchat/config.js';

const HELM_BIN = fileURLToPath(new URL('../../bin/helm.js', import.meta.url));
const isDriverTurn = (turnId) => /^turn-/.test(String(turnId));
// What a temporary chat sends again when its tab is gone.
const HISTORY_TURNS = 6;
const HISTORY_CHARS = 12_000;
const RESTARTED = '(The temporary chat was gone. Helm started a new one and sent the earlier messages with this one.)\n\n';

/**
 * What goes to the site. A message from another agent (helm say) carries
 * Helm's header with reply steps that only an agent can follow; the site
 * gets the words after it.
 */
/** The web conversation an engine session id names: an address, 'temporary', or none yet. */
export const conversationOf = (id) => (id === 'temporary' || /^https?:\/\//.test(String(id ?? '')) ? id : null);

export function siteText(text) {
  const body = String(text ?? '');
  const header = /^\[Helm agent message [a-f0-9]+\]\nFrom [^\n]*\n[\s\S]*?\n\n/.exec(body);
  return header ? body.slice(header[0].length) : body;
}

/**
 * A signed-in web chat (Gemini, ChatGPT, Claude.ai) as a Helm agent. It
 * only answers: no tools, no files, no approvals. Each message is typed
 * into the site in the owner's browser by `helm webchat worker`
 * (webchat/worker.js); follow-ups go to the same web conversation, whose
 * address is kept as the chat's engineSessionId ('temporary' for a
 * temporary chat, which has no address; a placeholder before the first answer).
 *
 * The worker runs on the process host, so a Helm restart does not stop an
 * answer on its way: the new daemon binds the same worker and reads on.
 */
export class WebchatDriver extends Driver {
  // Helm's brief to agents is about tools and machines; a web chat has
  // neither, so it is taken here and never sent to the site.
  static takesInstructions = true;

  #pipe = null;
  #exited = null;
  #ready = null;
  #starting = null;
  #turn = null;
  #queue = [];
  #tab = null;
  #stopping = false;

  constructor(opts) {
    super({ ...opts, engine: ENGINE });
    this.config = webchatConfig(opts.env ?? {});
  }

  async start() {
    // Helm needs an id from the start; the site's address replaces it after the first answer.
    this.engineSessionId ||= `webchat-new-${randomUUID().slice(0, 8)}`;
    if (this.#pipe) return;
    this.#starting ??= this.#spawn().finally(() => { this.#starting = null; });
    return this.#starting;
  }

  async #spawn() {
    const env = { ...this.env, HELM_DIR };
    const args = [HELM_BIN, 'webchat', 'worker'];
    let pipe = null, adopted = false;
    if (this.procId && this.procHost?.hasProc(this.procId)) { pipe = this.procHost.procPipe(this.procId); adopted = !!pipe; }
    if (!pipe && this.procId && this.procHost) {
      await this.procHost.openProc(this.procId, { cmd: ownNode(), args, cwd: this.#cwd(), env });
      pipe = this.procHost.procPipe(this.procId);
      if (!pipe) throw new Error('could not attach to the agent process host');
    }
    if (!pipe) pipe = this.#localPipe(spawn(ownNode(), args, { cwd: this.#cwd(), env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] }));
    this.#bind(pipe);
    this.emit('init', { model: this.model || this.config.model || null });
    if (adopted) this.#adopt();
    else {
      let timer;
      await Promise.race([this.#ready, this.#exited, new Promise((r) => { timer = setTimeout(r, 30_000); })]);
      clearTimeout(timer);
      if (!this.#pipe) throw new Error('the web chat worker did not start');
      this.push('status', { status: this.#turn || this.#queue.length ? 'working' : 'idle' });
    }
  }

  // The worker never reads files, so any folder will do; a removed one must not stop it.
  #cwd() { return HELM_DIR; }

  #localPipe(child) {
    let tail = '', result = null, onExit = null;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { tail = (tail + d).slice(-4000); });
    const finish = (r) => { if (result) return; result = r; onExit?.(r); };
    child.on('exit', (code, signal) => finish({ code, signal, stderr: tail.trim().split('\n').pop() || null }));
    child.on('error', (err) => finish({ code: -1, signal: null, stderr: err.message }));
    return {
      write: (d) => child.stdin.write(d),
      end: () => child.stdin.end(),
      kill: (s) => child.kill(s),
      onData: (cb) => child.stdout.on('data', (c) => cb(String(c))),
      onExit: (cb) => { onExit = cb; if (result) queueMicrotask(() => cb(result)); },
      detach: () => {},
    };
  }

  #bind(pipe) {
    this.#pipe = pipe;
    let readyNow;
    this.#ready = new Promise((r) => { readyNow = r; });
    let buf = '';
    pipe.onData((chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { this.log(`webchat worker: ${line.slice(0, 300)}`); continue; }
        if (m.type === 'ready') readyNow();
        else this.#onMessage(m);
      }
    });
    this.#exited = new Promise((resolve) => {
      pipe.onExit(({ code, signal, stderr } = {}) => {
        if (this.#pipe === pipe) this.#pipe = null;
        const turn = this.#turn;
        if (turn) {
          this.#turn = null;
          const error = this.#stopping ? undefined : `The web chat worker stopped${stderr ? `: ${stderr}` : ''}.`;
          this.#finish(turn, this.#stopping ? 'interrupted' : 'error', error);
        }
        this.#stopping = false;
        if (!this.killed) this.push('status', { status: 'exited', code, signal });
        resolve({ code });
        if (this.#queue.length && !this.killed) void this.#next();
      });
    });
  }

  /** After a restart: the turn the log holds open is the one the worker is still on. */
  #adopt() {
    const open = this.openTurn?.() ?? null;
    if (open && isDriverTurn(open)) this.#turn = { turnId: open, item: null, streamed: '' };
    else if (open) this.push('turn.done', { turnId: open, status: 'interrupted', error: 'helm restarted before this message reached the web chat' });
    this.push('status', { status: this.#turn ? 'working' : 'idle' });
  }

  async send(text) {
    const turnId = `turn-${randomUUID().slice(0, 8)}`;
    this.push('turn.start', { turnId, text });
    this.push('status', { status: 'working' });
    this.#queue.push({ turnId, text: siteText(text) });
    await this.#next();
  }

  async #next() {
    if (this.#turn || !this.#queue.length) return;
    try { await this.start(); } catch (err) {
      for (const q of this.#queue.splice(0)) this.push('turn.done', { turnId: q.turnId, status: 'error', error: err.message });
      this.push('status', { status: 'idle' });
      throw err;
    }
    if (this.#turn || !this.#queue.length || !this.#pipe) return;
    const q = this.#queue.shift();
    this.#turn = { turnId: q.turnId, item: null, streamed: '' };
    const conversation = conversationOf(this.engineSessionId);
    const history = conversation === 'temporary' ? this.#history(q.turnId) : [];
    this.#pipe.write(`${JSON.stringify({ type: 'ask', turnId: q.turnId, text: q.text, conversation, tab: this.#tab, history })}\n`);
  }

  /** Earlier questions and answers of this chat, newest last, for a temporary chat sent again. */
  #history(skip) {
    const events = this.resumeEvents?.() ?? [];
    const turns = new Map(), items = new Map();
    for (const e of events) {
      if (e.type === 'turn.start' && e.turnId !== skip && !e.wake) turns.set(e.turnId, { q: e.text ?? '', a: '', ok: false });
      else if (e.type === 'item.start' && e.kind === 'text' && turns.has(e.turnId)) items.set(e.id, e.turnId);
      else if (e.type === 'item.delta' && items.has(e.id)) turns.get(items.get(e.id)).a += e.text ?? '';
      else if (e.type === 'turn.done' && turns.has(e.turnId)) turns.get(e.turnId).ok = e.status === 'ok';
    }
    const done = [...turns.values()].filter((t) => t.ok && t.q && t.a).slice(-HISTORY_TURNS);
    while (done.length > 1 && done.reduce((n, t) => n + t.q.length + t.a.length, 0) > HISTORY_CHARS) done.shift();
    return done.map(({ q, a }) => ({ q, a }));
  }

  #onMessage(m) {
    const turn = this.#turn;
    if (!turn || m.turnId !== turn.turnId) return;
    if (m.type === 'sent') { this.#tab = m.tab ?? this.#tab; if (m.restarted) turn.note = RESTARTED; return; }
    if (m.type === 'progress') return this.#stream(turn, m.text);
    if (m.type === 'answer') {
      this.#tab = m.tab ?? this.#tab;
      if (m.conversation) this.engineSessionId = m.conversation;
      if (m.model) this.emit('init', { model: m.model });
      if (m.restarted) turn.note = RESTARTED;
      this.#stream(turn, m.text, { final: true });
      this.#turn = null;
      this.#finish(turn, 'ok');
    } else if (m.type === 'stopped') {
      this.#turn = null;
      this.#finish(turn, 'interrupted');
    } else if (m.type === 'error') {
      this.#turn = null;
      this.push('error', { message: m.message, kind: 'webchat' });
      this.#finish(turn, 'error', m.message);
    } else return;
    void this.#next().catch(() => {});
  }

  /**
   * Show the answer as it grows. While the site writes, its text only
   * grows; a page redraw that changes the shown part is skipped. If the
   * full answer does not continue what was shown, it goes in a new block.
   */
  #stream(turn, text = '', { final = false } = {}) {
    if (!text) return;
    if (turn.streamed && !text.startsWith(turn.streamed)) {
      if (!final) return;
      this.push('item.done', { id: turn.item, status: 'ok' });
      turn.item = null; turn.streamed = '';
    }
    if (!turn.item) {
      turn.item = `webchat-${randomUUID().slice(0, 8)}`;
      this.push('item.start', { id: turn.item, kind: 'text', turnId: turn.turnId });
      if (turn.note) this.push('item.delta', { id: turn.item, text: turn.note });
    }
    const more = text.slice(turn.streamed.length);
    if (more) this.push('item.delta', { id: turn.item, text: more });
    turn.streamed = text;
  }

  #finish(turn, status, error) {
    this.#stopping = false;
    if (turn.item) this.push('item.done', { id: turn.item, status: status === 'ok' ? 'ok' : 'error' });
    this.push('turn.done', { turnId: turn.turnId, status, ...(error ? { error } : {}) });
    if (!this.#turn && !this.#queue.length) this.push('status', { status: 'idle' });
  }

  async interrupt() {
    for (const q of this.#queue.splice(0)) this.push('turn.done', { turnId: q.turnId, status: 'interrupted' });
    if (!this.#turn) { this.push('status', { status: 'idle' }); return; }
    if (!this.#pipe) return;
    this.#stopping = true;
    this.#pipe.write(`${JSON.stringify({ type: 'stop' })}\n`);
  }

  async answer() { throw new Error('a web chat asks no questions of its own'); }
  // The model is the one the account names; the site keeps its own choice.
  async setModel(model) { this.model = model || null; }
  async setEffort() { return { applied: false }; }
  async setMode(mode) { this.mode = mode; }
  async compact() { this.push('error', { message: 'A web chat cannot compact its conversation. Start a new chat instead.', kind: 'settings' }); }
  async availableCommands() { return []; }
  catalog() { return null; }

  async kill() {
    this.killed = true;
    const pipe = this.#pipe;
    if (!pipe) return;
    try { pipe.end(); } catch { /* closed */ }
    if (!(await waitForExit(this.#exited, 3000))) pipe.kill('SIGTERM');
    if (!(await waitForExit(this.#exited, 2000))) pipe.kill('SIGKILL');
    await waitForExit(this.#exited, 2000);
  }

  /** Keep the worker alive while this daemon is replaced; the next one binds it again. */
  async suspend() {
    if (this.#pipe && this.procHost?.hasProc(this.procId)) { this.#pipe.detach(); this.#pipe = null; return; }
    return this.kill();
  }
}

