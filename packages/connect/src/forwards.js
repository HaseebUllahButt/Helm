import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { M } from '@helm/protocol';
import { HELM_DIR } from './paths.js';
import { startForward, forwardHubs } from './forward.js';

/**
 * Forwards: a port on one machine, on another machine's localhost.
 *
 * Each forward has two halves with the same id, kept in
 * `~/.helm/forwards.json` on each machine:
 * - `out`, on the machine with the app: lets the other machine's tunnels
 *   reach that one port (`#allowedTunnelPorts` in agent.js). No public link.
 * - `in`, on the machine where the owner opens it: the Helm service listens
 *   on 127.0.0.1:<localPort> and carries each connection over the network's
 *   hubs (forward.js).
 *
 * The Helm service owns both halves, so a forward outlives the shell that
 * asked for it and comes back after a restart. It ends at `expiresAt`
 * (both halves know the time) unless kept. Removing one half tells the
 * other machine; when that machine is away, the note waits in `pending`
 * and goes when it is back.
 */
const FILE = () => join(HELM_DIR, 'forwards.json');

/** Same as Spins: short-lived unless kept. */
export const FORWARD_TTL_MS = 3 * 60 * 60 * 1000;
const RETRY_MS = 30_000;
// A setTimeout longer than this fires at once.
const MAX_TIMER_MS = 2 ** 31 - 1;

export const newForwardId = () => randomBytes(4).toString('hex');

const validId = (id) => typeof id === 'string' && /^[a-f0-9]{6,32}$/.test(id);
const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65536;

function read() {
  try {
    const data = JSON.parse(readFileSync(FILE(), 'utf8'));
    return {
      forwards: Array.isArray(data?.forwards) ? data.forwards.filter(valid) : [],
      pending: Array.isArray(data?.pending) ? data.pending.filter((p) => validId(p?.id) && typeof p?.peer === 'string') : [],
    };
  } catch { return { forwards: [], pending: [] }; }
}

function valid(f) {
  return validId(f?.id) && (f.side === 'in' || f.side === 'out') && typeof f.peer === 'string' && f.peer
    // localPort 0: any free port; the real one is written once it listens.
    && validPort(f.port) && (f.side === 'out' || validPort(f.localPort) || f.localPort === 0)
    && (f.expiresAt == null || Number.isFinite(f.expiresAt));
}

function write(data) {
  const tmp = `${FILE()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, FILE());
}

const live = (f, now) => f.expiresAt == null || f.expiresAt > now;

/** Ports other machines may reach here because of a forward. */
export function forwardedPorts(now = Date.now()) {
  return read().forwards.filter((f) => f.side === 'out' && live(f, now)).map((f) => f.port);
}

export class Forwards {
  #listeners = new Map(); // id -> { fwd, localPort } | { error }
  #timer = null;
  #stopped = false;
  #checking = new Map(); // id -> time of the last check after a refusal
  #queue = Promise.resolve();

  /**
   * @param {object} o
   * @param {() => object} o.network   the roster
   * @param {(env, method, params, opts?) => Promise} o.rpc  a call to another machine
   */
  constructor({ network, rpc, start = startForward, now = Date.now, log = () => {}, retryMs = RETRY_MS }) {
    this.retryMs = retryMs;
    this.network = network;
    this.rpc = rpc;
    this.start = start;
    this.now = now;
    this.log = log;
  }

  // One change at a time: the file and the listeners move together.
  #serial(fn) {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  /** Open every listener this machine had, after a start or restart. */
  begin() {
    return this.#serial(() => this.#reconcile());
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    const all = [...this.#listeners.values()];
    this.#listeners.clear();
    return Promise.all(all.map((l) => l.fwd?.close()));
  }

  #name(id) {
    return this.network()?.machines?.[id]?.name ?? id;
  }

  /** Each half as the CLI shows it. */
  list() {
    const now = this.now();
    return read().forwards.filter((f) => live(f, now)).map((f) => this.#view(f));
  }

  #view(f) {
    const l = this.#listeners.get(f.id);
    return {
      ...f, peerName: this.#name(f.peer),
      ...(f.side === 'in' ? { listening: !!l?.fwd, ...(l?.error ? { error: l.error } : {}) } : {}),
    };
  }

  add(p) {
    return this.#serial(async () => {
      const side = p?.side;
      const forward = {
        id: String(p?.id ?? ''), side, peer: String(p?.peer ?? ''), port: Number(p?.port),
        ...(side === 'in' ? { localPort: Number(p?.localPort ?? p?.port) } : {}),
        createdAt: this.now(),
        ...(p?.expiresAt != null ? { expiresAt: Number(p.expiresAt) } : {}),
      };
      if (!valid(forward)) throw new Error('a forward needs an id, a side (in or out), a machine and a port');
      if (forward.expiresAt != null && !(forward.expiresAt > this.now())) throw new Error('that forward has already ended');
      const net = this.network();
      if (forward.peer === net?.self) throw new Error('a forward goes to another machine');
      if (!net?.machines?.[forward.peer] || net.revoked?.[forward.peer]) throw new Error('that machine is not in this network');
      const data = read();
      // One forward per port and machine: a second ask replaces the first,
      // and keeps its local port, so the owner's link stays the same.
      const before = data.forwards.find((f) => f.id === forward.id)
        ?? data.forwards.find((f) => f.side === side && f.peer === forward.peer && f.port === forward.port);
      if (side === 'in' && before?.side === 'in' && p?.localPort == null) forward.localPort = before.localPort;
      const replaced = data.forwards.filter((f) => f !== before);
      if (before && before.id !== forward.id) await this.#close(before.id);
      data.forwards = [...replaced, forward];
      data.pending = data.pending.filter((x) => x.id !== forward.id);
      write(data);
      if (side === 'in') {
        const held = this.#listeners.get(forward.id);
        if (held?.fwd && held.localPort === forward.localPort) {
          // The same forward again: keep the listener, take the new end time.
        } else {
          await this.#close(forward.id);
          await this.#open(forward);
          const l = this.#listeners.get(forward.id);
          if (l?.error) {
            write({ ...read(), forwards: read().forwards.filter((f) => f.id !== forward.id) });
            this.#listeners.delete(forward.id);
            throw new Error(l.error);
          }
        }
      }
      this.#schedule();
      return this.#view(read().forwards.find((f) => f.id === forward.id) ?? forward);
    });
  }

  /**
   * Remove this machine's half. With `notify`, tell the other machine to
   * remove its half too; if it is away, try again until it hears it.
   */
  remove(id, { notify = false } = {}) {
    return this.#serial(async () => {
      const data = read();
      const gone = data.forwards.find((f) => f.id === id);
      if (!gone) return { removed: false };
      data.forwards = data.forwards.filter((f) => f !== gone);
      if (notify) data.pending = [...data.pending.filter((x) => x.id !== id), { id, peer: gone.peer }];
      write(data);
      await this.#close(id);
      this.#schedule();
      if (notify) void this.#tell();
      return { removed: true, forward: this.#view(gone) };
    });
  }

  async #open(f) {
    try {
      const fwd = await this.start(this.network(), {
        target: f.peer, port: f.port, localPort: f.localPort, machine: this.#name(f.peer),
        hubs: () => forwardHubs(this.network()),
        onRefused: () => { void this.#refused(f.id); },
      });
      if (this.#stopped) { await fwd.close(); return; }
      this.#listeners.set(f.id, { fwd, localPort: fwd.port });
      if (fwd.port !== f.localPort) {
        const data = read();
        const row = data.forwards.find((x) => x.id === f.id);
        if (row) { row.localPort = fwd.port; write(data); }
        f.localPort = fwd.port;
      }
    } catch (err) {
      const busy = err?.code === 'EADDRINUSE';
      this.#listeners.set(f.id, { error: busy ? `port ${f.localPort} is in use on this machine` : String(err?.message || err) });
      this.log(`forward ${f.id}: ${this.#listeners.get(f.id).error}`);
    }
  }

  async #close(id) {
    const l = this.#listeners.get(id);
    this.#listeners.delete(id);
    await l?.fwd?.close();
  }

  /**
   * The far machine refused the port. If its half is gone (stopped there
   * while this machine was away), this half goes too. Asked at most once a
   * minute per forward.
   */
  async #refused(id) {
    const at = this.#checking.get(id) ?? 0;
    if (this.now() - at < 60_000) return;
    this.#checking.set(id, this.now());
    const f = read().forwards.find((x) => x.id === id);
    if (!f) return;
    try {
      const { forwards } = await this.rpc(f.peer, M.FORWARD_LIST, {}, { timeout: 10_000 });
      if (!forwards?.some((x) => x.id === id)) await this.remove(id);
    } catch { /* away: ask again on the next refusal */ }
  }

  /** Bring files and listeners in line: open missing ones, end old ones. */
  async #reconcile() {
    if (this.#stopped) return;
    const now = this.now();
    const data = read();
    const ended = data.forwards.filter((f) => !live(f, now));
    if (ended.length) {
      data.forwards = data.forwards.filter((f) => live(f, now));
      write(data);
    }
    const wanted = new Map(data.forwards.filter((f) => f.side === 'in').map((f) => [f.id, f]));
    for (const id of [...this.#listeners.keys()]) if (!wanted.has(id)) await this.#close(id);
    for (const f of wanted.values()) if (!this.#listeners.get(f.id)?.fwd) await this.#open(f);
    this.#schedule();
    if (data.pending.length) void this.#tell();
  }

  #schedule() {
    clearTimeout(this.#timer);
    if (this.#stopped) return;
    const data = read();
    const ends = data.forwards.map((f) => f.expiresAt).filter((t) => t != null);
    const failed = [...this.#listeners.values()].some((l) => l.error);
    const waits = [
      ...(ends.length ? [Math.max(0, Math.min(...ends) - this.now()) + 50] : []),
      ...(data.pending.length || failed ? [this.retryMs] : []),
    ];
    if (!waits.length) return;
    this.#timer = setTimeout(() => {
      // A listener that could not open (its port was busy) tries again.
      for (const [id, l] of this.#listeners) if (l.error) this.#listeners.delete(id);
      void this.#serial(() => this.#reconcile());
    }, Math.min(MAX_TIMER_MS, ...waits));
    this.#timer.unref?.();
  }

  #telling = false;
  /** Tell other machines about halves removed here. */
  async #tell() {
    if (this.#telling) return;
    this.#telling = true;
    try {
      for (const p of read().pending) {
        if (this.#stopped) return;
        let done = false;
        try {
          await this.rpc(p.peer, M.FORWARD_REMOVE, { id: p.id }, { timeout: 10_000 });
          done = true;
        } catch (err) {
          // A machine removed from the network, or one too old to know
          // forwards, will never answer better.
          if (/not in this network|unknown method|removed/i.test(err?.message || '')) done = true;
        }
        if (done) await this.#serial(() => {
          const data = read();
          data.pending = data.pending.filter((x) => x.id !== p.id);
          write(data);
        });
      }
    } finally {
      this.#telling = false;
      this.#schedule();
    }
  }
}
