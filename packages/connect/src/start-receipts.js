import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HELM_DIR } from './paths.js';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message, code) => Object.assign(new Error(message), { code });

/** Reserve before any setup; never repeat an uncertain start after a crash. */
export class StartReceipts {
  active = new Map();
  constructor(sessions, dir = join(HELM_DIR, 'start-receipts')) { this.sessions = sessions; this.dir = dir; }
  async start(params, caller = 'local') {
    const { startId, ...request } = params;
    if (startId === undefined) return this.sessions.start(request);
    if (!/^[a-f0-9]{32}$/.test(startId)) throw fail('Choose a valid start number.', 'invalid_argument');
    const key = hash([caller, startId]), digest = hash(request);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, `${key}.json`);
    const write = record => {
      writeFileSync(`${path}.tmp`, JSON.stringify(record), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    };
    const held = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    if (held && held.digest !== digest) throw fail('This start number belongs to another chat.', 'start_conflict');
    if (this.active.has(key)) return this.active.get(key);
    if (held) {
      if (held.error && held.retrySafe !== true) throw fail(held.error.message, held.error.code);
      // A saved result also prevents a deleted chat from being created again.
      if (held.result) return held.result;
      let session;
      try { session = this.sessions.get(held.id); } catch { /* no saved chat */ }
      if (session) { write({ ...held, result: session }); return session; }
      if (!held.error || held.retrySafe !== true) throw fail('Helm stopped during chat setup. Check the folder before starting another chat.', 'start_uncertain');
    }
    const record = { digest, id: held?.id ?? randomBytes(6).toString('hex') };
    write(record);
    const running = Promise.resolve().then(async () => {
      let session;
      try {
        session = await this.sessions.start({ ...request, reservedSessionId: record.id });
      } catch (error) {
        // Keep the reservation even when recording a failure fails.
        write({ ...record, retrySafe: error.startRetrySafe === true, error: { message: error.message, code: error.code ?? 'start_failed' } });
        throw error;
      }
      write({ ...record, result: session });
      return session;
    });
    this.active.set(key, running);
    try { return await running; } finally { this.active.delete(key); }
  }
}
