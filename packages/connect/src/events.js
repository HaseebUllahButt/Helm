import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HELM_DIR } from './paths.js';

/**
 * What happened in a session, in order.
 *
 * A driver turns an agent's own protocol into a small vocabulary of events
 * (text arriving, a tool starting, a permission being asked for). Every
 * event gets a sequence number and is appended here, so that a phone that
 * was asleep can ask "everything after 412" instead of re-reading a
 * transcript, and so that a daemon restart does not lose the conversation.
 *
 * One file per session under ~/.helm/events. Only the tail is kept: a
 * session that ran for a week is not something anyone scrolls through on a
 * phone, and the agent's own transcript still has all of it.
 */

export const EVENTS_DIR = join(HELM_DIR, 'events');
const KEEP = 2000;

export class EventLog {
  /** sessionId -> { seq, events[] } */
  #logs = new Map();

  constructor(dir = EVENTS_DIR) {
    this.dir = dir;
  }

  #file(id) { return join(this.dir, `${id}.jsonl`); }

  #open(id) {
    let log = this.#logs.get(id);
    if (log) return log;
    log = { seq: 0, events: [] };
    const file = this.#file(id);
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      for (const line of lines.slice(-KEEP)) {
        try { log.events.push(JSON.parse(line)); } catch { /* a torn last line after a crash */ }
      }
      if (log.events.length) log.seq = log.events[log.events.length - 1].seq;
      // A file that outgrew the tail is rewritten to just the tail, once.
      if (lines.length > KEEP) writeFileSync(file, log.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    }
    this.#logs.set(id, log);
    return log;
  }

  /** Append one event; returns it with `seq` and `at` filled in. */
  append(id, event) {
    const log = this.#open(id);
    const full = { seq: ++log.seq, at: Date.now(), ...event };
    log.events.push(full);
    if (log.events.length > KEEP) log.events.splice(0, log.events.length - KEEP);
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.#file(id), JSON.stringify(full) + '\n', { mode: 0o600 });
    return full;
  }

  /** Events with a sequence number greater than `since`. */
  since(id, since = 0) {
    return this.#open(id).events.filter((e) => e.seq > since);
  }

  last(id) { return this.#open(id).seq; }

  /**
   * Permission requests nobody has answered yet. Derived from the log rather
   * than kept separately so that it is right after a restart too - a prompt
   * the agent is still holding open must not vanish from the phone.
   */
  pending(id) {
    const open = new Map();
    for (const e of this.#open(id).events) {
      if (e.type === 'permission.request') open.set(e.requestId, e);
      else if (e.type === 'permission.resolved') open.delete(e.requestId);
    }
    return [...open.values()];
  }

  /** The turn still running, if the log ends without its turn.done. */
  openTurn(id) {
    const events = this.#open(id).events;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'turn.done') return null;
      if (events[i].type === 'turn.start') return events[i];
    }
    return null;
  }

  remove(id) {
    this.#logs.delete(id);
    rmSync(this.#file(id), { force: true });
  }
}
