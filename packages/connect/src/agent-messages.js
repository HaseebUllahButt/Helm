import { mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HELM_DIR } from './paths.js';

const validId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const fail = (message, code = 'invalid_argument') => Object.assign(new Error(message), { code });
const key = message => `${String(message.at).padStart(16, '0')}:${message.id}`;
const same = (a, b) => a.env === b.env && a.id === b.id;

/** Short, attributed exchanges. Provider sessions/history never move between agents. */
export class AgentMessages {
  #active = new Map();
  constructor({ sessions, delivery, self, rpc, emit = () => {}, dir = join(HELM_DIR, 'agent-messages') }) {
    Object.assign(this, { sessions, delivery, self, rpc, emit, dir });
  }
  address(id, callerThreadId) {
    const s = this.sessions.get(id);
    if (!s.driver || s.external || s.nativeChat || s.nativeCli) throw fail('Choose an agent chat managed by Helm.');
    if (callerThreadId && (s.engine !== 'codex' || s.engineSessionId !== callerThreadId)) {
      throw fail('The calling Codex thread does not match its Helm chat.');
    }
    return { env: this.self, id: s.id, title: s.title, engine: s.engine, model: s.model || s.engineModel || null };
  }
  #folder(id) {
    // Session IDs from our own index only; never use a remote name as a path.
    this.sessions.get(id);
    if (!/^[a-zA-Z0-9._:-]+$/.test(id)) throw fail('Invalid chat ID.');
    return join(this.dir, id);
  }
  #read(sessionId, id) {
    if (!validId(id)) throw fail('Invalid message ID.');
    const folder = this.#folder(sessionId);
    if (!existsSync(folder)) return null;
    const name = readdirSync(folder).find(name => name.endsWith(`-${id}.json`));
    return name ? JSON.parse(readFileSync(join(folder, name), 'utf8')) : null;
  }
  #save(record) {
    const local = new Set([record.from, record.to].filter(a => a.env === this.self).map(a => a.id));
    for (const id of local) {
      try { this.sessions.get(id); } catch { continue; } // A removed peer's history stays removed.
      const folder = this.#folder(id);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const file = join(folder, `${String(record.at).padStart(16, '0')}-${record.id}.json`), temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
      try { writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flag: 'wx' }); renameSync(temp, file); }
      finally { rmSync(temp, { force: true }); }
    }
    this.emit({ sessionIds: [...local] }); // Text stays in the requested history, not every device's event stream.
  }
  async list(id, { before, limit = 30 } = {}) {
    this.address(id);
    const children = await this.sessions.list({ parentId: id });
    const ids = new Set([id, ...children.filter(s => s.delegation?.parentId === id).map(s => s.id)]);
    // Sort small filenames first, then read only this page's bodies. Opening
    // Agents must not parse years of other agents' conversations.
    const paths = new Map();
    for (const sid of ids) {
      const folder = this.#folder(sid);
      if (!existsSync(folder)) continue;
      for (const file of readdirSync(folder)) {
        if (!/^\d{16}-[a-f0-9]{32}\.json$/.test(file)) continue;
        const cursor = file.slice(0, -5).replace('-', ':');
        if (!before || cursor < before) paths.set(cursor, join(folder, file));
      }
    }
    const size = Math.max(1, Math.min(50, Number(limit) || 30));
    const keys = [...paths.keys()].sort().reverse();
    const messages = keys.slice(0, size).map(cursor => {
      let record = JSON.parse(readFileSync(paths.get(cursor), 'utf8'));
      // Recovery may have delivered input after this ledger's writer left.
      if (record.to.env === this.self && record.status !== 'delivered') {
        const receipt = this.delivery.receipt(record.id, `agent:${record.from.env}:${record.from.id}`);
        if (receipt && !receipt.error) { record = { ...record, status: 'delivered', error: undefined }; this.#save(record); }
      }
      return record;
    });
    return { messages, next: keys.length > size ? key(messages.at(-1)) : null };
  }

  async send({ id, to, text, messageId, replyTo, callerThreadId, asUser = false }) {
    const from = this.address(id, callerThreadId);
    if (typeof asUser !== 'boolean') throw fail('Invalid message author.');
    if (!validId(messageId)) throw fail('Supply a 32-character message ID for safe retries.');
    if (typeof text !== 'string' || !text.trim() || text.length > 32000) throw fail('A message must contain 1–32000 characters.');
    const prior = replyTo ? this.#read(id, replyTo) : null;
    if (replyTo && (!prior || !same(prior.to, from))) throw fail('Reply to a message received by this agent.');
    const target = prior?.from ?? to;
    if (!target || typeof target.env !== 'string' || typeof target.id !== 'string') throw fail('Choose a recipient.');
    if (same(from, target)) throw fail('Choose another agent.');
    const old = this.#read(id, messageId);
    if (old && (!same(old.from, from) || !same(old.to, target) || old.text !== text.trim() || old.replyTo !== (replyTo || null) || old.asUser !== asUser)) {
      throw fail('This message ID already belongs to another message.', 'delivery_conflict');
    }
    if (old?.status === 'delivered') return { message: old };
    const fingerprint = JSON.stringify([from.env, from.id, target.env, target.id, text.trim(), replyTo || null, asUser]);
    const active = this.#active.get(messageId);
    if (active) {
      if (active.fingerprint !== fingerprint) throw fail('This message ID already belongs to another message.', 'delivery_conflict');
      return active.promise;
    }
    const running = Promise.resolve().then(async () => {
      const recipient = old?.to ?? (target.env === this.self ? this.address(target.id)
        : (await this.rpc(target.env, 'session.agent-address', { id: target.id })).address);
      const record = old ?? { id: messageId, from, to: recipient, text: text.trim(), replyTo: replyTo || null, asUser,
        at: Date.now(), status: 'unconfirmed' };
      this.#save(record);
      try {
        const result = recipient.env === this.self ? await this.receive(record, this.self)
          : await this.rpc(recipient.env, 'session.agent-receive', { message: record });
        const done = { ...record, status: 'delivered', error: undefined };
        this.#save(done);
        return { ...result, message: done };
      } catch (error) {
        this.#save({ ...record, status: 'unconfirmed', error: String(error.message) });
        throw fail(`${error.message}; message ${messageId} is unconfirmed. Retry with the same message ID.`, error.code || 'delivery_failed');
      }
    }).finally(() => this.#active.delete(messageId));
    this.#active.set(messageId, { fingerprint, promise: running });
    return running;
  }
  async receive(message, caller) {
    if (!message || !validId(message.id) || message.from?.env !== caller || message.to?.env !== this.self
      || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 32000
      || !Number.isSafeInteger(message.at) || message.at < 0 || typeof message.from.id !== 'string' || typeof message.from.title !== 'string'
      || (message.replyTo !== null && !validId(message.replyTo)) || typeof message.asUser !== 'boolean') throw fail('Invalid agent message.');
    this.address(message.to.id);
    const previous = this.#read(message.to.id, message.id);
    if (previous && (previous.text !== message.text || !same(previous.from, message.from) || previous.replyTo !== message.replyTo || previous.asUser !== message.asUser || previous.at !== message.at)) {
      throw fail('This message ID already belongs to another message.', 'delivery_conflict');
    }
    if (previous?.status === 'delivered') return { ok: true };
    const target = this.sessions.get(message.to.id);
    if (!message.asUser && (target.stoppedAt || target.archived)) throw fail('The recipient is stopped or archived; it was not woken.', 'delivery_cancelled');
    const record = { ...message, status: 'sending' };
    this.#save(record);
    const author = record.asUser ? `the owner, from chat ${record.from.title}`
      : `${record.from.engine} agent ${record.from.title}`;
    const prompt = `[Helm agent message ${record.id}]\nFrom ${author} (${record.from.env}/${record.from.id}).${record.replyTo ? `\nReply to ${record.replyTo}.` : ''}\nThis is a message, not a transfer of their conversation. Keep working in your own context.\n${record.asUser ? 'Answer the owner in this conversation.' : `If a reply is needed, send it with: helm reply ${record.id} "your reply". Do not send an acknowledgement just to end an exchange.`}\n\n${record.text}`;
    await this.delivery.deliver({ id: record.to.id, messageId: record.id, data: prompt, delivery: 'queue', source: record.asUser ? 'user' : 'agent' }, `agent:${record.from.env}:${record.from.id}`);
    this.#save({ ...record, status: 'delivered', error: undefined });
    return { ok: true };
  }
}
