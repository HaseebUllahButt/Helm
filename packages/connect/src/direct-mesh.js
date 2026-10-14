import { randomBytes, randomUUID } from 'node:crypto';
import { M } from '@helm/protocol';
import { directPeer } from './direct-rpc.js';

/**
 * Direct channels from this machine to the others it talks to.
 *
 * Every request to another machine used to go through a hub: this machine,
 * a hub, that machine, and back. When the hub is far - the laptop's link to
 * the VM crosses a VPN worth ~600ms - that is the whole cost of a click. The
 * same WebRTC that already carries a phone's session straight to a machine
 * can carry these too: the hubs introduce the two machines once, then step
 * aside and stay as the backup.
 *
 * A channel opens in the background the first time this machine asks the
 * other something, so the first request still takes a hub and only later
 * ones can go direct. It is kept alive by the same ping that times it, tried
 * again with a growing wait when it fails, and closed after a while unused.
 * Which way a request actually goes is hub-mesh.js's choice, on the numbers
 * this keeps: a "direct" WebRTC path can itself go through a VPN, so it is
 * used only when it is measured faster.
 *
 * Nothing here decides who may ask what. The other machine checks every
 * request against the introduced identity (peer.js directCaller). Machine
 * offers also prove possession of the roster's signing key (direct-auth.js),
 * since an older hub can introduce a machine in a name the sender chose.
 */
const CONNECT_TIMEOUT_MS = 15_000;
const PING_TIMEOUT_MS = 10_000;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 5 * 60_000;
// A channel that dies this soon after opening is counted as a failure, so
// one that opens and drops in a loop backs off instead of retrying every 2s.
const STEADY_MS = 30_000;
const IDLE_MS = 15 * 60_000;
const SMOOTHING = 0.3;

export class DirectMesh {
  /**
   * @param {object} o
   * @param {() => object} o.network              the roster
   * @param {(env, peer, payload) => void} o.signal  send a signalling blob through a hub
   * @param {(peer) => void} o.forget             tell the hubs a signalling id is done
   * @param {(env) => boolean} o.supports         whether that machine's Helm answers direct channels
   * @param {(env) => void} [o.changed]           a channel opened, closed or was timed
   * @param {() => boolean} [o.enabled]          the live off switch
   */
  constructor({ network, signal, forget = () => {}, supports, changed = () => {}, now = () => performance.now(), makePeer = directPeer, enabled = () => true }) {
    Object.assign(this, { network, sendSignal: signal, forget, supports, changed, now, makePeer, enabled });
    this.channels = new Map(); // env -> channel
    this.waits = new Map();    // env -> { failures, retryAt }
    this.used = new Map();     // env -> when a request last wanted a channel
  }

  /** A request is headed for this machine: have a channel ready for the next one. */
  want(env) {
    this.used.set(env, this.now());
    this.#open(env);
  }

  #usable(env) {
    const net = this.network();
    return this.enabled() && !!net?.self && env !== net.self && Object.hasOwn(net.machines ?? {}, env)
      && !net.revoked?.[env] && !net.revoked?.[net.self];
  }

  #open(env) {
    if (this.channels.has(env) || !this.#usable(env) || !this.supports(env)) return;
    const wait = this.waits.get(env);
    if (wait && this.now() < wait.retryAt) return;
    const channel = {
      env, id: `dm-${randomBytes(8).toString('hex')}`, state: 'connecting',
      ms: null, probing: null, opened: null, pending: new Map(), peer: null,
    };
    this.channels.set(env, channel);
    try {
      channel.peer = this.makePeer({
        env,
        signal: (payload) => this.sendSignal(env, channel.id, payload),
        onMessage: (message) => this.#message(channel, message),
        onClose: () => this.#closed(channel),
        connectTimeout: CONNECT_TIMEOUT_MS,
      });
    } catch {
      this.#closed(channel);
      return;
    }
    channel.peer.ready.then(() => {
      if (this.channels.get(env) !== channel) return;
      channel.state = 'open';
      channel.opened = this.now();
      this.ping(env);
      this.changed(env);
    }, () => {});
  }

  /** A signalling blob from a hub. True if it belonged to one of our channels. */
  receive(frame) {
    const channel = this.channels.get(frame?.env);
    if (!channel || channel.id !== frame.peer) return false;
    channel.peer?.receive(frame.payload)?.catch?.(() => {});
    return true;
  }

  #message(channel, message) {
    if (message?.t !== 'rpcResult') return;
    const request = channel.pending.get(message.id);
    if (!request) return;
    channel.pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.ok) request.resolve(message.result);
    else request.reject(Object.assign(new Error(message.error?.message ?? 'remote request failed'), { code: message.error?.code, rpc: true }));
  }

  #closed(channel) {
    if (this.channels.get(channel.env) !== channel) return;
    this.channels.delete(channel.env);
    try { channel.peer?.close(); } catch {}
    this.forget(channel.id);
    // Requests already on their way may have run over there: they fail as
    // uncertain and are never sent again another way. One still queued
    // behind them never left, and its own send failure says so.
    for (const [id, request] of channel.pending) {
      if (!request.started) continue;
      channel.pending.delete(id);
      clearTimeout(request.timer);
      request.reject(Object.assign(new Error('direct channel closed; delivery may be uncertain'), { code: 'disconnected', uncertain: true }));
    }
    const steady = channel.opened != null && this.now() - channel.opened >= STEADY_MS;
    const wait = this.waits.get(channel.env) ?? { failures: 0, retryAt: 0 };
    wait.failures = steady ? 0 : wait.failures + 1;
    const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** wait.failures);
    wait.retryAt = this.now() + delay * (0.75 + Math.random() * 0.5);
    this.waits.set(channel.env, wait);
    this.changed(channel.env);
  }

  #drop(env) {
    const channel = this.channels.get(env);
    if (channel) this.#closed(channel);
  }

  isOpen(env) {
    return this.#usable(env) && this.channels.get(env)?.state === 'open';
  }

  /**
   * The round trip over the channel, as far as we know it - a ping still out
   * counting as at least as long as it has been out, like hub-mesh.js does
   * for hubs, so a channel that has gone quiet loses to the hub on its own.
   */
  estimate(env) {
    const channel = this.channels.get(env);
    if (!this.#usable(env) || channel?.state !== 'open' || channel.ms == null) return null;
    const waiting = channel.probing != null ? this.now() - channel.probing : 0;
    return { ms: Math.max(channel.ms, waiting), known: true };
  }

  /**
   * One request over the channel. Fails with `unsent` when nothing left -
   * safe to send another way - and `uncertain` when it may have arrived.
   */
  call(env, method, params, { sub, timeout = 130_000 } = {}) {
    const channel = this.channels.get(env);
    if (!this.#usable(env) || channel?.state !== 'open') {
      return Promise.reject(Object.assign(new Error('no direct channel'), { code: 'disconnected', unsent: true }));
    }
    return new Promise((resolve, reject) => {
      const id = `dm-${randomUUID()}`;
      const request = { resolve, reject, started: false, timer: null };
      request.timer = setTimeout(() => {
        channel.pending.delete(id);
        reject(Object.assign(new Error('remote request timed out; delivery may be uncertain'), { code: 'timeout', uncertain: true }));
        // The send may still be queued or waiting on backpressure. Closing
        // prevents an expired write from being dispatched later, and releases
        // every other pending request on this stalled channel.
        if (this.channels.get(env) === channel) this.#drop(env);
      }, timeout);
      request.timer.unref?.();
      channel.pending.set(id, request);
      channel.peer.send({ t: 'rpc', id, method, params, sub }, () => { request.started = true; }).catch((error) => {
        if (channel.pending.get(id) !== request) return;
        channel.pending.delete(id);
        clearTimeout(request.timer);
        reject(error?.unsent
          ? Object.assign(new Error('direct channel closed before sending'), { code: 'disconnected', unsent: true })
          : Object.assign(new Error('direct channel failed while sending; delivery may be uncertain'), { code: 'disconnected', uncertain: true }));
        // Part of a frame went and the rest could not: the channel is wedged.
        if (!error?.unsent) this.#drop(env);
      });
    });
  }

  /** Time the channel with the same `ping` a hub route is timed with. */
  ping(env) {
    const channel = this.channels.get(env);
    if (channel?.state !== 'open' || channel.probing != null) return;
    const started = this.now();
    channel.probing = started;
    this.call(env, M.PING, {}, { sub: this.network()?.self, timeout: PING_TIMEOUT_MS })
      .then(() => {
        const ms = this.now() - started;
        channel.ms = channel.ms == null ? ms : channel.ms + SMOOTHING * (ms - channel.ms);
      }, (error) => {
        // No answer, or the other machine no longer takes this channel:
        // either way it is no route. Close it and let the backoff retry.
        if (error.code === 'timeout' || error.code === 'forbidden') this.#drop(env);
      })
      .finally(() => {
        channel.probing = null;
        if (this.channels.get(env) === channel) this.changed(env);
      });
  }

  /** The keepalive round: time open channels, retry wanted ones, close idle ones. */
  tick() {
    for (const [env, last] of this.used) {
      if (this.now() - last > IDLE_MS || !this.#usable(env)) {
        // Closed for being idle, not for failing: no wait before the next.
        this.used.delete(env);
        this.#drop(env);
        this.waits.delete(env);
        continue;
      }
      if (this.isOpen(env)) this.ping(env);
      else this.#open(env);
    }
  }

  networkChanged() {
    this.waits.clear();
    for (const [env, channel] of this.channels) {
      if (channel.state === 'connecting') {
        this.#drop(env);
        this.waits.delete(env);
      } else {
        channel.ms = null;
        this.ping(env);
      }
    }
    this.tick();
  }

  /** A machine taken out of the network loses its channel at once. */
  dropRevoked(revoked = {}) {
    const self = this.network()?.self;
    for (const env of [...this.channels.keys()]) {
      if (revoked[env] || (self && revoked[self])) {
        this.used.delete(env);
        this.#drop(env);
        this.waits.delete(env);
      }
    }
    for (const env of this.waits.keys()) if (revoked[env] || revoked[self]) this.waits.delete(env);
    for (const env of this.used.keys()) if (revoked[env] || revoked[self]) this.used.delete(env);
  }

  /** What `helm status` says about the direct channel to one machine. */
  status(env) {
    if (!this.enabled()) return { state: 'off', ms: null };
    const channel = this.channels.get(env);
    if (channel) return { state: channel.state, ms: channel.ms == null ? null : Math.round(channel.ms) };
    if (!this.supports(env)) return { state: 'unsupported', ms: null };
    if (this.waits.get(env)?.failures) return { state: 'retrying', ms: null };
    return { state: 'off', ms: null };
  }

  stop() {
    this.used.clear();
    for (const env of [...this.channels.keys()]) this.#drop(env);
    this.waits.clear();
  }
}
