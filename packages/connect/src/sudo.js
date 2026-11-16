import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { constants, hostname } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { HELM_DIR } from './paths.js';

/**
 * `helm sudo`: an agent asks to run one command as admin. The owner answers
 * on a card in the chat; Helm runs it with the admin password the owner
 * saved once on this machine. The agent never sees the password.
 *
 * The password is sealed with AES-256-GCM under a random key in its own
 * file. Both files are 0600 and never leave this machine: not in logs,
 * events, RPC results, chat env or backups (backup.js skips them).
 * "Allow for 15 min" lives in memory only, so a restart ends it.
 * docs/features/approvals.md has the rules and the traps.
 */

export const SUDO_DIR = join(HELM_DIR, 'sudo');
export const KEY_NAME = 'admin-password.key';
export const SEALED_NAME = 'admin-password.sealed';
export const ALLOW_MS = 15 * 60_000;
const MAGIC = Buffer.from('HELMSU01');
const REQUEST_ID = /^sudo-[A-Za-z0-9_-]{8,64}$/;
/** One `sudo.wait` call, short enough for any RPC on the way. */
const WAIT_SLICE_MS = 20_000;
/** A card whose `helm sudo` stopped asking is closed: nobody waits for that command. */
const GONE_MS = 3 * 60_000;
/** A finished result stays this long in memory for a late read; the record stays a week. */
const KEEP_RESULT_MS = 10 * 60_000;
const KEEP_RECORD_MS = 7 * 24 * 3600_000;
const PAGE_BYTES = 256 * 1024;

export const WRONG_PASSWORD = 'The saved admin password is wrong. Ask the owner to save it again.';
export const noPasswordMessage = (machine) => `No admin password is saved on ${machine}. Ask the owner to save it: in the Helm app Settings, or with helm sudo password on that machine.`;
export const typePasswordMessage = (machine) => `Type the admin password of ${machine} on the card, then allow.`;
export const CUT_OFF = 'Helm restarted while the admin command ran, and its output is lost. The command may still run, or it may have ended. Check the result before you run it again.';

/** What sudo itself writes about a password. It never reaches the output. */
const SUDO_LINE = /^(?:Sorry, try again\.?|sudo: \d+ incorrect password attempts?|sudo: no password was provided|sudo: a password is required|\[sudo\] password for .*)$/;
const WRONG = /incorrect password attempt|Sorry, try again|no password was provided/;

const isRoot = () => process.getuid?.() === 0;

/** Only what a command needs to start; sudo resets the rest. */
function plainEnv(extra = {}) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'SHELL', 'TMPDIR']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.PATH ||= '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  return { ...env, ...extra };
}

/** Run sudo for a check: its exit code and what it said. */
function sudoCheck(sudo, args, input = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(sudo, args, { env: plainEnv({ LC_ALL: 'C' }), stdio: ['pipe', 'ignore', 'pipe'] });
    let said = '';
    child.stderr.on('data', (d) => { said += d; });
    child.on('error', (error) => reject(error.code === 'ENOENT' ? new Error('This machine has no sudo command.') : error));
    child.on('close', (code) => resolve({ code, said }));
    child.stdin.on('error', () => {});
    if (input) {
      const line = Buffer.concat([input, Buffer.from('\n')]);
      child.stdin.end(line, () => line.fill(0));
    } else child.stdin.end();
  });
}

/** The admin password of this machine, sealed at rest. */
export class AdminPassword {
  constructor(dir = SUDO_DIR) {
    this.dir = dir;
    this.keyFile = join(dir, KEY_NAME);
    this.sealedFile = join(dir, SEALED_NAME);
  }

  saved() { return existsSync(this.sealedFile); }

  #key(create) {
    if (existsSync(this.keyFile)) {
      const key = readFileSync(this.keyFile);
      if (key.length === 32) return key;
      if (!create) return null;
    }
    if (!create) return null;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    const temp = `${this.keyFile}.${randomBytes(6).toString('hex')}`;
    writeFileSync(temp, key, { mode: 0o600, flag: 'wx' });
    renameSync(temp, this.keyFile);
    return key;
  }

  /** The password as bytes, or null. The caller wipes it after use. */
  read() {
    if (!this.saved()) return null;
    const key = this.#key(false);
    if (!key) return null;
    try {
      const sealed = readFileSync(this.sealedFile);
      if (sealed.length < 36 || !sealed.subarray(0, 8).equals(MAGIC)) return null;
      const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(8, 20));
      decipher.setAAD(MAGIC);
      decipher.setAuthTag(sealed.subarray(20, 36));
      return Buffer.concat([decipher.update(sealed.subarray(36)), decipher.final()]);
    } catch { return null; }
    finally { key.fill(0); }
  }

  save(password) {
    if (!Buffer.isBuffer(password) || !password.length) throw new Error('Type the admin password.');
    if (password.includes(0x0a) || password.includes(0x0d) || password.includes(0)) throw new Error('The password cannot have a line break.');
    const key = this.#key(true), iv = randomBytes(12);
    try {
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(MAGIC);
      const body = Buffer.concat([cipher.update(password), cipher.final()]);
      const temp = `${this.sealedFile}.${randomBytes(6).toString('hex')}`;
      writeFileSync(temp, Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]), { mode: 0o600, flag: 'wx' });
      renameSync(temp, this.sealedFile);
    } finally { key.fill(0); }
  }

  forget() {
    rmSync(this.sealedFile, { force: true });
    rmSync(this.keyFile, { force: true });
  }
}

/** Whether sudo asks this user for a password (cached tickets do not count). */
export async function sudoNeedsPassword(sudo = 'sudo') {
  if (isRoot()) return false;
  const { code } = await sudoCheck(sudo, ['-k', '-n', 'true']);
  return code !== 0;
}

/** Check a password with sudo itself. It does not leave a sudo ticket. */
export async function checkAdminPassword(password, sudo = 'sudo') {
  if (isRoot()) return { ok: true };
  const { code, said } = await sudoCheck(sudo, ['-k', '-S', '-p', '', '-v'], password);
  if (code === 0) return { ok: true };
  if (WRONG.test(said)) return { ok: false, message: 'This password is wrong: sudo did not accept it. Try again.' };
  const reason = said.split('\n').map((l) => l.trim()).find((l) => l && !SUDO_LINE.test(l));
  return { ok: false, message: reason ? `sudo did not accept it: ${reason.slice(0, 200)}` : 'sudo did not accept this password.' };
}

/** Save the owner's password after sudo accepts it. */
export async function saveAdminPassword(password, { dir = SUDO_DIR, sudo = 'sudo' } = {}) {
  const checked = await checkAdminPassword(password, sudo);
  if (!checked.ok) throw new Error(checked.message);
  new AdminPassword(dir).save(password);
}

const signalCode = (name) => 128 + (constants.signals[name] ?? 0);

/**
 * The requests on this machine: the cards, the commands that run, the
 * 15-minute allows. `sessions` is Sessions (sessions.js).
 */
export class AdminRuns {
  #requests = new Map();
  /** chat id -> when its 15-minute allow ends */
  #allows = new Map();
  #records;
  #recordFile;
  #sweep;

  constructor({ sessions, machineName = () => hostname(), dir = SUDO_DIR, sudo = 'sudo', log = () => {}, now = Date.now } = {}) {
    Object.assign(this, { sessions, machineName, dir, sudo, log, now });
    this.password = new AdminPassword(dir);
    this.#recordFile = join(dir, 'requests.json');
    this.#records = this.#readRecords();
    // The last Helm died with these. A card is asked again by its
    // `helm sudo`; a command that ran is never run again.
    let changed = false;
    for (const [requestId, record] of Object.entries(this.#records)) {
      if (record.state === 'asking') { this.#closeCard(record.sessionId, requestId, 'cancelled', record.back); }
      if (record.state === 'running') { record.state = 'lost'; changed = true; }
    }
    if (changed) this.#writeRecords();
    this.#sweep = setInterval(() => this.#clean(), 60_000);
    this.#sweep.unref?.();
  }

  stop() {
    clearInterval(this.#sweep);
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
    for (const [id, record] of Object.entries(this.#records)) if (!(record.at > cutoff)) delete this.#records[id];
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const temp = `${this.#recordFile}.${randomBytes(6).toString('hex')}`;
      writeFileSync(temp, JSON.stringify(this.#records), { mode: 0o600 });
      renameSync(temp, this.#recordFile);
    } catch (error) { this.log(`sudo: could not save requests: ${error.message}`); }
  }

  #record(r) {
    this.#records[r.requestId] = {
      sessionId: r.sessionId, state: r.state, at: this.now(),
      ...(r.exitCode != null ? { exitCode: r.exitCode } : {}),
      ...(r.message ? { message: r.message } : {}),
      ...(r.note ? { note: r.note } : {}),
      ...(r.back ? { back: r.back } : {}),
    };
    this.#writeRecords();
  }

  // ------------------------------------------------------------ cards

  /** No password is saved yet: the card asks for it, and Allow saves it. */
  #wantsPassword(r) { return !!r.needs && !this.password.saved(); }

  #card(r) {
    const wants = this.#wantsPassword(r);
    return {
      requestId: r.requestId, kind: 'command', tool: 'sudo', title: 'Run as admin',
      detail: r.command,
      reason: [r.reason && (/[.!?]$/.test(r.reason) ? r.reason : `${r.reason}.`), `Folder: ${r.cwd}`].filter(Boolean).join(' '),
      input: { command: r.command },
      ...(wants ? { passwordNeeded: true, machine: this.machineName() } : {}),
      options: [
        { id: 'allow', role: 'allow', label: 'Allow once' },
        { id: 'allow-15', role: 'allow-always', label: 'Allow for 15 min' },
        { id: 'deny', role: 'deny', label: 'Deny' },
      ],
      defaultTo: 'allow', allowEdit: false, ownLabels: true,
    };
  }

  #closeCard(sessionId, requestId, decision, back) {
    try { this.sessions.closeHelmAsk(sessionId, requestId, decision, back); }
    catch (error) { this.log(`sudo: could not close a card in ${sessionId}: ${error.message}`); }
  }

  /** The small line in the chat that says what ran as admin. */
  #note(r, done) {
    try {
      if (!done) {
        const turnId = this.sessions.events.activeTurn(r.sessionId)?.turnId;
        this.#append(r.sessionId, { type: 'item.start', id: r.requestId, kind: 'command', name: 'sudo', command: r.command, cwd: r.cwd, ...(turnId ? { turnId } : {}) });
      } else {
        this.#append(r.sessionId, { type: 'item.done', id: r.requestId, status: r.state === 'done' ? 'ok' : 'error',
          ...(r.exitCode != null ? { exitCode: r.exitCode } : {}), ...(r.state === 'done' ? {} : { error: r.message || 'Stopped.' }) });
      }
    } catch (error) { this.log(`sudo: could not note a run in ${r.sessionId}: ${error.message}`); }
  }

  #append(id, event) {
    const saved = this.sessions.events.append(id, event);
    this.sessions.emit('event', { id, event: saved });
  }

  // ------------------------------------------------------------ requests

  #wake(r) {
    for (const done of [...r.waiters]) done();
  }

  #push(r, stream, data) {
    for (let at = 0; at < data.length; at += 16 * 1024) {
      r.chunks.push({ seq: ++r.seq, s: stream, d: data.subarray(at, at + 16 * 1024).toString('base64') });
    }
    this.#wake(r);
  }

  #finish(r, state, fields = {}) {
    if (['done', 'denied', 'failed', 'cancelled', 'lost'].includes(r.state)) return;
    const ran = r.state === 'running';
    Object.assign(r, { state, ...fields, endedAt: this.now() });
    if (ran) this.#note(r, true);
    this.#record(r);
    this.#wake(r);
  }

  #view(r, from = 0) {
    const output = [];
    let bytes = 0;
    for (const chunk of r.chunks) {
      if (chunk.seq <= from) continue;
      if (bytes + chunk.d.length > PAGE_BYTES && output.length) break;
      bytes += chunk.d.length; output.push(chunk);
    }
    const next = output.at(-1)?.seq ?? from;
    const more = r.seq > next;
    return {
      requestId: r.requestId, state: more && !['asking', 'running'].includes(r.state) ? 'running' : r.state,
      output, next,
      ...(!more && r.exitCode != null ? { exitCode: r.exitCode } : {}),
      ...(!more && r.message ? { message: r.message } : {}),
      ...(r.note ? { note: r.note } : {}),
      ...(r.until ? { until: r.until } : {}),
    };
  }

  /** Where a request stands, without its output (`wait` reads that). */
  #told(r) {
    return { requestId: r.requestId, state: r.state, ...(r.until ? { until: r.until } : {}),
      ...(['failed', 'cancelled'].includes(r.state) && r.message ? { message: r.message } : {}) };
  }

  /** What the record says about a request this Helm does not hold. */
  #fromRecord(requestId, sessionId) {
    const record = this.#records[requestId];
    if (!record || record.state === 'asking') return null;
    if (sessionId && record.sessionId !== sessionId) throw new Error('This request belongs to another chat.');
    if (record.state === 'running' || record.state === 'lost') return { requestId, state: 'lost', message: CUT_OFF, output: [], next: 0 };
    if (record.state === 'done') return { requestId, state: 'done', exitCode: record.exitCode ?? 1, output: [], next: 0, outputLost: true };
    return { requestId, state: record.state, output: [], next: 0, ...(record.message ? { message: record.message } : {}), ...(record.note ? { note: record.note } : {}) };
  }

  #allowed(sessionId) {
    const until = this.#allows.get(sessionId);
    if (until && until > this.now()) return until;
    if (until) this.#allows.delete(sessionId);
    return null;
  }

  async ask(p) {
    const { sessionId, requestId, command, cwd } = p ?? {};
    if (!this.owns(requestId)) throw new Error('A sudo request needs a request id.');
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('Run helm sudo in a Helm chat.');
    if (typeof command !== 'string' || !command.trim() || command.length > 64 * 1024 || command.includes('\0')) throw new Error('Give the command to run: helm sudo -- <command>');
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0')) throw new Error('The folder must be a full path.');
    const reason = typeof p.reason === 'string' ? p.reason.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
    const held = this.#requests.get(requestId);
    if (held) {
      if (held.sessionId !== sessionId) throw new Error('This request belongs to another chat.');
      held.polledAt = this.now();
      // The card went away (the chat restarted its agent): show it again.
      if (held.state === 'asking') this.sessions.showHelmAsk(sessionId, this.#card(held));
      return this.#told(held);
    }
    const known = this.#fromRecord(requestId, sessionId);
    if (known) return known;
    let session;
    try { session = this.sessions.get(sessionId); } catch { throw new Error('Run helm sudo in a Helm chat on this machine.'); }
    if (session.adopted) throw new Error('Run helm sudo in a Helm chat on this machine.');
    // With no saved password the card asks the owner for it (#card).
    const needs = await sudoNeedsPassword(this.sudo);
    const r = {
      requestId, sessionId, command, cwd, reason, needs,
      state: 'asking', chunks: [], seq: 0, waiters: new Set(), polledAt: this.now(), at: this.now(),
      back: ['working', 'idle'].includes(session.status) ? session.status : 'working',
    };
    this.#requests.set(requestId, r);
    const until = !this.#wantsPassword(r) && this.#allowed(sessionId);
    if (until) {
      r.until = until;
      this.#run(r);
      return this.#told(r);
    }
    this.#record(r);
    this.sessions.showHelmAsk(sessionId, this.#card(r));
    return this.#told(r);
  }

  async wait(p) {
    const { requestId } = p ?? {};
    const from = Number.isInteger(p?.from) && p.from >= 0 ? p.from : 0;
    const slice = Number.isInteger(p?.wait) ? Math.max(0, Math.min(p.wait, WAIT_SLICE_MS)) : WAIT_SLICE_MS;
    if (!this.owns(requestId)) throw new Error('A sudo request needs a request id.');
    const r = this.#requests.get(requestId);
    if (!r) return this.#fromRecord(requestId) ?? { requestId, state: 'unknown', output: [], next: from };
    r.polledAt = this.now();
    r.chunks = r.chunks.filter((c) => c.seq > from);
    // A chat that lost the card (its agent restarted) gets it back.
    if (r.state === 'asking' && !this.sessions.events.pending(r.sessionId).some((x) => x.requestId === requestId)) {
      this.sessions.showHelmAsk(r.sessionId, this.#card(r));
    }
    const ready = () => r.seq > from || !['asking', 'running'].includes(r.state);
    if (!ready() && slice) {
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); r.waiters.delete(done); resolve(); };
        const timer = setTimeout(done, slice);
        r.waiters.add(done);
      });
    }
    r.polledAt = this.now();
    const view = this.#view(r, from);
    if (!['asking', 'running'].includes(view.state)) r.readAt = this.now();
    return view;
  }

  cancel(p) {
    const r = this.#requests.get(p?.requestId);
    if (!r) return this.#fromRecord(p?.requestId) ?? { requestId: p?.requestId, state: 'unknown', output: [], next: 0 };
    if (r.state === 'asking') {
      this.#finish(r, 'cancelled', { message: 'The agent stopped asking.' });
      this.#closeCard(r.sessionId, r.requestId, 'cancelled', r.back);
    } else if (r.state === 'running' && r.child) {
      // Ctrl+C asks the command to stop; asked again, it is ended harder.
      const name = ['SIGINT', 'SIGTERM', 'SIGKILL'][Math.min(r.signals ?? 0, 2)];
      r.signals = (r.signals ?? 0) + 1;
      try { process.kill(r.child.pid, name); } catch { /* it ended already */ }
      if (isRoot()) try { process.kill(-r.child.pid, name); } catch { /* no group left */ }
    }
    return this.#told(r);
  }

  /** The owner answered the card (Sessions.answer hands it here). */
  async answer(id, requestId, decision = {}) {
    const r = this.#requests.get(requestId);
    if (!r || r.sessionId !== id || r.state !== 'asking') {
      this.#closeCard(id, requestId, 'cancelled', r?.back);
      throw Object.assign(new Error('This request is no longer open.'), { deliveryNotSent: true });
    }
    // A card that asks for the password takes no note: an owner who types
    // the password there would send it to the agent in plain text.
    const note = typeof decision.message === 'string' && !this.#wantsPassword(r) ? decision.message.trim().slice(0, 2000) : '';
    if (note) r.note = note;
    const option = decision.option === 'deny' ? 'deny' : decision.option === 'always' ? 'always' : 'allow';
    // Nobody waits for the answer any more: do not run an admin command for no one.
    if (option !== 'deny' && this.now() - r.polledAt > GONE_MS) {
      this.#finish(r, 'cancelled', { message: 'The agent stopped asking.' });
      this.#closeCard(id, requestId, 'cancelled', r.back);
      throw Object.assign(new Error('The agent stopped waiting. Helm did not run the command.'), { deliveryNotSent: true });
    }
    // The card asked for the password. The app saves it with sudo.setup
    // before it answers: an answer is kept on disk for its delivery, so it
    // never carries the password. Until one is saved, only Deny closes it.
    if (option !== 'deny' && this.#wantsPassword(r)) {
      throw Object.assign(new Error(typePasswordMessage(this.machineName())), { deliveryNotSent: true });
    }
    this.#closeCard(id, requestId, option, r.back);
    if (option === 'deny') { this.#finish(r, 'denied'); return { ok: true }; }
    if (option === 'always') {
      r.until = this.now() + ALLOW_MS;
      this.#allows.set(id, r.until);
    }
    this.#run(r);
    return { ok: true };
  }

  #run(r) {
    let argv, password = null;
    if (isRoot()) argv = ['/bin/sh', '-c', r.command];
    else if (!r.needs) argv = [this.sudo, '-k', '-n', '--', '/bin/sh', '-c', r.command];
    else {
      password = this.password.read();
      if (!password) {
        this.#finish(r, 'failed', { message: this.password.saved() ? WRONG_PASSWORD : noPasswordMessage(this.machineName()) });
        return;
      }
      argv = [this.sudo, '-k', '-S', '-p', '', '--', '/bin/sh', '-c', r.command];
    }
    r.state = 'running';
    this.#record(r);
    this.#note(r, false);
    this.#wake(r);
    let child;
    try {
      // Its own process group: a restart of Helm does not stop it halfway.
      child = spawn(argv[0], argv.slice(1), { cwd: r.cwd, env: plainEnv(), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch (error) {
      password?.fill(0);
      this.#finish(r, 'failed', { message: `Helm could not start the command: ${error.message}` });
      return;
    }
    r.child = child;
    child.stdin.on('error', () => {});
    if (password) {
      const line = Buffer.concat([password, Buffer.from('\n')]);
      password.fill(0);
      child.stdin.end(line, () => line.fill(0));
    } else child.stdin.end();
    // sudo speaks first, before the command: its lines about the password
    // are dropped. The first other line means the command runs.
    let sudoTalk = argv[0] === this.sudo, heard = '', wrong = false, required = false;
    const flush = () => { if (heard) { this.#push(r, 'err', Buffer.from(heard)); heard = ''; } };
    child.stdout.on('data', (data) => { if (sudoTalk) { sudoTalk = false; flush(); } this.#push(r, 'out', data); });
    child.stderr.on('data', (data) => {
      if (!sudoTalk) { this.#push(r, 'err', data); return; }
      heard += data.toString('utf8');
      let cut;
      while (sudoTalk && (cut = heard.indexOf('\n')) >= 0) {
        const line = heard.slice(0, cut).replace(/\r$/, '');
        if (!line.trim() || SUDO_LINE.test(line.trim())) {
          if (WRONG.test(line)) wrong = true;
          if (/a password is required/.test(line)) required = true;
          heard = heard.slice(cut + 1);
        } else { sudoTalk = false; }
      }
      if (!sudoTalk) flush();
    });
    child.on('error', (error) => {
      this.#finish(r, 'failed', { message: error.code === 'ENOENT' ? 'This machine has no sudo command.' : `Helm could not start the command: ${error.message}` });
    });
    child.on('close', (code, signal) => {
      r.child = null;
      if (sudoTalk && heard && !SUDO_LINE.test(heard.trim())) flush();
      if (wrong && code === 1) { this.#finish(r, 'failed', { message: WRONG_PASSWORD }); return; }
      if (required && code === 1) { this.#finish(r, 'failed', { message: noPasswordMessage(this.machineName()) }); return; }
      this.#finish(r, 'done', { exitCode: code ?? (signal ? signalCode(signal) : 1) });
    });
  }

  #clean() {
    const now = this.now();
    for (const [id, r] of this.#requests) {
      if (r.state === 'asking' && now - r.polledAt > GONE_MS) {
        this.#finish(r, 'cancelled', { message: 'The agent stopped asking.' });
        this.#closeCard(r.sessionId, id, 'cancelled', r.back);
      }
      if (!['asking', 'running'].includes(r.state) && now - (r.readAt ?? r.endedAt ?? now) > KEEP_RESULT_MS) this.#requests.delete(id);
    }
    for (const [id, until] of this.#allows) if (until <= now) this.#allows.delete(id);
  }

  // ------------------------------------------------------------ the owner

  allows() {
    const now = this.now();
    return [...this.#allows].filter(([, until]) => until > now).map(([id, until]) => {
      let title = null;
      try { const s = this.sessions.get(id); title = s.title || s.name || null; } catch { /* deleted chat */ }
      return { id, title, until };
    });
  }

  async status() {
    if (process.platform === 'win32') return { supported: false };
    let needsPassword = null, error = null;
    try { needsPassword = await sudoNeedsPassword(this.sudo); } catch (e) { error = e.message; }
    return { supported: !error, saved: this.password.saved(), needsPassword, root: isRoot(), machine: this.machineName(), allows: this.allows(), ...(error ? { error } : {}) };
  }

  stopAllows(sessionId) {
    const ended = sessionId ? (this.#allows.delete(sessionId) ? 1 : 0) : this.#allows.size;
    if (!sessionId) this.#allows.clear();
    return ended;
  }

  /** The owner's own calls: never from an agent on another machine. */
  async setup(p = {}) {
    if (p.do === 'save') {
      if (typeof p.password !== 'string' || !p.password) throw new Error('Type the admin password.');
      const password = Buffer.from(p.password, 'utf8');
      try { await saveAdminPassword(password, { dir: this.dir, sudo: this.sudo }); }
      finally { password.fill(0); }
    } else if (p.do === 'forget') this.password.forget();
    else if (p.do === 'stop') this.stopAllows(typeof p.sessionId === 'string' && p.sessionId ? p.sessionId : null);
    else if (p.do && p.do !== 'status') throw new Error(`unknown sudo setup step: ${p.do}`);
    return this.status();
  }

  /**
   * `sudo.*` calls. `trusted` is true only for this machine's own `helm`
   * and the owner's devices (agent.js decides).
   */
  async dispatch(method, p, { trusted } = {}) {
    if (!trusted) throw new Error('Only this machine and the owner\'s devices can use admin commands here.');
    if (method === 'sudo.ask') return this.ask(p);
    if (method === 'sudo.wait') return this.wait(p);
    if (method === 'sudo.cancel') return this.cancel(p);
    if (method === 'sudo.setup') return this.setup(p);
    throw new Error(`unknown sudo method: ${method}`);
  }
}
