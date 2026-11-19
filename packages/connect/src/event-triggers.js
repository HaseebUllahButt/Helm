import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { checkCommand, digest, fileFingerprint, onMachine, shellArgs, triggerAccount } from './trigger-sources.js';
import { describeEvent } from './trigger-label.js';
import { ownNode } from './own-node.js';

const FAILURES_TO_PAUSE = 3;
const ONLINE_SETTLE_MS = 30_000;
const RUN_ID_PREFIX = 'helm-trigger-';
const KINDS = ['file-change', 'command-change', 'webhook', 'chat-finished', 'machine-online'];
const randomId = () => randomBytes(16).toString('hex');
const own = (record, key) => Object.hasOwn(record ?? {}, key) ? record[key] : undefined;
const eligibleStatus = status => ['working', 'blocked'].includes(status);
const webhookInput = body => `Webhook body (input data):\n${body}`;

function word(value, label, limit = 32000) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) {
    throw new Error(`Give ${label} in 1 to ${limit} characters.`);
  }
  return value;
}

function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Set ${label} between ${min} and ${max}.`);
  return value;
}

export class EventTriggers {
  constructor({ schedules, sessions, executions, now, self, presence = () => ({}), machineName = () => null,
    notify = () => {}, probe = checkCommand, fingerprint = fileFingerprint, account = triggerAccount }) {
    Object.assign(this, { schedules, sessions, executions, now, self, presence, machineName, notify, probe, fingerprint, account });
    this.checking = new Set();
    this.revisions = new WeakMap();
    this.reached = new Set();
    this.controller = new AbortController();
    this.startedAt = now();
  }

  records() { return this.schedules.records.filter(record => record.type === 'event'); }

  async create(input, id, webhookToken) {
    const kind = input.event?.kind;
    if (!KINDS.includes(kind)) throw new Error('Choose an event from helm when --help.');
    const event = { kind };
    const cwd = input.cwd == null ? null : onMachine(word(input.cwd, 'a folder', 4096));
    const command = input.command != null ? word(input.command, 'a command') : null;
    const prompt = input.prompt != null ? word(input.prompt, 'a task') : null;
    if (Boolean(command) === Boolean(prompt) || (command && input.account != null)) throw new Error('Give a task prompt or --run. Use --account for a prompt.');
    const cooldownSeconds = integer(input.cooldownSeconds ?? 60, 'the cool-down in seconds', 1, 86400);
    if (kind === 'file-change') {
      event.path = onMachine(word(input.event.path, 'a path or glob', 4096), cwd ?? homedir());
      event.pattern = input.event.pattern === true;
    } else if (kind === 'command-change') {
      event.check = word(input.event.check, 'a check command');
      event.everyMinutes = integer(input.event.everyMinutes, 'minutes between checks', 1, 525600);
    } else if (kind === 'chat-finished' && input.event.chatId != null) {
      event.chatId = word(input.event.chatId, 'a chat ID', 128);
    } else if (kind === 'machine-online' && input.event.machineId != null) {
      event.machineId = word(input.event.machineId, 'a machine ID', 128);
      if (event.machineId === this.self || !this.machineName(event.machineId)) throw new Error('Choose another machine to watch.');
    }
    let context;
    if (input.contextChatId) try { context = this.sessions.get(input.contextChatId); } catch { /* Chat is gone. */ }
    if (['plan', 'readonly', 'read'].includes(context?.mode)) throw new Error('Leave read-only mode before adding a trigger.');
    let profileId;
    if (prompt) {
      profileId = await this.account(input.account == null ? null : word(input.account, 'an account', 256), context?.profileId);
    }
    const record = { id, type: 'event', enabled: true, name: (input.name ? word(input.name, 'a name', 100) : command || prompt).trim().split('\n')[0].slice(0, 100),
      event, cwd, command, prompt, profileId, cooldownSeconds, createdAt: this.now() };
    if (kind === 'file-change') {
      record.sample = await this.fingerprint(event.path, event.pattern);
      record.nextCheckAt = this.now() + 5000;
    }
    if (kind === 'machine-online') record.sample = this.onlineMachines(event);
    if (kind === 'webhook') record.webhookToken = webhookToken;
    return record;
  }

  visible(record) {
    const { sample, nextCheckAt, seenChats, nativeWorking, receipts, run, webhookToken, ...view } = record;
    if (run) view.dispatching = run.id;
    const event = { ...view.event, machineName: view.event.machineId ? this.machineName(view.event.machineId) : undefined };
    view.event = { ...event, label: describeEvent(event) };
    return view;
  }

  setEnabled(record, enabled) {
    if (record.enabled === enabled) return;
    record.enabled = enabled;
    this.revisions.set(record, (this.revisions.get(record) ?? 0) + 1);
    if (enabled) {
      record.failures = 0;
      record.checkFailures = 0;
      delete record.pausedAfterFailures;
      delete record.checkError;
      delete record.nextCheckAt;
      delete record.nativeWorking;
      if (record.event.kind === 'machine-online') record.sample = this.onlineMachines(record.event);
      else delete record.sample;
    }
    this.schedules.persist();
  }

  onlineMachines(event) {
    const machines = Object.fromEntries(Object.entries(this.presence())
      .filter(([id]) => id !== this.self && this.machineName(id) && (!event.machineId || id === event.machineId))
      .map(([id, state]) => [id, state.online === true]));
    for (const [id, online] of Object.entries(machines)) if (online) this.reached.add(id);
    return machines;
  }

  accept(record, input, receipt) {
    if (!record.enabled || record.run || record.lastRunAt != null && this.now() - record.lastRunAt < record.cooldownSeconds * 1000) return false;
    const { lastRunAt, lastResult, lastSessionId } = record;
    record.run = { id: randomId(), input };
    record.lastRunAt = this.now();
    record.lastResult = { state: 'running' };
    delete record.lastSessionId;
    if (receipt) (record.receipts ??= []).push(receipt);
    try { this.schedules.persist(); }
    catch (error) {
      delete record.run;
      Object.assign(record, { lastRunAt, lastResult, lastSessionId });
      if (receipt) record.receipts.pop();
      throw error;
    }
    return true;
  }

  webhook(record, body, headers, rawBody) {
    if (this.controller.signal.aborted) return { status: 503, error: 'Helm is stopping. Try again after it starts.' };
    const key = headers['idempotency-key'] ?? headers['x-github-delivery'];
    if (key != null && (typeof key !== 'string' || key.length > 128)) return { status: 400, error: 'Use a delivery ID of up to 128 characters.' };
    const receipt = key ? digest(key) : null;
    if (receipt && record.receipts?.includes(receipt)) return { status: 202, duplicate: true };
    if (!record.enabled) return { status: 409, error: 'The trigger is paused.' };
    if (record.prompt && record.prompt.length + webhookInput(body).length + 2 > 32000) return { status: 413, error: 'Use a smaller body. The task and body can use up to 32000 characters.' };
    const input = record.command ? (rawBody ?? Buffer.from(body)).toString('base64') : webhookInput(body);
    if (!this.accept(record, input, receipt)) return { status: 429, error: 'The trigger is busy or counting down. Try again later.' };
    this.background(record);
    return { status: 202, state: 'pending' };
  }

  observeChat(session, { seq, at, status }) {
    for (const record of this.records()) {
      if (!this.watchesChat(record, session) || at < record.createdAt) continue;
      if (seq <= (own(record.seenChats, session.id) ?? 0)) continue;
      (record.seenChats ??= {})[session.id] = seq;
      if (this.accept(record, `Chat ${session.id} finished. Result: ${status ?? 'done'}.`)) this.background(record);
      else this.schedules.persist();
    }
  }

  observeNative(session) {
    if (!session.nativeChat && !session.nativeCli || session.driver) return;
    for (const record of this.records()) {
      if (!this.watchesChat(record, session)) continue;
      const working = own(record.nativeWorking, session.id);
      if (eligibleStatus(session.status) && (!working || working !== session.updatedAt)) {
        (record.nativeWorking ??= {})[session.id] = session.updatedAt;
        this.schedules.persist();
      } else if (working && ['idle', 'done'].includes(session.status) && session.updatedAt >= working) {
        delete record.nativeWorking[session.id];
        if (this.accept(record, `Chat ${session.id} finished.`)) this.background(record);
        else this.schedules.persist();
      }
    }
  }

  watchesChat(record, session) {
    if (this.controller.signal.aborted || !record.enabled || record.event.kind !== 'chat-finished') return false;
    if (record.event.chatId) return session.id.startsWith(record.event.chatId)
      && !session.originAutomationId?.startsWith(`${RUN_ID_PREFIX}${record.id}-`);
    return !session.brain && !session.originAutomationId?.startsWith(RUN_ID_PREFIX);
  }

  async observe(record, signal) {
    const { event } = record;
    if (event.kind === 'machine-online') {
      const before = record.sample ?? {}, after = this.onlineMachines(event);
      // Hub paths take time to reconnect after a daemon restart. Keep a
      // saved online state until the machine had time to reconnect.
      for (const id of Object.keys(after)) {
        if (before[id] && !after[id] && !this.reached.has(id) && this.now() - this.startedAt < ONLINE_SETTLE_MS) after[id] = true;
      }
      const changed = Object.keys(after).filter(id => after[id] && before[id] !== true);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        record.sample = after;
        if (!changed.length || !this.accept(record, changed.map(id => `${this.machineName(id)} came online.`).join('\n'))) this.schedules.persist();
      }
      return;
    }
    if (event.kind !== 'file-change' && event.kind !== 'command-change' || record.nextCheckAt > this.now()) return;
    const revision = this.revisions.get(record);
    const current = () => !signal.aborted && record.enabled && revision === this.revisions.get(record);
    record.nextCheckAt = this.now() + (event.everyMinutes ? event.everyMinutes * 60_000 : 5_000);
    if (event.everyMinutes) this.schedules.persist();
    let sample;
    try {
      sample = event.kind === 'file-change' ? await this.fingerprint(event.path, event.pattern)
        : await this.probe(event.check, record.cwd ?? homedir(), signal);
    } catch (error) {
      if (current()) this.failed(record, error.message, true);
      return;
    }
    if (!current()) return;
    const before = record.sample, hadError = record.checkError;
    record.sample = sample;
    if (hadError) {
      delete record.checkError;
      record.checkFailures = 0;
    }
    if (before !== sample || hadError) {
      try {
        const detail = event.kind === 'file-change' ? `File change at ${event.path}.`
          : `Check result changed. Exit code ${JSON.parse(sample)[0]}.`;
        if (before == null || before === sample || !this.accept(record, detail)) this.schedules.persist();
      } catch (error) {
        record.sample = before;
        throw error;
      }
    }
  }

  failed(record, message, check = false) {
    const field = check ? 'checkFailures' : 'failures';
    record[field] = (record[field] ?? 0) + 1;
    if (check) record.checkError = String(message).slice(0, 500);
    else {
      record.lastResult = { state: 'failed', message: String(message).slice(0, 500) };
      delete record.run;
    }
    const paused = record.enabled && record[field] >= FAILURES_TO_PAUSE;
    if (paused) {
      record.enabled = false;
      record.pausedAfterFailures = true;
    }
    this.schedules.persist();
    if (paused) this.notify(record);
  }

  async run(record, signal) {
    const pending = record.run;
    const identity = `${RUN_ID_PREFIX}${record.id}-${pending.id}`;
    let result;
    if (record.command) {
      if (!pending.started) {
        const stdin = Buffer.from(pending.input, record.event.kind === 'webhook' ? 'base64' : 'utf8');
        this.executions.start({ id: pending.id, argv: shellArgs(record.command), cwd: record.cwd ?? homedir() }, identity,
          { stdin, node: ownNode(), keepResult: true });
        pending.started = true;
        delete pending.input;
        this.schedules.persist();
      }
      const status = await this.executions.read({ id: pending.id }, identity, { resultOnly: true });
      if (status.status === 'exited') result = status.error || (status.exitCode !== 0 ? `Exit code ${status.exitCode}.` : 'Exit code 0.');
      if (!signal.aborted && result && status.exitCode === 0 && !status.error) this.succeeded(record, result);
      else if (!signal.aborted && result) this.failed(record, result);
      return;
    }
    const saved = this.sessions.findAutomationSession(identity);
    if (!saved && pending.started) throw new Error('The chat is no longer available.');
    const session = saved || await this.sessions.start({
      ...(record.cwd ? { cwd: record.cwd } : { quick: true }),
      profileId: record.profileId, title: record.name, originAutomationId: identity, reservedSessionId: pending.id.slice(0, 12),
    });
    if (signal.aborted) return;
    record.lastSessionId = session.id;
    const events = this.sessions.events.tail(session.id, 0);
    const echo = events.findLast(e => e.type === 'turn.start' && e.inputId === identity);
    const done = events.findLast(e => e.type === 'turn.done' && (e.turnId === identity || echo && e.turnId === echo.turnId));
    if (done) {
      if (done.status === 'ok') this.succeeded(record);
      else this.failed(record, done.error || 'The chat could not finish the task.');
      return;
    }
    if (session.archived || session.stoppedAt) throw new Error('The chat stopped or was archived.');
    if (session.recovery?.deliveryTurnId === identity) throw new Error('Helm could not confirm that the chat received the task.');
    if (session.recovery && pending.started) throw new Error(session.recovery.message || 'The chat could not finish the task.');
    const turn = this.sessions.events.turnState(session.id, identity);
    if (turn === 'open') return;
    if (turn === 'done') return this.succeeded(record);
    if (pending.started || turn || session.recovery) throw new Error('The chat could not finish the task.');
    if (!record.enabled) return;
    await this.sessions.input(session.id, `${record.prompt}\n\n${pending.input}`, { turnId: identity, delivery: 'queue', source: 'schedule' });
    if (signal.aborted) return;
    pending.started = true;
    delete pending.input;
    this.schedules.persist();
  }

  succeeded(record, message) {
    record.failures = 0;
    record.lastResult = { state: 'succeeded', message };
    delete record.run;
    this.schedules.persist();
  }

  async tick() { await Promise.all(this.records().map(record => this.process(record))); }

  background(record) {
    void this.process(record).catch(error => { this.schedules.triggerError = error.message; });
  }

  async process(record) {
    if (this.checking.has(record.id) || this.controller.signal.aborted) return;
    const { signal } = this.controller;
    this.checking.add(record.id);
    try {
      const before = record.run;
      if (record.run?.started || record.enabled && record.run) {
        try { await this.run(record, signal); }
        catch (error) { if (!signal.aborted) this.failed(record, error.message); }
      }
      if (record.enabled && !signal.aborted) await this.observe(record, signal);
      if (record.enabled && !signal.aborted && record.run && record.run !== before) {
        try { await this.run(record, signal); }
        catch (error) { if (!signal.aborted) this.failed(record, error.message); }
      }
    } finally { this.checking.delete(record.id); }
  }

  stop() { this.controller.abort(); }
}
