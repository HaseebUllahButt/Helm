import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HELM_DIR } from './paths.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = message => Object.assign(new Error(message), { code: 'invalid_argument' });

/** Approvals cannot be replayed after a crash: the agent may already have acted. */
export class ActionDelivery {
  active = new Map();
  constructor(sessions, { dir = join(HELM_DIR, 'action-delivery') } = {}) {
    this.sessions = sessions;
    this.dir = dir;
  }
  path(actionId, caller) {
    if (!/^[a-f0-9]{32}$/.test(actionId ?? '')) throw fail('Choose a valid action number.');
    return join(this.dir, hash([caller ?? 'local', actionId]) + '.json');
  }
  read(path) { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; }
  save(path, value) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const temp = path + '.' + randomBytes(8).toString('hex');
    try {
      writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      renameSync(temp, path);
    } finally { rmSync(temp, { force: true }); }
  }
  status(actionId, caller) {
    const record = this.read(this.path(actionId, caller));
    return record ? { state: record.state, result: record.result, error: record.error } : { state: 'missing' };
  }
  async deliver(params, caller) {
    const { actionId, id, requestId, decision } = params;
    if (typeof id !== 'string' || typeof requestId !== 'string' || !decision || typeof decision !== 'object') {
      throw fail('Choose a valid approval.');
    }
    const path = this.path(actionId, caller);
    const digest = hash({ id, requestId, decision });
    const held = this.read(path);
    if (held && held.digest !== digest) throw fail('This action number belongs to another approval.');
    if (this.active.has(path)) return this.active.get(path);
    if (held) return this.status(actionId, caller);
    // Save before calling the agent. A pending record is never permission to replay.
    this.save(path, { digest, state: 'checking' });
    const running = Promise.resolve().then(async () => {
      try {
        const result = await this.sessions.answer(id, requestId, decision);
        this.save(path, { digest, state: 'done', result });
      } catch (error) {
        this.save(path, { digest, state: 'checking', error: String(error.message ?? error) });
      }
      return this.status(actionId, caller);
    }).finally(() => this.active.delete(path));
    this.active.set(path, running);
    return running;
  }
}
