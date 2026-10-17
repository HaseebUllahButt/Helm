import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HELM_DIR } from './paths.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = (message, code) => Object.assign(new Error(message), { code });

/** Durable acceptance and receipts, independent of the daemon's sockets. */
export class InputDelivery {
  #active = new Map();
  #stopped = false;
  constructor(sessions, { dir = join(HELM_DIR, 'input-delivery'), log = () => {} } = {}) {
    this.sessions = sessions;
    this.dir = dir;
    this.log = log;
  }
  #read(path) {
    // A damaged receipt must never be treated as permission to send again.
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  }
  #write(path, record) {
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, path);
    } finally { rmSync(temporary, { force: true }); }
  }
  #paths(key) {
    return { pending: join(this.dir, 'pending', `${key}.json`), receipt: join(this.dir, 'receipts', `${key}.json`) };
  }
  #result(receipt) {
    if (receipt.error) throw failure(receipt.error.message, receipt.error.code);
    return receipt.result;
  }
  receipt(messageId, caller = 'local') {
    const key = hash([caller, messageId]);
    return this.#read(this.#paths(key).receipt);
  }
  async deliver(params, caller = 'local') {
    if (this.#stopped) throw failure('Helm is restarting', 'delivery_pending');
    const { id, messageId, data, attachments = [], references = [], delivery = 'auto' } = params;
    if (typeof messageId !== 'string' || !/^[a-f0-9]{32}$/.test(messageId) || typeof id !== 'string' || typeof data !== 'string'
        || params.raw || !Array.isArray(attachments) || !Array.isArray(references)) {
      throw failure('invalid reliable message', 'invalid_argument');
    }
    const source = params.source === 'agent' ? 'agent' : 'user';
    const request = { id, data, attachments, references, delivery, ...(source === 'agent' ? { source } : {}) };
    const digest = hash(request);
    // Bind an ID to both its sender and its original target/content.
    const key = hash([caller, messageId]);
    const paths = this.#paths(key);
    const receipt = this.#read(paths.receipt);
    const pending = receipt ?? this.#read(paths.pending);
    if (pending && pending.digest !== digest) throw failure('messageId already belongs to a different message', 'delivery_conflict');
    if (receipt) return this.#result(receipt);
    if (!pending) {
      const session = this.sessions.get(id);
      if (!session.driver || session.external || session.nativeChat || session.nativeCli) {
        throw failure('this session uses terminal input', 'delivery_unsupported');
      }
      for (const folder of ['pending', 'receipts']) mkdirSync(join(this.dir, folder), { recursive: true, mode: 0o700 });
      this.#write(paths.pending, { key, digest, request, generation: session.stopGeneration ?? 0 });
    }
    return this.#apply(pending ?? this.#read(paths.pending));
  }
  #apply(record) {
    if (this.#active.has(record.key)) return this.#active.get(record.key);
    const paths = this.#paths(record.key);
    // Register before running input: concurrent retries share this promise.
    const running = Promise.resolve().then(async () => {
      if (record.digest !== hash(record.request)) throw failure('the saved message is damaged; it was not delivered', 'delivery_failed');
      const receipt = this.#read(paths.receipt);
      if (receipt) { rmSync(paths.pending, { force: true }); return this.#result(receipt); }
      if (this.#stopped) throw failure('Helm is restarting; delivery is pending', 'delivery_pending');
      let result, error;
      try {
        const { id, data, ...options } = record.request;
        const turnId = `local-message-${record.key}`;
        const state = this.sessions.turnState(id, turnId);
        const session = this.sessions.get(id);
        if (!state && (session.stopGeneration ?? 0) !== record.generation) {
          throw failure('message cancelled because the thread was stopped', 'delivery_cancelled');
        }
        if (state === 'open' || state === 'done') result = { ok: true, duplicate: true };
        else {
          if (!session.driver || session.external || session.nativeChat || session.nativeCli) {
            throw failure('the accepted message no longer has its original driven session', 'delivery_failed');
          }
          result = await this.sessions.input(id, data, { ...options, turnId });
        }
      } catch (err) {
        // Shutdown can detach a writer mid-await. Keep the pending record;
        // the next daemon checks the durable turn before doing anything.
        if (this.#stopped) throw failure('Helm is restarting; delivery is pending', 'delivery_pending');
        error = { message: String(err.message ?? err), code: err.code ?? 'delivery_failed' };
      }
      const saved = { digest: record.digest, ...(error ? { error } : { result }) };
      this.#write(paths.receipt, saved);
      rmSync(paths.pending, { force: true });
      return this.#result(saved);
    }).finally(() => this.#active.delete(record.key));
    this.#active.set(record.key, running);
    return running;
  }
  resume() {
    const dir = join(this.dir, 'pending');
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try {
        const record = this.#read(join(dir, name));
        if (record.key !== name.slice(0, -5)) throw new Error('invalid delivery record');
        void this.#apply(record).catch(error => this.log(`message recovery: ${error.message}`));
      } catch (error) { this.log(`message recovery: ${error.message}`); }
    }
  }
  stop() { this.#stopped = true; }
}
