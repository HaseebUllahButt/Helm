import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { M, E } from '@helm/protocol';
import { parseAgentArgs, chooseAgent } from './delegation.js';

const HELP = '\n/allow [request] · /always [request] · /deny [request]\n/answer [request] <question number> <choice number or text>\n/stop interrupts · /detach leaves the agent running · /end deletes the Helm thread\nOther text and provider slash commands go to the agent.\n';
// Provider text is data, not terminal escape sequences.
const safe = (value) => String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');

/** A thin controller of the same session and native request IDs the app uses. */
export class ManagedChat {
  #last = 0;
  #items = new Map();
  #pending = new Map();
  #answers = new Map();
  #buffer = [];
  #ready = false;
  #syncing = null;
  #closed = false;
  constructor(connection, id, { write = (text) => process.stdout.write(text), detach = () => {} } = {}) {
    Object.assign(this, { connection, id, write, detach });
    this.onEvent = (kind, payload) => {
      if (kind !== E.SESSION_EVENT || payload?.id !== id) return;
      if (!this.#ready || this.#syncing) this.#buffer.push(...payload.events);
      else {
        const events = payload.events.filter((event) => event.seq > this.#last);
        if (events.length && events[0].seq > this.#last + 1) {
          this.#buffer.push(...events);
          void this.sync().catch((error) => this.write(`\n${safe(error.message)}\n`));
        } else this.#consume(events, true);
      }
    };
    connection.on('event', this.onEvent);
  }
  async sync() {
    if (this.#syncing) return this.#syncing;
    const initial = !this.#ready;
    this.#syncing = Promise.resolve().then(async () => {
      let snapshot;
      do {
        snapshot = await this.connection.rpc(M.SESSION_EVENTS, {
          id: this.id, ...(initial ? { tail: 200 } : { since: this.#last, limit: 500 }),
        });
        const before = this.#last;
        this.#consume(snapshot.events, !initial);
        if (initial) this.#last = snapshot.last;
        if (!initial && this.#last < snapshot.last && this.#last === before) {
          // The log was trimmed while this client was away. Fetch its newest
          // window instead of looping over a cursor that no longer exists.
          snapshot = await this.connection.rpc(M.SESSION_EVENTS, { id: this.id, tail: 200 });
          this.#consume(snapshot.events, true);
          this.#last = snapshot.last;
          break;
        }
      } while (!initial && this.#last < snapshot.last);
      this.#replacePending(snapshot.pending ?? []);
      this.#ready = true;
    });
    try { await this.#syncing; }
    finally { this.#syncing = null; }
    const buffered = this.#buffer.splice(0).filter((event) => event.seq > this.#last).sort((a, b) => a.seq - b.seq);
    if (buffered.length && buffered[0].seq > this.#last + 1) {
      this.#buffer.push(...buffered);
      return this.sync();
    }
    this.#consume(buffered, true);
  }
  #consume(events, live) {
    for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
      if (event.seq <= this.#last) continue;
      this.#last = event.seq;
      switch (event.type) {
        case 'turn.start': this.write(`\nYou: ${safe(event.text)}\n`); break;
        case 'item.start':
          this.#items.set(event.id, event.kind);
          if (event.kind === 'text') this.write('\nAgent: ');
          else if (!['thinking', 'reasoning'].includes(event.kind)) {
            this.write(`\n[${safe(event.name || event.kind)}] ${safe(event.command || JSON.stringify(event.input ?? {})).slice(0, 8000)}\n`);
          }
          break;
        case 'item.delta':
          if (this.#items.get(event.id) === 'text') this.write(safe(event.text));
          break;
        case 'item.done':
          if (this.#items.get(event.id) === 'text') this.write('\n');
          else if (event.output) this.write(`${safe(event.output).slice(0, 8000)}\n`);
          break;
        case 'turn.done': this.write(`\n[${safe(event.status)}]\n`); break;
        case 'permission.request': if (live) this.#replacePending([...this.#pending.values(), event]); break;
        case 'permission.resolved':
          if (this.#pending.delete(event.requestId)) this.write(`\n[Request ${safe(event.requestId)} answered: ${safe(event.decision)}]\n`);
          this.#answers.delete(event.requestId);
          break;
        case 'error': this.write(`\n${safe(event.message)}\n`); break;
      }
    }
  }
  #replacePending(requests) {
    const next = new Map(requests.map((request) => [request.requestId, request]));
    for (const request of next.values()) {
      if (this.#pending.has(request.requestId)) continue;
      this.write(`\n[Request ${safe(request.requestId)}] ${safe(request.title)}\n`);
      if (request.detail) this.write(`${safe(typeof request.detail === 'string' ? request.detail : JSON.stringify(request.detail, null, 2)).slice(0, 16000)}\n`);
      if (request.kind === 'question') {
        for (const [index, question] of (request.questions ?? []).entries()) {
          this.write(`${index + 1}. ${safe(question.question)}${question.multiSelect ? ' (multiple choices, separated by commas)' : ''}\n`);
          for (const [choice, option] of (question.options ?? []).entries()) this.write(`   ${choice + 1}) ${safe(option.label)}${option.description ? ` — ${safe(option.description)}` : ''}\n`);
        }
        this.write(`/answer ${safe(request.requestId)} <question number> <choice number or text>\n`);
      } else {
        this.write(`${(request.options ?? []).map((option) => `/${safe(option.id)} ${safe(request.requestId)}`).join(' · ')}\n`);
      }
    }
    for (const id of this.#answers.keys()) if (!next.has(id)) this.#answers.delete(id);
    this.#pending = next;
  }
  #request(id, kind) {
    const matches = [...this.#pending.values()].filter((request) => !kind || request.kind === kind);
    const request = id ? this.#pending.get(id) : matches.length === 1 ? matches[0] : null;
    if (!request || (kind && request.kind !== kind)) throw new Error('choose a pending request ID; it may have been answered on another device');
    return request;
  }
  async line(text) {
    if (this.#closed) return;
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    const command = match?.[1];
    const rest = match?.[2]?.trim() ?? '';
    if (command === 'detach') { this.#closed = true; this.detach(); return; }
    if (command === 'end') {
      await this.connection.rpc(M.SESSION_KILL, { id: this.id });
      this.#closed = true; this.detach(); return;
    }
    if (command === 'stop') { await this.connection.rpc(M.SESSION_INTERRUPT, { id: this.id }); return; }
    if (command === 'chat-help') { this.write(HELP); return; }
    if (['allow', 'always', 'deny'].includes(command)) {
      const request = this.#request(rest);
      if (!(request.options ?? []).some((option) => option.id === command)) throw new Error('that decision is not offered by this request');
      await this.connection.rpc(M.SESSION_ANSWER, { id: this.id, requestId: request.requestId, decision: { option: command } });
      return;
    }
    if (command === 'answer') {
      const parts = rest.split(/\s+/);
      const explicit = parts.length >= 3 && this.#pending.has(parts[0]);
      const request = this.#request(explicit ? parts.shift() : null, 'question');
      const number = Number(parts.shift());
      const question = request.questions?.[number - 1];
      const textAnswer = parts.join(' ');
      if (!Number.isInteger(number) || !question || !textAnswer) throw new Error('use /answer [request] <question number> <choice number or text>');
      const selections = textAnswer.split(',').map((part) => part.trim());
      const answer = selections.map((selection) => {
        if (/^\d+$/.test(selection) && question.options?.[Number(selection) - 1]) return question.options[Number(selection) - 1].label;
        return selection;
      }).join(', ');
      const answers = { ...this.#answers.get(request.requestId), [question.question || question.id]: answer };
      this.#answers.set(request.requestId, answers);
      if (!request.questions.every((q) => Object.hasOwn(answers, q.question || q.id))) {
        this.write('Answer the remaining questions, or answer them in the app.\n'); return;
      }
      await this.connection.rpc(M.SESSION_ANSWER, { id: this.id, requestId: request.requestId, decision: { option: 'allow', answers } });
      return;
    }
    if (text.trim()) await this.connection.rpc(M.SESSION_INPUT, { id: this.id, data: text });
  }
  close() { this.#closed = true; this.connection.off('event', this.onEvent); }
}

/** Session creation is separate from the foreground controller's lifetime. */
export async function openChat(args, { rpc, cwd = process.cwd() } = {}) {
  const { options, words } = parseAgentArgs(args, { values: ['attach', 'resume', 'cwd', 'model', 'mode', 'effort', 'title'] });
  if (options.attach && (words.length || options.resume || Object.keys(options).length > 1)) throw new Error('use helm chat --attach <Helm session ID>');
  let session;
  if (options.attach) {
    ({ session } = await rpc(M.SESSION_CONNECT, { id: options.attach }));
  } else {
    const [account, ...prompt] = words;
    if (!account) throw new Error('use helm chat <account> [--resume <native ID>] [-- <first message>] or helm chat --attach <Helm session ID>');
    const { agents } = await rpc(M.AGENT_LIST, { models: false });
    const agent = chooseAgent(agents, account);
    if (!agent.available) throw new Error(`${agent.id} is signed out; log in through its CLI first`);
    if (options.resume) {
      ({ session } = await rpc(M.SESSION_RESUME, { engine: agent.engine, account: agent.id, id: options.resume }));
    } else {
      ({ session } = await rpc(M.SESSION_START, {
        cwd: resolve(options.cwd ?? cwd), profileId: agent.id,
        model: options.model, mode: options.mode, effort: options.effort, title: options.title,
      }, 70_000));
    }
    ({ session } = await rpc(M.SESSION_CONNECT, { id: session.id }, 70_000));
    return { session, prompt: prompt.join(' ') };
  }
  return { session, prompt: '' };
}

export async function runChat(args, { connection, input = process.stdin, output = process.stdout } = {}) {
  let chat, reader, renew, session;
  const watchId = `terminal-${randomUUID()}`;
  let finish, stopped = false, readerClosed = false;
  const done = new Promise((resolve) => { finish = () => { stopped = true; resolve(); }; });
  const lost = (error) => { output.write(`\n${safe(error.message)}. The agent stays on its machine.\n`); finish(); };
  connection.on('disconnect', lost);
  try {
    const opened = await openChat(args, { rpc: connection.rpc.bind(connection) });
    session = opened.session;
    output.write(`\nHelm ${session.id} · ${safe(session.engine)} · ${safe(session.cwd)}\nSame conversation and approvals in the Helm app.\nReconnect: helm chat --attach ${session.id}\n${HELP}`);
    chat = new ManagedChat(connection, session.id, { write: (text) => output.write(text), detach: () => finish() });
    await connection.rpc(M.SESSION_WATCH, { id: session.id, watchId });
    await chat.sync();
    if (opened.prompt) await chat.line(opened.prompt);
    renew = setInterval(() => {
      void connection.rpc(M.SESSION_WATCH, { id: session.id, watchId }).then(() => chat.sync()).catch(lost);
    }, 20_000);
    reader = createInterface({ input, output, prompt: '> ', terminal: !!input.isTTY && !!output.isTTY });
    // RPCs from this frontend are ordered; the other frontends remain free
    // to answer. The daemon's native request ID rejects stale answers.
    let pending = Promise.resolve();
    reader.on('SIGINT', () => { output.write(`\nDetached. Reconnect: helm chat --attach ${session.id}\n`); finish(); });
    reader.on('close', () => { readerClosed = true; void pending.finally(() => finish()); });
    reader.on('line', (text) => {
      pending = pending.then(() => chat.line(text)).catch((error) => output.write(`\n${safe(error.message)}\n`)).then(() => {
        if (!stopped && !readerClosed) reader.prompt();
      });
    });
    reader.prompt();
    await done;
  } finally {
    clearInterval(renew);
    reader?.close();
    chat?.close();
    if (session) await connection.rpc(M.SESSION_UNWATCH, { id: session.id, watchId }, 2000).catch(() => {});
    connection.off('disconnect', lost);
    connection.close();
  }
}
