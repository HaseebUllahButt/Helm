import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';

/**
 * Drivers run an agent CLI headless and translate what it says into helm's
 * one vocabulary of session events. Every driver emits the same events, so
 * the app renders Claude Code and Codex with the same components:
 *
 *   turn.start          { turnId, text }
 *   item.start          { id, kind, turnId, ... }   kind: text | thinking | tool | command | edit
 *   item.delta          { id, text }                appended to the item's text / output / input JSON
 *   item.update         { id, ...fields }
 *   item.done           { id, status, output?, exitCode?, error? }   status: ok | error | declined
 *   permission.request  { requestId, itemId, kind, title, detail, options[], defaultTo, ... }
 *   permission.resolved { requestId, decision }
 *   turn.done           { turnId, status, costUsd?, usage?, error? }  status: ok | interrupted | error
 *   status              { status }                  working | blocked | idle | exited
 *   limits              { ... }
 *   error               { message, kind? }
 *
 * A driver is one session: it is created with the resolved profile (command,
 * environment, arguments), a working directory and the options chosen when
 * starting, and it lives as long as the agent process does.
 */

// A model streams a few words at a time; a phone on a bad route does not want
// a WebSocket frame for each. Deltas to the same item are merged for this
// long before they leave the daemon. Nobody can tell 50ms from 0.
export const COALESCE_MS = 50;

export class Driver extends EventEmitter {
  /** itemId -> buffered text */
  #buffer = new Map();
  #flushTimer = null;

  constructor({ engine, cmd, env, args = [], cwd, model, effort, mode, engineSessionId, log = () => {} }) {
    super();
    Object.assign(this, { engine, cmd, env, profileArgs: args, cwd, model, effort, mode, engineSessionId, log });
    this.status = 'idle';
    /** requestId -> the permission.request event, until answered */
    this.pending = new Map();
  }

  /** Emit one event, merging text deltas per item. */
  push(type, payload) {
    if (type === 'item.delta') {
      this.#buffer.set(payload.id, (this.#buffer.get(payload.id) ?? '') + payload.text);
      if (!this.#flushTimer) {
        this.#flushTimer = setTimeout(() => this.flush(), COALESCE_MS);
        this.#flushTimer.unref?.();
      }
      return;
    }
    // Anything else must not overtake the text that came before it.
    this.flush();
    if (type === 'status') {
      if (payload.status === this.status) return;
      this.status = payload.status;
    }
    if (type === 'permission.request') this.pending.set(payload.requestId, payload);
    if (type === 'permission.resolved') this.pending.delete(payload.requestId);
    this.emit('event', { type, ...payload });
  }

  flush() {
    if (this.#flushTimer) { clearTimeout(this.#flushTimer); this.#flushTimer = null; }
    for (const [id, text] of this.#buffer) this.emit('event', { type: 'item.delta', id, text });
    this.#buffer.clear();
  }

  // The verbs a session can ask of any driver. Subclasses implement them.
  // No default sendWithAttachments on purpose: sessions checks for its
  // presence to decide whether the driver can carry image bytes, and a
  // default that quietly dropped them made every attachment vanish.
  async start() { throw new Error('not implemented'); }
  async send(_text) { throw new Error('not implemented'); }
  async answer(_requestId, _decision) { throw new Error('not implemented'); }
  async interrupt() { throw new Error('not implemented'); }
  async setModel(_model) { throw new Error('not implemented'); }
  async setMode(_mode) { throw new Error('not implemented'); }
  async kill() { throw new Error('not implemented'); }
}

/** Split a byte stream into lines and parse each as JSON; junk is reported, not fatal. */
export function readJsonLines(stream, onMessage, onJunk = () => {}) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { onJunk(line); continue; }
      onMessage(msg);
    }
  });
}

// ----------------------------------------------------------------- versions

const versions = new Map();

/** `major.minor.patch` from the first version-looking token of `bin --version`. */
export function cliVersion(cmd, env = {}) {
  const key = `${cmd}|${env.PATH ?? ''}`;
  if (!versions.has(key)) {
    versions.set(key, new Promise((resolve) => {
      execFile(cmd, ['--version'], { env: { ...process.env, ...env }, timeout: 15_000 }, (err, stdout) => {
        const m = String(stdout ?? '').match(/(\d+)\.(\d+)\.(\d+)/);
        resolve(err && !m ? null : m ? m[0] : null);
      });
    }));
  }
  return versions.get(key);
}

export const semverLess = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i];
  return false;
};

/**
 * The protocol each driver was written against. An older CLI may speak it
 * differently; say so loudly once rather than fail quietly mid-session.
 */
export async function checkVersion(engine, cmd, env, min, log) {
  const have = await cliVersion(cmd, env);
  if (!have) { log(`${engine}: could not read ${cmd} --version; assuming ${min}`); return; }
  if (semverLess(have, min)) {
    log(`${engine}: ${cmd} is ${have}; helm's driver was written against ${min}. Expect breakage - upgrade the CLI.`);
  }
}
