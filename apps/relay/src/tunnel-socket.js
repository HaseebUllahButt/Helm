import { Duplex } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { T } from '@helm/protocol';

const OPEN_TIMEOUT_MS = 10_000;

/**
 * A byte stream to 127.0.0.1:<port> on another machine, carried over the
 * WebSocket that machine holds open to this hub.
 *
 * It looks enough like a net.Socket that Node's http client and a raw
 * upgrade pipe can use it. Underneath it speaks the same TUNNEL_* frames the
 * ssh ProxyCommand uses, through the hub's own `routeTunnel` - but as an
 * in-process initiator, so the hub can open tunnels without a WebSocket of
 * its own. `routeTunnel` only needs an initiator with `readyState === 1` and
 * a `send(string)`; that is what `peer` below provides.
 */
export class TunnelSocket extends Duplex {
  #ready = false;
  #closed = false;
  #queue = [];
  #timer;
  #route;

  constructor({ target, port, routeTunnel, env }) {
    super();
    this.sid = randomBytes(6).toString('hex');
    this.#route = routeTunnel;
    this.peer = {
      readyState: 1,
      local: true,
      send: (raw) => this.#onFrame(JSON.parse(raw)),
    };
    this.#timer = setTimeout(
      () => this.destroy(new Error('tunnel open timed out')), OPEN_TIMEOUT_MS
    );
    this.#timer.unref?.();
    // `env` is what routeTunnel resolves; the target socket is looked up there.
    routeTunnel(this.peer, { t: T.TUNNEL_OPEN, sid: this.sid, env: env ?? target?.envId, port });
  }

  // What http.request and friends poke at on a socket.
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  setTimeout() { return this; }
  ref() { return this; }
  unref() { return this; }
  get remoteAddress() { return 'tunnel'; }

  #onFrame(msg) {
    if (msg.sid !== this.sid) return;
    if (msg.t === T.TUNNEL_READY) {
      this.#ready = true;
      clearTimeout(this.#timer);
      for (const chunk of this.#queue) this.#sendData(chunk);
      this.#queue = [];
      this.emit('connect');
      return;
    }
    if (msg.t === T.TUNNEL_DATA) {
      this.push(Buffer.from(msg.data, 'base64'));
      return;
    }
    if (msg.t === T.TUNNEL_CLOSE) {
      this.#closed = true;
      clearTimeout(this.#timer);
      if (this.#ready) { this.push(null); this.end(); }
      else this.destroy(new Error(msg.reason || 'tunnel refused'));
    }
  }

  #sendData(chunk) {
    this.#route(this.peer, { t: T.TUNNEL_DATA, sid: this.sid, data: chunk.toString('base64') });
  }

  #sendClose(reason) {
    if (this.#closed) return;
    this.#closed = true;
    this.#route(this.peer, { t: T.TUNNEL_CLOSE, sid: this.sid, reason });
  }

  _write(chunk, _enc, cb) {
    if (this.#ready) this.#sendData(chunk);
    else this.#queue.push(chunk);
    cb();
  }

  _read() {}

  _final(cb) { this.#sendClose('done'); cb(); }

  _destroy(err, cb) {
    clearTimeout(this.#timer);
    this.#sendClose(err ? err.message : 'closed');
    cb(err);
  }
}
