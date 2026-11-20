import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HELM_DIR } from './paths.js';

/**
 * `helm phone`: an agent asks the owner for something only the phone has:
 * an answer, a photo, the location, or a one-time sign-in code. The owner
 * sees a card in the chat (and in the waiting box, and as a notification)
 * on every controller, and sends it or refuses.
 *
 * The cards are Helm's own (Sessions.showHelmAsk), like helm sudo. The app
 * sends answers with `phone.give` and photos with `phone.photo`, never
 * through `session.answer`: those answers are kept in browser storage until
 * they arrive, and a photo or a sign-in code must not be. A Refuse can come
 * either way.
 *
 * Open requests are kept on disk, so a Helm restart shows the same card and
 * the waiting `helm phone` gets the answer. An answer is kept only until the
 * agent reads it. Deleting or stopping the chat closes its requests.
 * docs/features/phone.md has the rules and the traps.
 */

export const PHONE_DIR = join(HELM_DIR, 'phone');
export const TYPES = ['ask', 'photo', 'location', 'code'];
const REQUEST_ID = /^phone-[A-Za-z0-9_-]{8,64}$/;
/** One `phone.wait` call, short enough for any RPC on the way. */
const WAIT_SLICE_MS = 20_000;
/** A card whose `helm phone` stopped asking is closed: nobody waits for it. */
const GONE_MS = 3 * 60_000;
export const DEFAULT_TIMEOUT_MIN = 30;
export const MAX_TIMEOUT_MIN = 24 * 60;
/** A finished request stays this long for a late read; its record a day. */
const KEEP_RESULT_MS = 10 * 60_000;
const KEEP_RECORD_MS = 24 * 3600_000;
export const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
const PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif' };
const OPEN = 'asking';
const ENDED = ['answered', 'refused', 'cancelled', 'timeout'];

const clean = (v, max) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const sentence = (v) => v && !/[.!?]$/.test(v) ? `${v}.` : v;
const noLongerOpen = () => Object.assign(new Error('This request is no longer open.'), { deliveryNotSent: true });

/** What the card says at the top, for each kind of request. */
export function cardTitle(type, site = '') {
  if (type === 'photo') return 'Send a photo';
  if (type === 'location') return 'Share your location';
  if (type === 'code') return site ? `Send the sign-in code for ${site}` : 'Send a sign-in code';
  return 'Answer a question';
}

/**
 * The code in a pasted or shared text message: the first group of 4 to 10
 * digits (dashes and spaces inside are dropped), else a short word with a
 * digit in it. The whole text when nothing looks like a code.
 */
export function findCode(text) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  if (/^[A-Za-z0-9-]{3,12}$/.test(t)) return t;
  const digits = /(?<![\d-])(\d[\d -]{2,12}\d)(?![\d-])/.exec(t)?.[1]?.replace(/[ -]/g, '');
  if (digits && digits.length >= 4 && digits.length <= 10) return digits;
  const word = /\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{4,10}\b/.exec(t)?.[0];
  return word ?? t.slice(0, 200);
}

/** The requests on this machine. `sessions` is Sessions (sessions.js). */
export class PhoneRequests {
  #requests = new Map();
  #records;
  #recordFile;
  #sweep;
  #onSession;

  constructor({ sessions, envId = () => null, dir = PHONE_DIR, uploads = join(HELM_DIR, 'uploads'), log = () => {}, now = Date.now } = {}) {
    Object.assign(this, { sessions, envId, dir, uploads, log, now });
    this.#recordFile = join(dir, 'requests.json');
    this.#records = this.#readRecords();
    // The last Helm stopped with these cards open: show them again. The
    // waiting `helm phone` asks again with the same id and gets its answer.
    for (const [requestId, record] of Object.entries(this.#records)) {
      if (record.state !== OPEN) continue;
      const r = { ...record, requestId, waiters: new Set(), polledAt: this.now() };
      if (!this.#chat(r.sessionId)) { this.#finish(r, 'cancelled', { message: 'The chat ended.' }); continue; }
      this.#requests.set(requestId, r);
      this.#show(r);
    }
    // Deleting or stopping a chat closes its requests.
    this.#onSession = (s) => { if (s?.id) this.#chatChanged(s); };
    sessions?.on?.('session', this.#onSession);
    this.#sweep = setInterval(() => this.#clean(), 30_000);
    this.#sweep.unref?.();
  }

  stop() {
    clearInterval(this.#sweep);
    this.sessions?.off?.('session', this.#onSession);
    for (const r of this.#requests.values()) this.#wake(r);
  }

  owns(requestId) { return typeof requestId === 'string' && REQUEST_ID.test(requestId); }

  // ------------------------------------------------------------ records

  #readRecords() {
    try {
      const data = JSON.parse(readFileSync(this.#recordFile, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch { return {}; }
  }

  #writeRecords() {
    const cutoff = this.now() - KEEP_RECORD_MS;
    for (const [id, record] of Object.entries(this.#records)) {
      if (record.state !== OPEN && !(record.endedAt > cutoff)) delete this.#records[id];
    }
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const temp = `${this.#recordFile}.${randomBytes(6).toString('hex')}`;
      writeFileSync(temp, JSON.stringify(this.#records), { mode: 0o600 });
      renameSync(temp, this.#recordFile);
    } catch (error) { this.log(`phone: could not save requests: ${error.message}`); }
  }

  /** What survives a restart. An answer stays only until the agent reads it. */
  #record(r) {
    const keep = ['sessionId', 'type', 'question', 'choices', 'why', 'site', 'chat', 'at', 'until', 'state', 'endedAt', 'message', 'back'];
    const record = Object.fromEntries(keep.filter((k) => r[k] != null && r[k] !== '').map((k) => [k, r[k]]));
    if (r.answer && !r.readAt) record.answer = r.answer;
    this.#records[r.requestId] = record;
    this.#writeRecords();
  }

  // ------------------------------------------------------------ cards

  #chat(sessionId) {
    try { return this.sessions.get(sessionId); } catch { return null; }
  }

  #card(r) {
    return {
      requestId: r.requestId, kind: 'tool', tool: 'phone',
      title: cardTitle(r.type, r.site),
      ...(r.why ? { reason: sentence(r.why) } : {}),
      phone: {
        type: r.type,
        ...(r.question ? { question: r.question } : {}),
        ...(r.choices?.length ? { choices: r.choices } : {}),
        ...(r.site ? { site: r.site } : {}),
        ...(r.chat ? { chat: r.chat } : {}),
        // Where the app sends the answer: the machine of this chat.
        ...(this.envId() ? { envId: this.envId() } : {}),
        until: r.until,
      },
      options: [
        { id: 'send', role: 'allow', label: 'Send' },
        { id: 'refuse', role: 'deny', label: 'Refuse' },
      ],
      defaultTo: 'allow', allowEdit: false, ownLabels: true, at: r.at,
    };
  }

  #show(r) {
    try { this.sessions.showHelmAsk(r.sessionId, this.#card(r)); }
    catch (error) { this.log(`phone: could not show a card in ${r.sessionId}: ${error.message}`); }
  }

  #closeCard(r, decision) {
    try { this.sessions.closeHelmAsk(r.sessionId, r.requestId, decision, r.back); }
    catch (error) { this.log(`phone: could not close a card in ${r.sessionId}: ${error.message}`); }
  }

  // ------------------------------------------------------------ requests

  #wake(r) { for (const done of [...(r.waiters ?? [])]) done(); }

  #finish(r, state, fields = {}) {
    if (ENDED.includes(r.state)) return;
    Object.assign(r, { state, ...fields, endedAt: this.now() });
    this.#closeCard(r, state === 'answered' ? 'allow' : state === 'refused' ? 'deny' : 'cancelled');
    if (r.partFile) { rmSync(r.partFile, { force: true }); r.partFile = null; }
    this.#record(r);
    this.#wake(r);
  }

  #told(r) {
    return {
      requestId: r.requestId, state: r.state,
      ...(r.state === 'answered' && r.answer ? { answer: r.answer } : {}),
      ...(r.message ? { message: r.message } : {}),
      ...(r.state === OPEN ? { until: r.until } : {}),
    };
  }

  /** What the record says about a request this Helm no longer holds. */
  #fromRecord(requestId, sessionId) {
    const record = this.#records[requestId];
    if (!record || record.state === OPEN) return null;
    if (sessionId && record.sessionId !== sessionId) throw new Error('This request belongs to another chat.');
    if (record.state === 'answered' && !record.answer) return { requestId, state: 'cancelled', message: 'The answer was read already.' };
    return { requestId, state: record.state, ...(record.answer ? { answer: record.answer } : {}), ...(record.message ? { message: record.message } : {}) };
  }

  async ask(p) {
    const { sessionId, requestId } = p ?? {};
    if (!this.owns(requestId)) throw new Error('A phone request needs a request id.');
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('Run helm phone in a Helm chat.');
    const type = p.type;
    if (!TYPES.includes(type)) throw new Error(`Ask for one of: ${TYPES.join(', ')}.`);
    const question = clean(p.question, 1000);
    if (type === 'ask' && !question) throw new Error('Give the question: helm phone ask "<question>"');
    const choices = Array.isArray(p.choices) ? [...new Set(p.choices.map((c) => clean(c, 120)).filter(Boolean))].slice(0, 9) : [];
    const minutes = Number.isFinite(p.timeoutMinutes) && p.timeoutMinutes > 0 ? Math.min(p.timeoutMinutes, MAX_TIMEOUT_MIN) : DEFAULT_TIMEOUT_MIN;

    const held = this.#requests.get(requestId);
    if (held) {
      if (held.sessionId !== sessionId) throw new Error('This request belongs to another chat.');
      held.polledAt = this.now();
      if (held.state === OPEN) this.#show(held);
      return this.#told(held);
    }
    const known = this.#fromRecord(requestId, sessionId);
    if (known) return known;
    const session = this.#chat(sessionId);
    if (!session || session.adopted) throw new Error('Run helm phone in a Helm chat on this machine.');
    const r = {
      requestId, sessionId, type, question, choices, why: clean(p.why, 500), site: clean(p.site, 120),
      chat: clean(session.title || session.name, 120),
      at: this.now(), until: this.now() + minutes * 60_000,
      state: OPEN, waiters: new Set(), polledAt: this.now(),
      back: ['working', 'idle'].includes(session.status) ? session.status : 'working',
    };
    this.#requests.set(requestId, r);
    this.#record(r);
    this.#show(r);
    return this.#told(r);
  }

  async wait(p) {
    const { requestId } = p ?? {};
    if (!this.owns(requestId)) throw new Error('A phone request needs a request id.');
    const slice = Number.isInteger(p?.wait) ? Math.max(0, Math.min(p.wait, WAIT_SLICE_MS)) : WAIT_SLICE_MS;
    const r = this.#requests.get(requestId);
    if (!r) return this.#fromRecord(requestId) ?? { requestId, state: 'unknown' };
    r.polledAt = this.now();
    // A chat that lost the card (its agent restarted) gets it back.
    if (r.state === OPEN && !this.sessions.events.pending(r.sessionId).some((x) => x.requestId === requestId)) this.#show(r);
    if (r.state === OPEN && slice) {
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); r.waiters.delete(done); resolve(); };
        const timer = setTimeout(done, Math.min(slice, Math.max(0, r.until - this.now()) + 50));
        r.waiters.add(done);
      });
    }
    if (r.state === OPEN && this.now() >= r.until) this.#finish(r, 'timeout', { message: 'The owner did not answer in time.' });
    r.polledAt = this.now();
    const told = this.#told(r);
    if (r.state !== OPEN && !r.readAt) { r.readAt = this.now(); this.#record(r); }
    return told;
  }

  /** The agent stopped waiting (Ctrl+C), or the owner closed it with `helm phone cancel`. */
  cancel(p) {
    const r = this.#requests.get(p?.requestId);
    if (!r) return this.#fromRecord(p?.requestId) ?? { requestId: p?.requestId, state: 'unknown' };
    if (r.state === OPEN) this.#finish(r, 'cancelled', { message: clean(p?.message, 200) || 'The agent stopped asking.' });
    return this.#told(r);
  }

  /** Open requests on this machine, for `helm phone list`. */
  list() {
    return [...this.#requests.values()].filter((r) => r.state === OPEN)
      .map((r) => ({ requestId: r.requestId, sessionId: r.sessionId, chat: r.chat || null, type: r.type, title: cardTitle(r.type, r.site),
        ...(r.question ? { question: r.question } : {}), ...(r.why ? { why: r.why } : {}), at: r.at, until: r.until }));
  }

  #open(requestId, sessionId) {
    const r = this.#requests.get(requestId);
    if (!r || r.state !== OPEN || (sessionId && r.sessionId !== sessionId)) throw noLongerOpen();
    return r;
  }

  /**
   * A Refuse, or a typed answer, from `session.answer` (the waiting box, a
   * notification, an older app). Anything else is sent from the card.
   */
  async answer(id, requestId, decision = {}) {
    const r = this.#requests.get(requestId);
    if (!r || r.sessionId !== id || r.state !== OPEN) {
      try { this.sessions.closeHelmAsk(id, requestId, 'cancelled', r?.back); } catch { /* gone */ }
      throw noLongerOpen();
    }
    if (decision.option === 'deny') { this.#finish(r, 'refused', note(decision.message)); return { ok: true }; }
    const typed = typeof decision.message === 'string' ? decision.message
      : Object.values(decision.answers ?? {}).find((v) => typeof v === 'string') ?? '';
    if (r.type === 'ask' && typed.trim()) return this.give({ requestId, text: typed });
    if (r.type === 'code' && typed.trim()) return this.give({ requestId, code: typed });
    throw Object.assign(new Error('Answer this on its card in the chat.'), { deliveryNotSent: true });
  }

  /** The owner's answer from the card: text, a code, a location, or a refusal. */
  give(p = {}) {
    const r = this.#open(p.requestId, p.sessionId);
    if (p.refuse) { this.#finish(r, 'refused', note(p.note)); return { ok: true }; }
    let answer;
    if (r.type === 'ask') {
      const text = typeof p.text === 'string' ? p.text.trim().slice(0, 4000) : '';
      if (!text) throw new Error('Type or choose an answer.');
      answer = { text, ...(r.choices?.includes(text) ? { choice: r.choices.indexOf(text) + 1 } : {}) };
    } else if (r.type === 'code') {
      const code = findCode(p.code);
      if (!code) throw new Error('Paste or type the code.');
      answer = { code };
    } else if (r.type === 'location') {
      const lat = Number(p.latitude), lon = Number(p.longitude), acc = Number(p.accuracy);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('The phone did not give a location.');
      answer = { latitude: lat, longitude: lon, ...(Number.isFinite(acc) && acc >= 0 ? { accuracy: Math.round(acc) } : {}) };
    } else throw new Error('Send the photo from the card.');
    this.#finish(r, 'answered', { answer });
    return { ok: true };
  }

  /**
   * One piece of a photo from the card, base64. Pieces come in order from
   * 0; piece 0 again starts over. The last piece saves the file with the
   * chat's other uploads (deleted with the chat) and answers the request.
   */
  photo(p = {}) {
    const r = this.#open(p.requestId, p.sessionId);
    if (r.type !== 'photo') throw new Error('This request does not want a photo.');
    const part = Number.isInteger(p.part) && p.part >= 0 ? p.part : -1;
    if (part !== 0 && part !== r.nextPart) throw new Error('A piece of the photo was lost. Send it again.');
    const ext = PHOTO_TYPES[String(p.mime ?? '').toLowerCase()];
    if (part === 0) {
      if (!ext) throw new Error('Send a JPEG, PNG, WebP, GIF or HEIC photo.');
      if (r.partFile) rmSync(r.partFile, { force: true });
      const folder = join(this.uploads, r.sessionId);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      r.partFile = join(folder, `.${r.requestId}.part`);
      r.photoExt = ext; r.photoBytes = 0;
      writeFileSync(r.partFile, '', { mode: 0o600 });
    }
    const data = Buffer.from(typeof p.data === 'string' ? p.data : '', 'base64');
    if (r.photoBytes + data.length > MAX_PHOTO_BYTES) {
      rmSync(r.partFile, { force: true }); r.partFile = null; r.nextPart = 0;
      throw new Error('The photo is larger than 20 MB.');
    }
    appendFileSync(r.partFile, data);
    r.photoBytes += data.length;
    r.nextPart = part + 1;
    if (!p.last) return { ok: true, next: r.nextPart };
    if (!r.photoBytes) throw new Error('The photo is empty.');
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const path = join(this.uploads, r.sessionId, `phone-photo-${stamp}-${r.requestId.slice(-6)}.${r.photoExt}`);
    renameSync(r.partFile, path);
    r.partFile = null;
    this.#finish(r, 'answered', { answer: { path, bytes: statSync(path).size } });
    return { ok: true, path };
  }

  // ------------------------------------------------------------ endings

  #chatChanged(s) {
    for (const r of this.#requests.values()) {
      if (r.state !== OPEN || r.sessionId !== s.id) continue;
      const live = s.deleted ? null : this.#chat(r.sessionId);
      if (!live) this.#finish(r, 'cancelled', { message: 'The chat ended.' });
      else if ((live.stoppedAt ?? 0) > r.at) this.#finish(r, 'cancelled', { message: 'The owner stopped the chat.' });
    }
  }

  #clean() {
    const now = this.now();
    for (const [id, r] of this.#requests) {
      if (r.state === OPEN && now >= r.until) this.#finish(r, 'timeout', { message: 'The owner did not answer in time.' });
      else if (r.state === OPEN && now - r.polledAt > GONE_MS) this.#finish(r, 'cancelled', { message: 'The agent stopped asking.' });
      else if (r.state === OPEN && !this.#chat(r.sessionId)) this.#finish(r, 'cancelled', { message: 'The chat ended.' });
      if (r.state !== OPEN && now - (r.readAt ?? r.endedAt ?? now) > KEEP_RESULT_MS) this.#requests.delete(id);
    }
  }

  /**
   * `phone.*` calls. `trusted` is true only for this machine's own `helm`
   * and the owner's devices (agent.js decides).
   */
  async dispatch(method, p, { trusted } = {}) {
    if (!trusted) throw new Error('Only this machine and the owner\'s devices can use phone requests here.');
    if (method === 'phone.ask') return this.ask(p);
    if (method === 'phone.wait') return this.wait(p);
    if (method === 'phone.cancel') return this.cancel(p);
    if (method === 'phone.list') return { requests: this.list() };
    if (method === 'phone.give') return this.give(p);
    if (method === 'phone.photo') return this.photo(p);
    throw new Error(`unknown phone method: ${method}`);
  }
}

/** A refusal may carry a short note for the agent. */
function note(text) {
  const t = clean(text, 1000);
  return t ? { message: t } : {};
}
