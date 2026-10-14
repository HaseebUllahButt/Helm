import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HELM_DIR } from '../paths.js';
import { restoreFiles } from './files.js';
import { captureFilesAsync, CAPTURE_TIMEOUT_MS } from './capture.js';
import { cp } from 'node:fs/promises';

const token = () => randomBytes(16).toString('hex');
export class Checkpoints {
  constructor(dir = join(HELM_DIR, 'checkpoints'), { captureTimeoutMs = CAPTURE_TIMEOUT_MS } = {}) { this.dir = dir; this.captureTimeoutMs = captureTimeoutMs; }
  path(id) {
    if (!/^[a-f0-9]{32}$/.test(id ?? '')) throw new Error('Invalid checkpoint.');
    return join(this.dir, id);
  }
  async capture(session, ticket, events, { filesReason = null } = {}) {
    const id = token(), dir = this.path(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const all = events.tail(session.id, 0);
    const prior = all.filter(e => e.turnId !== ticket.turnId && !(e.type === 'turn.start' && e.queued && events.turnState(session.id, e.turnId) === 'open' && !all.some(echo => echo.inputId === e.turnId)));
    const checkpoint = { id, sessionId: session.id, engineSessionId: session.engineSessionId,
      history: prior, text: ticket.text, attachments: all.findLast(e => e.turnId === ticket.turnId && e.attachments)?.attachments ?? [], references: ticket.references ?? [],
      resumeAt: prior.findLast(e => e.type === 'turn.done' && e.resumeAt)?.resumeAt ?? null,
      first: !prior.some(e => e.type === 'turn.start' && !e.local && !String(e.turnId).startsWith('local-')),
      at: Date.now(), files: false };
    try {
      if (filesReason) throw new Error(filesReason);
      await captureFilesAsync(session.cwd, join(dir, 'files'), { blobDir: join(this.dir, 'blobs'), timeoutMs: this.captureTimeoutMs });
      checkpoint.files = true;
    } catch (error) { checkpoint.filesReason = error.message; }
    this.write(id, 'checkpoint.json', checkpoint);
    return checkpoint;
  }
  get(id, sessionId) {
    const saved = JSON.parse(readFileSync(join(this.path(id), 'checkpoint.json'), 'utf8'));
    if (saved.sessionId !== sessionId) throw new Error('That checkpoint belongs to another conversation.');
    return saved;
  }
  write(id, file, value) {
    const path = join(this.path(id), file);
    writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
  restore(cwd, directory, options) { restoreFiles(cwd, directory, options); }
  async captureRecoveryFiles(id, cwd) {
    await captureFilesAsync(cwd, join(this.path(id), 'recovery-files'), { blobDir: join(this.dir, 'blobs'), timeoutMs: this.captureTimeoutMs });
  }
  async archive(session, events, restore) {
    const id = token(), dir = this.path(id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.write(id, 'recovery.json', { session: structuredClone(session), events: events.tail(session.id, 0), phase: 'preparing', restore });
    const attachments = join(events.dir, `${session.id}.att`);
    if (existsSync(attachments)) await cp(attachments, join(dir, 'attachments'), { recursive: true });
    if (restore) await this.captureRecoveryFiles(id, session.cwd);
    return id;
  }
  recover(events, index) {
    const recovered = [];
    if (!existsSync(this.dir)) return recovered;
    for (const id of readdirSync(this.dir)) {
      if (!/^[a-f0-9]{32}$/.test(id)) continue;
      const file = join(this.path(id), 'recovery.json');
      if (!existsSync(file)) continue;
      const recovery = JSON.parse(readFileSync(file, 'utf8'));
      if (recovery.phase !== 'applying') continue;
      // An interrupted transaction is rolled back before any agent reconnects.
      // If that cannot be done, fail startup rather than run inconsistent state.
      if (recovery.restore) this.restore(recovery.session.cwd, join(this.path(id), 'recovery-files'), { owned: recovery.owned ?? [], lockToken: id });
      events.replace(recovery.session.id, recovery.events);
      index.set(recovery.session.id, recovery.session);
      recovered.push(id);
    }
    return recovered;
  }
  finishRecovery(ids) {
    for (const id of ids) {
      const recovery = JSON.parse(readFileSync(join(this.path(id), 'recovery.json'), 'utf8'));
      this.write(id, 'recovery.json', { ...recovery, phase: 'recovered' });
    }
  }
}
