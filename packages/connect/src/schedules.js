import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HELM_DIR } from './paths.js';

export class Schedules {
  constructor({ sessions, directory = HELM_DIR, now = Date.now } = {}) {
    this.sessions = sessions;
    this.directory = directory;
    this.filename = join(directory, 'schedules.json');
    this.now = now;
    this.records = [];
    this.running = new Set();
    this.generation = 0;
    if (existsSync(this.filename)) {
      const data = JSON.parse(readFileSync(this.filename, 'utf8'));
      if (!Array.isArray(data)) throw new Error('saved schedules are invalid');
      this.records = data;
    }
  }

  persist() {
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(`${this.filename}.tmp`, JSON.stringify(this.records), { mode: 0o600 });
    renameSync(`${this.filename}.tmp`, this.filename);
  }

  list(sessionId) {
    return { schedules: this.records.filter((record) => !sessionId || record.sessionId === sessionId).map((record) => ({ ...record })), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }

  save(input) {
    const current = input.id ? this.records.find((record) => record.id === input.id) : null;
    if (input.id && !current) throw new Error('schedule not found');
    if (current && this.running.has(current.id)) throw new Error('wait for the current dispatch to finish');
    const next = { ...current, ...input };
    const session = this.sessions.get(next.sessionId);
    if (!session.driver || session.external || session.archived || session.delegation) throw new Error('choose an active Helm thread for scheduled work');
    if (typeof next.prompt !== 'string' || !next.prompt.trim() || next.prompt.length > 32000) throw new Error('a scheduled task needs 1–32000 characters');
    if (!Number.isInteger(next.intervalMinutes) || next.intervalMinutes < 5 || next.intervalMinutes > 525600) throw new Error('choose an interval between 5 minutes and one year');
    if (next.enabled != null && typeof next.enabled !== 'boolean') throw new Error('enabled must be true or false');
    if (next.nextRunAt != null && (!Number.isFinite(next.nextRunAt) || next.nextRunAt <= 0)) throw new Error('invalid next run time');
    const record = {
      id: current?.id ?? randomBytes(8).toString('hex'), sessionId: session.id,
      name: String(next.name || 'Scheduled task').slice(0, 100), prompt: next.prompt.trim(),
      intervalMinutes: next.intervalMinutes, enabled: next.enabled ?? true,
      nextRunAt: next.nextRunAt ?? this.now() + next.intervalMinutes * 60000,
      createdAt: current?.createdAt ?? this.now(), lastRunAt: current?.lastRunAt,
      lastTurnId: current?.lastTurnId, lastError: current?.lastError, dispatching: current?.dispatching,
    };
    this.records = [...this.records.filter((entry) => entry.id !== record.id), record];
    this.persist();
    return { schedule: { ...record } };
  }

  remove(id) {
    if (this.running.has(id)) throw new Error('wait for the current dispatch to finish');
    this.records = this.records.filter((record) => record.id !== id);
    this.persist();
    return { ok: true };
  }

  async run(id, manual = true) {
    const record = this.records.find((entry) => entry.id === id);
    if (!record) throw new Error('schedule not found');
    if (this.running.has(id)) return { skipped: true, reason: 'This task is already dispatching.' };
    const session = this.sessions.get(record.sessionId);
    if (session.archived || session.stoppedAt || session.recovery || !this.sessions.canReturnTask(session.id)) {
      if (!manual) { record.nextRunAt = this.now() + 60000; this.persist(); }
      return { skipped: true, reason: 'The thread is busy, stopped, or needs attention.' };
    }
    this.running.add(id);
    const turnId = record.dispatching || `local-schedule-${id}-${this.now()}-${randomBytes(3).toString('hex')}`;
    record.dispatching = turnId;
    this.persist();
    try {
      await this.sessions.input(session.id, record.prompt, { turnId, delivery: 'queue', source: 'schedule' });
      record.lastTurnId = turnId;
      record.lastRunAt = this.now();
      record.nextRunAt = this.now() + record.intervalMinutes * 60000;
      delete record.lastError;
      delete record.dispatching;
      this.persist();
      return { ok: true, sessionId: session.id, turnId };
    } catch (error) {
      record.lastError = error.message;
      record.enabled = false;
      delete record.dispatching;
      this.persist();
      throw error;
    } finally { this.running.delete(id); }
  }

  async tick() {
    const generation = this.generation;
    for (const record of [...this.records]) {
      if (generation !== this.generation) break;
      if (!record.enabled || record.nextRunAt > this.now() || this.running.has(record.id)) continue;
      try { await this.run(record.id, false); }
      catch (error) {
        record.lastError = error.message;
        record.enabled = false;
        this.persist();
      }
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 15000);
    this.timer.unref?.();
  }

  stop() { this.generation += 1; clearInterval(this.timer); this.timer = null; }
}
