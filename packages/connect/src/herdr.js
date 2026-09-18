import { connect } from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { HOME } from './paths.js';

const exec = promisify(execFile);

export const SOCKET_PATH =
  process.env.HERDR_SOCKET_PATH ||
  (process.env.HERDR_SESSION
    ? join(HOME, '.config/herdr/sessions', process.env.HERDR_SESSION, 'herdr.sock')
    : join(HOME, '.config/herdr/herdr.sock'));

/**
 * Events con watches for every pane, without naming one. Per-pane
 * subscriptions (`pane.agent_status_changed`) are added as sessions appear;
 * `pane.updated` carries agent_status too and needs no pane_id, so it is the
 * safety net for panes we did not start ourselves.
 */
const GLOBAL_SUBSCRIPTIONS = [
  { type: 'pane.created' },
  { type: 'pane.updated' },
  { type: 'pane.closed' },
  { type: 'pane.exited' },
  { type: 'pane.agent_detected' },
  { type: 'workspace.created' },
  { type: 'workspace.closed' },
  { type: 'workspace.updated' },
];

/**
 * Client for herdr's newline-delimited JSON socket.
 *
 * herdr answers one request per connection and then hangs up, so every call
 * gets its own short-lived socket. Only event subscriptions are long-lived,
 * and those get a dedicated connection that reconnects on its own.
 */
export class Herdr extends EventEmitter {
  #seq = 0;
  #subSock = null;
  #subBuf = '';
  #closed = false;
  #paneSocks = new Map();

  constructor({ socketPath = SOCKET_PATH, bin = process.env.CON_HERDR_BIN || process.env.HELM_HERDR_BIN || 'herdr' } = {}) {
    super();
    this.socketPath = socketPath;
    this.bin = bin;
  }

  // ------------------------------------------------------------------ server

  async isRunning() {
    try {
      const { stdout } = await exec(this.bin, ['status'], { timeout: 5000 });
      return /status:\s*running/.test(stdout);
    } catch {
      return false;
    }
  }

  /** Bring up a headless server if this machine has nobody sitting at it. */
  async ensureServer() {
    if (await this.isRunning()) return true;

    const child = spawn(this.bin, ['server'], { detached: true, stdio: 'ignore' });
    let launchError = null;
    child.once('exit', (code, signal) => {
      // A clean exit may mean the command daemonised successfully. The
      // status probe below is authoritative; only an actual launch failure
      // is useful to surface early.
      if (signal || code) {
        launchError = signal
          ? `herdr server exited from signal ${signal}`
          : `herdr server exited with code ${code}`;
      }
    });

    // spawn failures are emitted asynchronously. A try/catch around spawn()
    // cannot see ENOENT, so without this handler a missing herdr binary takes
    // the entire CLI down as an unhandled EventEmitter error.
    await new Promise((resolve, reject) => {
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
      child.once('error', (err) => {
        const message = err.code === 'ENOENT'
          ? `herdr executable "${this.bin}" was not found; install herdr or set CON_HERDR_BIN`
          : `could not start herdr executable "${this.bin}": ${err.message}`;
        reject(Object.assign(new Error(message), { cause: err }));
      });
    });

    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await this.isRunning()) return true;
      if (launchError) throw new Error(launchError);
    }
    throw new Error('herdr server did not come up');
  }

  // ------------------------------------------------------------------- calls

  call(method, params = {}, { timeout = 30_000 } = {}) {
    const id = `helm_${++this.#seq}`;
    return new Promise((resolve, reject) => {
      const sock = connect(this.socketPath);
      let buf = '';
      let settled = false;

      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        err ? reject(err) : resolve(value);
      };

      const timer = setTimeout(
        () => finish(new Error(`herdr ${method} timed out`)),
        timeout
      );
      timer.unref?.();

      sock.setNoDelay(true);
      sock.on('error', (err) => finish(err));
      sock.on('connect', () =>
        sock.write(JSON.stringify({ id, method, params }) + '\n')
      );
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        let msg;
        try {
          msg = JSON.parse(buf.slice(0, nl));
        } catch (err) {
          return finish(err);
        }
        if (msg.error) {
          const err = new Error(msg.error.message || 'herdr error');
          err.code = msg.error.code;
          return finish(err);
        }
        finish(null, msg.result);
      });
      sock.on('close', () =>
        finish(new Error(`herdr closed before answering ${method}`))
      );
    });
  }

  ping() { return this.call('ping'); }

  // ------------------------------------------------------------------ events

  /**
   * Watch one pane's agent status.
   *
   * These get their own connection rather than being folded into the global
   * stream: re-subscribing means tearing the socket down and rebuilding it,
   * and any event that lands in that window is simply lost.
   */
  watchPane(paneId) {
    if (this.#paneSocks.has(paneId)) return;
    const open = () => {
      if (this.#closed || !this.#paneSocks.has(paneId)) return;
      const sock = connect(this.socketPath);
      this.#paneSocks.set(paneId, sock);
      let buf = '';
      sock.setNoDelay(true);
      sock.on('connect', () =>
        sock.write(
          JSON.stringify({
            id: `helm_pane_${paneId}`,
            method: 'events.subscribe',
            params: {
              subscriptions: [
                { type: 'pane.agent_status_changed', pane_id: paneId },
                { type: 'pane.scroll_changed', pane_id: paneId },
              ],
            },
          }) + '\n'
        )
      );
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.error) { this.emit('events:error', msg.error); continue; }
          const body = msg.result ?? msg;
          if (!body?.event || body.type === 'subscription_started') continue;
          this.emit('event', body);
        }
      });
      const retry = () => {
        if (this.#closed || this.#paneSocks.get(paneId) !== sock) return;
        setTimeout(open, 1500);
      };
      sock.on('error', retry);
      sock.on('close', retry);
    };
    this.#paneSocks.set(paneId, null);
    open();
  }

  unwatchPane(paneId) {
    this.#paneSocks.get(paneId)?.destroy();
    this.#paneSocks.delete(paneId);
  }

  startEvents() {
    if (this.#closed) return;
    this.#subSock?.destroy();
    this.#subBuf = '';

    const sock = connect(this.socketPath);
    this.#subSock = sock;
    sock.setNoDelay(true);

    sock.on('connect', () => {
      sock.write(
        JSON.stringify({
          id: 'helm_events',
          method: 'events.subscribe',
          params: { subscriptions: GLOBAL_SUBSCRIPTIONS },
        }) + '\n'
      );
      this.emit('events:open');
    });

    sock.on('data', (chunk) => {
      this.#subBuf += chunk.toString('utf8');
      let nl;
      while ((nl = this.#subBuf.indexOf('\n')) !== -1) {
        const line = this.#subBuf.slice(0, nl).trim();
        this.#subBuf = this.#subBuf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.error) { this.emit('events:error', msg.error); continue; }
        const body = msg.result ?? msg;
        if (!body?.event || body.type === 'subscription_started') continue;
        this.emit('event', body);
      }
    });

    const retry = () => {
      if (this.#closed || this.#subSock !== sock) return;
      this.#subSock = null;
      setTimeout(() => this.startEvents(), 1500);
    };
    sock.on('error', retry);
    sock.on('close', retry);
  }

  close() {
    this.#closed = true;
    this.#subSock?.destroy();
    for (const sock of this.#paneSocks.values()) sock?.destroy();
    this.#paneSocks.clear();
  }
}
