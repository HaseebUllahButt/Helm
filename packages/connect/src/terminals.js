import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync, mkdirSync, openSync, lstatSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HELM_DIR } from './paths.js';

/**
 * Where the host listens.
 *
 * Not inside HELM_DIR, because a unix socket path is capped at about 107
 * bytes by the kernel and a helm directory nested a few levels deep blows
 * through that - `listen` then fails with EINVAL and terminals quietly fall
 * back to the slow path. The runtime directory is short and per-user; the
 * name carries a hash of HELM_DIR so a sandboxed daemon never reaches the
 * real one's terminals.
 */
const socketDir = process.env.XDG_RUNTIME_DIR || privateTmp();

/**
 * Without a runtime directory the sockets used to sit loose in /tmp under a
 * predictable name - and the daemon dials whatever is listening there, so
 * another user who bound it first would be handed every agent's command
 * line, environment and keystrokes. A 0700 directory of our own instead,
 * refused if it is someone else's or a symlink.
 */
function privateTmp() {
  const uid = process.getuid?.();
  if (uid === undefined) return tmpdir();
  const dir = join(tmpdir(), `helm-${uid}`);
  try { mkdirSync(dir, { mode: 0o700 }); } catch { /* already there */ }
  try {
    const st = lstatSync(dir);
    if (st.isDirectory() && !st.isSymbolicLink() && st.uid === uid) {
      if (st.mode & 0o077) chmodSync(dir, 0o700);
      return dir;
    }
  } catch { /* fall through */ }
  mkdirSync(join(HELM_DIR, 'run'), { recursive: true, mode: 0o700 });
  return join(HELM_DIR, 'run');
}
const helmTag = createHash('sha256').update(HELM_DIR).digest('hex').slice(0, 10);
export const SOCKET_PATH =
  process.env.HELM_TERMINALS_SOCKET || join(socketDir, `helm-terminals-${helmTag}.sock`);
/**
 * Agent processes get a host of their own, on their own socket: ptys and
 * procs then upgrade on independent schedules, and a machine mid-migration -
 * an old terminal host still holding shells - gains proc persistence without
 * a single terminal being killed for it.
 */
export const PROC_SOCKET_PATH =
  process.env.HELM_PROCS_SOCKET || join(socketDir, `helm-procs-${helmTag}.sock`);

/** Where a host that fails to start says why. */
export const HOST_LOG = join(HELM_DIR, 'terminals.log');

const HOST_BIN = fileURLToPath(new URL('../bin/helm-terminals.js', import.meta.url));

/**
 * A host that cannot start says why here rather than into `/dev/null`, which
 * is how a socket path too long for the kernel went unnoticed.
 */
function hostLog() {
  try {
    mkdirSync(HELM_DIR, { recursive: true, mode: 0o700 });
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
  /**
   * Agent processes the host holds - same lifecycle, same reason. A proc's
   * session id is its id here, so `hasProc(s.id)` is the whole check.
   */
  #procs = new Set();
  /** proc id -> the driver's listeners, once one has bound the stream */
  #procListeners = new Map();
  /** proc id -> output nobody is holding yet, kept for whichever driver asks */
  #procBacklog = new Map();
  #connecting = null;
  #pty = null;
  /** Which socket to talk to and which systemd unit to spawn it as - the
   *  pty host by default; a proc-only instance when asked. */
  #socketPath;
  #unit;

  constructor({ socketPath = SOCKET_PATH, unit = 'helm-terminals' } = {}) {
    super();
    this.#socketPath = socketPath;
    this.#unit = unit;
  }

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
      if (existsSync(this.#socketPath)) {
        try { unlinkSync(this.#socketPath); } catch { /* not ours */ }
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
      const sock = connect(this.#socketPath);
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
        // never settled, and `helm status` exited on node's unsettled
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
      this.#procs = new Set(msg.procs ?? []);
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
    // A proc's bytes belong to the driver holding it - or to a small buffer
    // when none has bound yet, because the agent does not stop mid-answer
    // just because the daemon has not reopened the session.
    if (msg.t === 'proc.data') {
      const l = this.#procListeners.get(msg.id);
      if (l?.onData) l.onData(msg.data);
      else this.#procBacklog.set(msg.id, ((this.#procBacklog.get(msg.id) ?? '') + msg.data).slice(-262144));
      return;
    }
    if (msg.t === 'proc.exit') {
      this.#procs.delete(msg.id);
      const l = this.#procListeners.get(msg.id);
      this.#procListeners.delete(msg.id);
      this.#procBacklog.delete(msg.id);
      if (l?.onExit) l.onExit({ code: msg.code, stderr: msg.stderr });
      // With no driver attached, the session itself has to close the turn
      // the dead process left open - it cannot wait for somebody to look.
      else this.emit('proc.exit', { id: msg.id, code: msg.code });
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
      const poll = setInterval(() => {
        if (existsSync(this.#socketPath)) { clearInterval(poll); clearTimeout(timer); resolve(); }
      }, 100);
      const timer = setTimeout(() => {
        clearInterval(poll);
        reject(new Error('the terminal host did not start'));
      }, START_TIMEOUT_MS);
    });

    const env = {
      HELM_DIR: process.env.HELM_DIR ?? '',
      // `systemd-run --user` does not inherit the service's environment. In
      // particular, its default PATH omits user-installed agent CLIs such as
      // Devin, so the host would accept a proc.open request for a command it
      // could never spawn.
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      // Always this instance's own path: a proc host spawned while the env
      // points at the pty socket must still bind the proc one.
      HELM_TERMINALS_SOCKET: this.#socketPath,
    };
    const passed = Object.entries(env).filter(([, v]) => v);

    const useSystemd = !process.env.HELM_NO_SYSTEMD_RUN && process.env.XDG_RUNTIME_DIR;
    if (useSystemd) {
      const args = [
        '--user', '--quiet', '--collect',
        `--unit=${this.#unit}-${process.getuid?.() ?? 0}`,
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

  // ------------------------------------------------- agent processes (procs)

  hasProc(id) { return this.#procs.has(id); }

  /** Start a pipe-stdio process on the host, or attach to the one it kept. */
  async openProc(id, spec) {
    await this.ensure();
    // The host may have been started by an older daemon (or by systemd with
    // a sparse environment). Carry the daemon's lookup path with each open
    // so a restart can still find user-installed CLIs without restarting a
    // host that may be holding another live agent.
    const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...(spec.env ?? {}) };
    const r = await this.#call({ t: 'proc.open', id, ...spec, env });
    this.#procs.add(id);
    return r;
  }

  /**
   * A live proc's stdio as the pipe-shaped object a driver drives. Output
   * the agent produced before anyone bound is replayed first, in order.
   * `detach` hands the stream back without touching the process - what the
   * daemon calls when it is the one going away.
   */
  procPipe(id) {
    if (!this.#procs.has(id)) return null;
    const l = {};
    this.#procListeners.set(id, l);
    return {
      write: (data) => this.#call({ t: 'proc.write', id, data }).catch(() => {}),
      end: () => this.#call({ t: 'proc.end', id }).catch(() => {}),
      kill: (signal) => this.#call({ t: 'proc.kill', id, signal }).catch(() => {}),
      onData: (cb) => {
        l.onData = cb;
        const backlog = this.#procBacklog.get(id) ?? '';
        this.#procBacklog.delete(id);
        if (backlog) queueMicrotask(() => { if (l.onData === cb) cb(backlog); });
      },
      onExit: (cb) => { l.onExit = cb; },
      detach: () => { if (this.#procListeners.get(id) === l) this.#procListeners.delete(id); },
    };
  }

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
