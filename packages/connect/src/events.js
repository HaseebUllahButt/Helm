import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
 *
 * Image bytes do **not** live in that file. A megabyte of base64 on one
 * line would be re-read and re-serialised on every open, and the log is
 * read whole. Attachments are written once to `<id>.att/<sha>.bin` and the
 * event keeps only a reference; `since()` puts the bytes back before they
 * go to a client, so nothing upstream knows the difference. That is also
 * what makes an image survive a daemon restart - the previous design
 * truncated the base64 to 80 characters before writing it, so a reopened
 * session showed the owner's own photo as a broken thumbnail forever.
 */

export const EVENTS_DIR = join(HELM_DIR, 'events');
const KEEP = 2000;

/**
 * What one reply may weigh, and what one event may weigh inside it.
 *
 * Both exist because of a real chat: a devin thread on the owner's VM held
 * 822 events and 6.8MB, 95% of it in `changes`. Asked for the first 500
 * events - the page size the app used - the daemon answered with 5MB. On
 * loopback that is a second and a half; from the laptop, over the hub, it was
 * 58 seconds, and the app gives up at 20. The chat was unopenable, and the
 * error it showed ("session.events timed out") described the symptom of a
 * reply nobody could ever have wanted.
 *
 * So a page is measured in bytes rather than events, and a single event is
 * capped before it goes anywhere. A data-channel frame is fragmented at 16KB
 * (see `peer.js`), so 192KB is a dozen chunks: small enough to arrive on a
 * phone link, big enough that paging is not the cost.
 */
const MAX_PAGE = 192_000;
/**
 * An ACP diff is the whole old file as `-` lines and the whole new file as
 * `+` lines, so one edit of a 2000-line file is 140KB - and the same array is
 * repeated on the item's start, its updates and its done. Nobody reads that
 * on a phone; the app shows it in a fold. 8KB is a long diff.
 */
const MAX_DIFF = 8_000;
const MAX_OUTPUT = 32_000;
const MAX_ERROR = 4_000;
const MAX_INPUT = 4_000;

const clip = (s, n) =>
  (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);

/**
 * One event, small enough to send.
 *
 * Drivers clip what they write, but they have not always (the ACP driver's
 * diffs were unbounded until 2026-09-17) and a log on disk outlives the
 * version that wrote it - so the wire is where the cap has to be enforced.
 * Attachments are left alone: an image is the message, and it is already
 * bounded by what a phone will paste.
 */
export function forWire(event) {
  const heavy = event.changes?.length
    || typeof event.output === 'string'
    || typeof event.error === 'string'
    || (event.input && typeof event.input === 'object');
  if (!heavy) return event;
  const out = { ...event };
  if (out.changes?.length) out.changes = out.changes.map((c) => (c?.diff ? { ...c, diff: clip(c.diff, MAX_DIFF) } : c));
  if (typeof out.output === 'string') out.output = clip(out.output, MAX_OUTPUT);
  if (typeof out.error === 'string') out.error = clip(out.error, MAX_ERROR);
  if (out.input && typeof out.input === 'object' && !Array.isArray(out.input)) {
    let input = out.input;
    for (const [k, v] of Object.entries(input)) {
      if (typeof v === 'string' && v.length > MAX_INPUT) {
        if (input === out.input) input = { ...out.input };
        input[k] = clip(v, MAX_INPUT);
      }
    }
    out.input = input;
  }
  return out;
}

/**
 * The first index at or after `from` that starts a turn.
 *
 * Used to move a window's front edge off a half-turn. `from` 0 is left alone:
 * there is nothing in front of it to have cut, and a short log that simply
 * begins mid-turn should not lose its beginning to tidiness.
 */
function alignToTurn(events, from) {
  if (from <= 0) return 0;
  for (let i = from; i < events.length; i++) if (events[i].type === 'turn.start') return i;
  return from;
}

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
      if (lines.length > KEEP) {
        writeFileSync(file, log.events.map((e) => JSON.stringify(e)).join('\n') + '\n');
        this.#sweep(id, log.events);
      }
    }
    this.#logs.set(id, log);
    return log;
  }

  #attDir(id) { return join(this.dir, `${id}.att`); }

  /**
   * Park one attachment's bytes on disk and hand back the reference that
   * goes in the event. Content-addressed, so the same image pasted twice
   * costs one copy.
   */
  putAttachment(id, { filename, mime, data }) {
    const bytes = Buffer.from(String(data ?? ''), 'base64');
    const ref = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
    const dir = this.#attDir(id);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${ref}.bin`);
    if (!existsSync(file)) writeFileSync(file, bytes, { mode: 0o600 });
    return { filename, mime, bytes: bytes.length, ref };
  }

  /**
   * An event as a client should see it: references turned back into bytes.
   * A blob that has been swept leaves `data` unset rather than a broken
   * one - the app draws a "no longer stored" tile for that.
   */
  #hydrate(id, event) {
    if (!Array.isArray(event.attachments) || !event.attachments.length) return event;
    const attachments = event.attachments.map((a) => {
      if (a?.data || !a?.ref) return a;
      try { return { ...a, data: readFileSync(join(this.#attDir(id), `${a.ref}.bin`)).toString('base64') }; }
      catch { return { ...a, missing: true }; }
    });
    return { ...event, attachments };
  }

  /**
   * Drop blobs no surviving event refers to. The log keeps only its tail,
   * so without this an image would outlive the message that carried it and
   * the directory would only ever grow.
   */
  #sweep(id, events) {
    const live = new Set();
    for (const e of events) for (const a of e.attachments ?? []) if (a?.ref) live.add(`${a.ref}.bin`);
    let names = [];
    try { names = readdirSync(this.#attDir(id)); } catch { return; }
    for (const name of names) {
      if (!live.has(name)) rmSync(join(this.#attDir(id), name), { force: true });
    }
  }

  /** Append one event; returns it with `seq` and `at` filled in. */
  append(id, event) {
    const log = this.#open(id);
    const full = { seq: ++log.seq, at: Date.now(), ...event };
    log.events.push(full);
    if (log.events.length > KEEP) {
      const dropped = log.events.splice(0, log.events.length - KEEP);
      if (dropped.some((e) => e.attachments?.length)) this.#sweep(id, log.events);
    }
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.#file(id), JSON.stringify(full) + '\n', { mode: 0o600 });
    return full;
  }

  /** Events with a sequence number greater than `since`. */
  since(id, since = 0) {
    return this.#open(id).events
      .filter((e) => e.seq > since)
      .map((e) => this.#hydrate(id, e));
  }

  /**
   * A window of the log, shaped for a client and small enough to send.
   *
   * Three jobs, in one place because they have to agree: which events, how
   * heavy each may be, and where to stop.
   *
   *   - `tail` takes the *end* of the conversation rather than the start.
   *     That is the whole of "a chat opens instantly": what you look at when
   *     a thread opens is the last thing that happened, and paging forward
   *     from event 1 spends the entire link on history you have to scroll
   *     past. What came before is counted and reported, never sent unasked.
   *   - `before` walks backwards from there, for "earlier in this
   *     conversation".
   *   - Everything is budgeted in bytes and hydrated only if it is actually
   *     going out, so an image four turns back is not read off disk and
   *     base64'd to be thrown away.
   *
   * A window is aligned to a `turn.start` where one is in reach, so the
   * oldest thing on screen is a whole exchange rather than a reply whose
   * question is missing. The reducers on both sides tolerate a fragment -
   * they drop items they have no start for - but tolerating it and showing
   * it are different things.
   */
  window(id, { since = 0, tail = 0, before = 0, maxBytes = MAX_PAGE } = {}) {
    const all = this.#open(id).events;
    let list = all;
    if (before > 0) list = list.filter((e) => e.seq < before);
    if (since > 0) list = list.filter((e) => e.seq > since);

    const shaped = (e) => forWire(this.#hydrate(id, e));
    let events = [];
    let hasMore = false;

    if (tail > 0 || before > 0) {
      // The newest end of the window, taken backwards so the budget falls off
      // the front - the oldest events are the ones to lose, never the last
      // thing the agent said.
      const wanted = tail > 0 ? Math.max(0, list.length - tail) : 0;
      list = list.slice(alignToTurn(list, wanted));
      let bytes = 0;
      let front = list.length;
      for (let i = list.length - 1; i >= 0; i--) {
        const e = shaped(list[i]);
        const n = JSON.stringify(e).length;
        // Always at least one: a single event over the budget still has to
        // move, or the client asks forever and never advances.
        if (events.length && bytes + n > maxBytes) break;
        events.unshift(e); bytes += n; front = i;
      }
      // Something was cut off the front, so start the window on a whole
      // exchange if one is in reach. No turn start in the window at all means
      // a long single turn: a fragment beats an empty screen.
      if (front > 0) {
        const k = events.findIndex((e) => e.type === 'turn.start');
        if (k > 0) events.splice(0, k);
      }
    } else {
      let bytes = 0;
      for (const raw of list) {
        const e = shaped(raw);
        const n = JSON.stringify(e).length;
        if (events.length && bytes + n > maxBytes) { hasMore = true; break; }
        events.push(e); bytes += n;
      }
    }

    return {
      events,
      hasMore,
      firstSeq: events[0]?.seq ?? 0,
      // The oldest event this machine still holds. A client compares it with
      // the front of its own window to know whether there is anything behind
      // what it is showing - one number, true for every shape of request,
      // instead of a count that only the first reply could have been right
      // about.
      logFirst: all[0]?.seq ?? 0,
    };
  }

  /**
   * The last `n` events, raw.
   *
   * For readers that derive one line from a log - the digest's "what it last
   * did" - rather than clients that display it. No hydration: putting a
   * megabyte of image back together to look at the text beside it is what
   * made a digest of a busy machine expensive.
   */
  tail(id, n = 400) {
    const events = this.#open(id).events;
    return n > 0 && events.length > n ? events.slice(-n) : events;
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
    rmSync(this.#attDir(id), { force: true, recursive: true });
  }
}
