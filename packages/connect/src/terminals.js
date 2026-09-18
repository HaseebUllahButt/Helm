import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CON_DIR } from './paths.js';

/**
 * Where the host listens.
 *
 * Not inside CON_DIR, because a unix socket path is capped at about 107
 * bytes by the kernel and a con directory nested a few levels deep blows
 * through that - `listen` then fails with EINVAL and terminals quietly fall
 * back to the slow path. The runtime directory is short and per-user; the
 * name carries a hash of CON_DIR so a sandboxed daemon never reaches the
 * real one's terminals.
 */
const socketDir = process.env.XDG_RUNTIME_DIR || tmpdir();
const conTag = createHash('sha256').update(CON_DIR).digest('hex').slice(0, 10);
export const SOCKET_PATH =
  process.env.CON_TERMINALS_SOCKET || process.env.HELM_TERMINALS_SOCKET || join(socketDir, `con-terminals-${conTag}.sock`);

/** Where a host that fails to start says why. */
export const HOST_LOG = join(CON_DIR, 'terminals.log');

const HOST_BIN = fileURLToPath(new URL('../bin/con-terminals.js', import.meta.url));

/**
 * A host that cannot start says why here rather than into `/dev/null`, which
 * is how a socket path too long for the kernel went unnoticed.
 */
function hostLog() {
  try {
    mkdirSync(CON_DIR, { recursive: true, mode: 0o700 });
    return openSync(HOST_LOG, 'a');
  } catch {
    return 'ignore';
  }
}

/** How long to wait for a freshly spawned host to start listening. */
const START_TIMEOUT_MS = 8000;

/**
 * The daemon's handle on the terminal host.
 *
 * Same surface as `Terminals` in `pty.js` - which is what the host itself
 * runs - but every call crosses a unix socket, so the shells survive this
 * process being restarted for an upgrade.
 *
 * Which terminals exist is mirrored locally, because `Sessions.list()` needs
 * that answer synchronously: the host reports its ids on connect, and after
 * that they only change when we open one or it exits.
 */
export class TerminalHost extends EventEmitter {
  #sock = null;
  #buffer = '';
  #rid = 0;
  #waiting = new Map();
  #ids = new Set();
  #connecting = null;
  #pty = null;

  /** True once a host has answered and it has a working pty. */
  get usable() { return this.#pty === true; }

  has(id) { return this.#ids.has(id); }
  list() { return [...this.#ids]; }

  /**
   * Connect, starting a host if there is not one already.
   *
   * `spawn: false` connects only to a host that is already running. That is
   * what a daemon wants at boot: if there is no host there are no surviving
   * terminals to reconcile, and starting one just to be told so would leave a
   * process behind on every restart.
   *
   * Returns false when no host can be had - a machine without the pty addon,
   * say - so the caller can fall back to a herdr pane rather than fail.
   */
  async ensure({ spawn = true } = {}) {
    if (this.#sock && !this.#sock.destroyed) return this.usable;
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#open(spawn).finally(() => { this.#connecting = null; });
    return this.#connecting;
  }

  async #open(maySpawn) {
    try {
      await this.#dial();
      return this.usable;
    } catch {
      if (!maySpawn) return false;
      // Nothing listening, or something stale is. A socket file whose host is
      // gone refuses every connection until it is removed.
      if (existsSync(SOCKET_PATH)) {
        try { unlinkSync(SOCKET_PATH); } catch { /* not ours */ }
      }
      try {
        await this.#spawnHost();
        await this.#dial();
        return this.usable;
      } catch {
        return false;
      }
    }
  }

  #dial() {
    return new Promise((resolve, reject) => {
      const sock = connect(SOCKET_PATH);
      sock.setNoDelay?.(true);
      const fail = (err) => { sock.destroy(); reject(err); };
      sock.once('error', fail);
      sock.once('connect', () => {
        sock.off('error', fail);
        this.#attach(sock);
        // The host greets us with what it is holding; until that arrives we
        // do not know which terminals survived.
        //
        // The deadline is deliberately *not* unref'd. It was, and that made
        // a connected-but-silent host hang the caller forever: with nothing
        // else holding the loop open, the timer never fired, the promise
        // never settled, and `con status` exited on node's unsettled
        // top-level await warning without ever printing its terminals line.
        // Clearing it on both paths is what keeps a ref'd timer honest.
        const done = (fn, arg) => { clearTimeout(timer); this.off('hello', greeted); fn(arg); };
        const greeted = (msg) => { if (msg.t === 'hello') done(resolve); };
        const timer = setTimeout(
          () => done(reject, new Error('the terminal host did not say hello')),
          4000,
        );
        this.on('hello', greeted);
      });
    });
  }

  #attach(sock) {
    this.#sock = sock;
    this.#buffer = '';
    sock.on('data', (chunk) => {
      this.#buffer += chunk;
      let cut;
      while ((cut = this.#buffer.indexOf('\n')) !== -1) {
        const line = this.#buffer.slice(0, cut);
        this.#buffer = this.#buffer.slice(cut + 1);
        if (!line.trim()) continue;
        try { this.#dispatch(JSON.parse(line)); } catch { /* not a frame */ }
      }
    });
    const lost = () => {
      if (this.#sock !== sock) return;
      this.#sock = null;
      // Every call in flight is now unanswerable.
      for (const p of this.#waiting.values()) p.reject(new Error('the terminal host went away'));
      this.#waiting.clear();
    };
    sock.on('close', lost);
    sock.on('error', lost);
  }

  #dispatch(msg) {
    if (msg.t === 'hello') {
      this.#pty = !!msg.pty;
      this.#ids = new Set(msg.ids ?? []);
      this.emit('hello', msg);
      return;
    }
    if (msg.t === 'ok' || msg.t === 'err') {
      const p = this.#waiting.get(msg.rid);
      if (!p) return;
      this.#waiting.delete(msg.rid);
      msg.t === 'ok' ? p.resolve(msg.result) : p.reject(new Error(msg.error));
      return;
    }
    if (msg.t === 'data') this.emit('data', { id: msg.id, text: msg.text });
    if (msg.t === 'exit') {
      this.#ids.delete(msg.id);
      this.emit('exit', { id: msg.id, code: msg.code });
    }
  }

  /**
   * Start the host outside our own cgroup.
   *
   * `systemd-run --user` is what makes this work under systemd: the daemon is
   * a user unit whose default KillMode is `control-group`, so restarting it
   * kills every process it started - a plain detached child included, which
   * is exactly the problem this host exists to solve. Without systemd, being
   * its own session leader is enough.
   */
  async #spawnHost() {
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the terminal host did not start')), START_TIMEOUT_MS);
      timer.unref?.();
      const poll = setInterval(() => {
        if (existsSync(SOCKET_PATH)) { clearInterval(poll); clearTimeout(timer); resolve(); }
      }, 100);
      poll.unref?.();
    });

    const env = {
      CON_DIR: process.env.CON_DIR ?? '',
      CON_TERMINALS_SOCKET: process.env.CON_TERMINALS_SOCKET ?? '',
    };
    const passed = Object.entries(env).filter(([, v]) => v);

    const useSystemd = !process.env.CON_NO_SYSTEMD_RUN && process.env.XDG_RUNTIME_DIR;
    if (useSystemd) {
      const args = [
        '--user', '--quiet', '--collect',
        `--unit=con-terminals-${process.getuid?.() ?? 0}`,
        ...passed.map(([k, v]) => `--setenv=${k}=${v}`),
        process.execPath, HOST_BIN,
      ];
      const child = spawn('systemd-run', args, { stdio: ['ignore', hostLog(), hostLog()], detached: true });
      child.unref();
      const failed = new Promise((_, reject) =>
        child.once('error', reject).once('exit', (code) => {
          if (code !== 0) reject(new Error(`systemd-run exited ${code}`));
        }));
      try {
        await Promise.race([ready, failed]);
        return;
      } catch {
        // systemd-run is not always available or permitted; fall through.
      }
    }

    const child = spawn(process.execPath, [HOST_BIN], {
      stdio: ['ignore', hostLog(), hostLog()],
      detached: true,
      env: { ...process.env, ...Object.fromEntries(passed) },
    });
    child.unref();
    await ready;
  }

  #call(msg) {
    return new Promise((resolve, reject) => {
      if (!this.#sock || this.#sock.destroyed) return reject(new Error('no terminal host'));
      const rid = ++this.#rid;
      this.#waiting.set(rid, { resolve, reject });
      this.#sock.write(JSON.stringify({ ...msg, rid }) + '\n');
      setTimeout(() => {
        if (this.#waiting.delete(rid)) reject(new Error(`${msg.t} timed out`));
      }, 15_000).unref?.();
    });
  }

  async open(id, opts = {}) {
    await this.ensure();
    await this.#call({ t: 'open', id, ...opts });
    this.#ids.add(id);
    return { id };
  }

  async view(id, { cols, rows } = {}) {
    await this.ensure();
    const r = await this.#call({ t: 'view', id, cols, rows });
    return r.text;
  }

  renew(id)              { return this.#call({ t: 'renew', id }); }
  unview(id)             { return this.#call({ t: 'unview', id }).catch(() => {}); }
  write(id, data)        { return this.#call({ t: 'write', id, data }); }
  resize(id, cols, rows) { return this.#call({ t: 'resize', id, cols, rows }).catch(() => {}); }

  async close(id) {
    this.#ids.delete(id);
    await this.#call({ t: 'close', id }).catch(() => {});
  }

  /** Ask the host to close everything and exit. */
  async shutdown() {
    await this.#call({ t: 'shutdown' }).catch(() => {});
    this.detach();
  }

  /** Drop the connection without touching the terminals it holds. */
  detach() {
    this.#sock?.destroy();
    this.#sock = null;
  }
}
