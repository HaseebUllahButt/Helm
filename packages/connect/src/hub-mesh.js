import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { T, M } from '@helm/protocol';
import { DirectMesh } from './direct-mesh.js';

/**
 * How often each route to a machine is timed, when there is more than one.
 *
 * A route is one round trip: this machine, a hub, the machine behind it, and
 * back. Several hubs usually know a machine - its own, the VM's, anyone else
 * it dials - and they are not alike: the laptop's link to the VM crosses a
 * VPN that adds ~600ms, while the laptop's own hub on the same wifi answers
 * in ~3ms. Timing the whole trip, not just the first hop, is what makes
 * those comparable: a hub that answers fast is no use if its own link to
 * the machine is the slow one.
 */
const PROBE_EVERY_MS = 20_000;
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Moving to another route has to be a clear win, and rare. One slow sample
 * behind a big transfer must not send the next request somewhere else and
 * back again: the new route has to be under 70% of the old one *and* at
 * least 20ms quicker, and a route is kept at least 30 seconds once chosen.
 */
const SWITCH_RATIO = 0.7;
const SWITCH_MIN_GAIN_MS = 20;
const SWITCH_HOLD_MS = 30_000;

/** How much one new sample moves the running estimate. */
const SMOOTHING = 0.3;

/**
 * Requests that only read, so asking again after a direct channel died
 * under them cannot do anything twice. Everything else that may have
 * arrived fails as uncertain rather than being sent again over a hub.
 */
const READS = new Set([
  M.PING, M.ENV_INFO, M.SESSION_LIST, M.SESSION_EVENTS, M.FS_LIST, M.FS_ROOTS, M.FS_SEARCH,
  M.GIT_STATUS, M.GIT_GRAPH, M.GIT_DIFF, M.GIT_COMMIT, M.USAGE_REPORT, M.USAGE_LIMITS, M.NET_ROUTES,
]);

export class HubMesh {
  constructor(network, changed, event, signalEvent, { now = () => performance.now(), probeEvery = PROBE_EVERY_MS, direct = null } = {}) {
    this.network = network;
    this.changed = changed;
    this.event = event;
    this.signalEvent = signalEvent;
    this.signals = new Map();
    this.links = new Map();
    this.pending = new Map();
    this.subscriptions = [];
    this.now = now;
    this.probeEvery = probeEvery;
    // link -> machine id -> { ms, probing }: the round trip through that hub.
    this.timing = new Map();
    // machine id -> { link, since }: the route new requests take.
    this.routes = new Map();
    this.timer = null;
    // Direct channels to the machines behind these hubs, opened when we
    // first talk to one (direct-mesh.js). `direct` is true, or the WebRTC
    // peer maker for tests; off, every request takes a hub as before.
    this.direct = direct ? new DirectMesh({
      network, now: this.now,
      signal: (env, peer, payload) => this.signal(env, peer, payload, network()?.self),
      forget: (peer) => this.forgetPeer(peer),
      supports: (env) => this.supportsDirect(env),
      // A channel just came up: time the hub route too, so the two can be
      // compared within a second rather than at the next round.
      changed: (env) => { if (this.direct?.isOpen(env)) for (const link of this.#candidates(env)) this.probe(link, env); },
      ...(typeof direct === 'object' ? direct : {}),
    }) : null;
    // machine id -> { on, since }: whether new requests take the channel.
    this.directUse = new Map();
  }

  up(link) {
    this.links.set(link, new Map());
    this.timing.set(link, new Map());
    link.send(T.HUB_WATCH, { envs: this.subscriptions });
    if (!this.timer && this.probeEvery > 0) {
      this.timer = setInterval(() => this.probeAll(), this.probeEvery);
      this.timer.unref?.();
    }
  }

  down(link) {
    this.links.delete(link);
    this.timing.delete(link);
    for (const [env, route] of this.routes) {
      if (route.link === link) this.routes.delete(env);
    }
    for (const [key, route] of this.signals) {
      if (route.link === link) this.signals.delete(key);
    }
    for (const [id, request] of this.pending) {
      if (request.link !== link) continue;
      this.pending.delete(id);
      clearTimeout(request.timer);
      request.reject(new Error('hub link disconnected; delivery may be uncertain'));
    }
    this.changed();
  }

  watch(envs) {
    this.subscriptions = [...envs];
    for (const link of this.links.keys()) link.send(T.HUB_WATCH, { envs: this.subscriptions });
  }

  machines() {
    const network = this.network();
    const machines = new Map();
    for (const [link, snapshot] of this.links) {
      if (!link.connected) continue;
      for (const [id, machine] of snapshot) {
        if (id !== network?.self && Object.hasOwn(network?.machines ?? {}, id) && !network.revoked?.[id]) machines.set(id, machine);
      }
    }
    return machines;
  }

  receive(link, frame) {
    if (!this.links.has(link)) return false;
    if (frame.t === T.HUB_SIGNAL) {
      const route = this.signals.get(`${frame.peer}:${frame.env}`);
      if (route?.link === link && this.machines().has(frame.env)
          && [T.SIGNAL, T.SIGNAL_READY].includes(frame.kind)
          && !this.direct?.receive(frame)) this.signalEvent?.(frame);
      return true;
    }
    if (frame.t === T.HUB_STATE && Array.isArray(frame.machines)) {
      const before = this.links.get(link);
      this.links.set(link, new Map(frame.machines.filter(machine => typeof machine?.id === 'string').map(machine => [machine.id, machine])));
      // A machine newly seen through this hub may now have a second route.
      // Time every route to it straight away, so the choice is made on
      // numbers within a second rather than at the next round.
      for (const id of this.links.get(link).keys()) {
        if (before.has(id)) continue;
        for (const candidate of this.#candidates(id)) this.probe(candidate, id);
      }
      this.changed();
      return true;
    }
    if (frame.t === T.HUB_EVENT) {
      const network = this.network();
      if (this.links.get(link).has(frame.env) && Object.hasOwn(network?.machines ?? {}, frame.env) && !network.revoked?.[frame.env]) this.event(frame);
      return true;
    }
    if (frame.t !== T.RPC_RESULT) return false;
    const request = this.pending.get(frame.id);
    if (!request || request.link !== link) return false;
    this.pending.delete(frame.id);
    clearTimeout(request.timer);
    if (frame.ok) request.resolve(frame.result);
    else request.reject(Object.assign(new Error(frame.error?.message ?? 'remote request failed'), { code: frame.error?.code }));
    return true;
  }

  /**
   * Is this hub the machine's own? Its address is one the machine publishes,
   * or one it announced on the local network and that hub then showed it
   * attached. Its own hub reaches it on loopback; any other hub adds a leg.
   */
  ownHub(link, env) {
    if (link.hintFor === env) return true;
    return !!link.url && (this.network()?.machines?.[env]?.endpoints ?? []).includes(link.url);
  }

  /**
   * The round trip through one hub to one machine, as far as we know it. A
   * probe still out counts as at least as long as it has been out: a route
   * that has gone quiet for two seconds is not a 3ms route any more.
   */
  estimate(link, env) {
    const slot = this.timing.get(link)?.get(env);
    if (!slot) return null;
    const waiting = slot.probing != null ? this.now() - slot.probing : 0;
    if (slot.ms == null) return waiting > 0 ? { ms: waiting, known: false } : null;
    return { ms: Math.max(slot.ms, waiting), known: true };
  }

  #candidates(env) {
    return [...this.links].filter(([link, machines]) => link.connected && machines.has(env)).map(([link]) => link);
  }

  /**
   * Fastest measured first; then, among routes not timed yet, the
   * machine's own hub before a third party; then the order links came up,
   * which is how this always chose before there were numbers.
   */
  #rank(env, links) {
    const key = (link) => {
      const e = this.estimate(link, env);
      return [e?.known ? e.ms : Infinity, this.ownHub(link, env) ? 0 : 1];
    };
    return links.map((link, index) => ({ link, index, key: key(link) }))
      .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.index - b.index)
      .map(({ link }) => link);
  }

  #clearlyBetter(env, next, current) {
    const a = this.estimate(next, env);
    const b = this.estimate(current, env);
    if (!a?.known) return false;
    // Nothing known about the current route: only its own hub is worth
    // moving for, since that is one leg fewer whatever the numbers say.
    if (!b) return this.ownHub(next, env) && !this.ownHub(current, env);
    return a.ms < b.ms * SWITCH_RATIO && b.ms - a.ms > SWITCH_MIN_GAIN_MS;
  }

  /**
   * The link new requests to this machine go through. Requests already sent
   * stay on the link they went out on: a write whose fate is unknown is never
   * sent again another way, so moving only ever affects what comes next.
   */
  route(env) {
    const candidates = this.#candidates(env);
    if (!candidates.length) { this.routes.delete(env); return null; }
    const best = this.#rank(env, candidates)[0];
    const current = this.routes.get(env);
    if (!current || !candidates.includes(current.link)) {
      // The first choice, or the old route is gone. The machine's own hub
      // goes first unless another is already measured clearly faster - the
      // first timing back must not beat one that simply has not answered
      // yet. No hold to respect, so a real measurement can still correct
      // this guess at once.
      const own = candidates.find((link) => this.ownHub(link, env));
      const first = own && best !== own && !this.#clearlyBetter(env, best, own) ? own : best;
      this.routes.set(env, { link: first, since: -Infinity });
      return first;
    }
    if (best !== current.link && this.now() - current.since >= SWITCH_HOLD_MS
        && this.#clearlyBetter(env, best, current.link)) {
      this.routes.set(env, { link: best, since: this.now() });
      return best;
    }
    return current.link;
  }

  /**
   * Time the trip to one machine through one hub, with a `ping` the machine
   * has always answered - so a hub or daemon from before this change is
   * measured like any other. Only worth doing when there is a choice.
   */
  probe(link, env) {
    const network = this.network();
    if (!link.connected || env === network?.self || !Object.hasOwn(network?.machines ?? {}, env) || network.revoked?.[env]) return;
    if (this.#candidates(env).length < 2 && !this.direct?.isOpen(env)) return;
    const slots = this.timing.get(link);
    if (!slots) return;
    const slot = slots.get(env) ?? { ms: null, probing: null };
    if (slot.probing != null) return;
    slots.set(env, slot);
    const started = this.now();
    slot.probing = started;
    const record = (ms) => {
      slot.ms = slot.ms == null ? ms : slot.ms + SMOOTHING * (ms - slot.ms);
    };
    this.#request(link, env, M.PING, {}, { sub: network.self, timeout: PROBE_TIMEOUT_MS })
      .then(() => record(this.now() - started),
        // Too slow to answer at all is the slowest there is; a hub saying the
        // machine is not with it any more is not a time.
        (error) => { if (error.code === 'timeout') record(PROBE_TIMEOUT_MS); })
      .finally(() => {
        slot.probing = null;
        if (this.links.has(link)) this.route(env);
      });
  }

  probeAll() {
    for (const [link, machines] of this.links) {
      for (const env of machines.keys()) this.probe(link, env);
    }
    this.direct?.tick();
  }

  /**
   * Whether that machine's Helm takes direct channels from machines. Read
   * from what it told its hubs when it attached; an older Helm says nothing
   * and every request to it keeps going through a hub.
   */
  supportsDirect(env) {
    for (const [link, machines] of this.links) {
      if (link.connected && machines.get(env)?.info?.directRpc === 1) return true;
    }
    return false;
  }

  /**
   * Whether new requests to this machine take the direct channel rather
   * than `link`, the hub route. The same rule as moving between hubs - a
   * clear win, measured, and not more than once every 30 seconds - because
   * a direct path is not automatically a short one: it can cross the same
   * VPN the hub does. A channel that is down or not yet timed is not used.
   */
  #preferDirect(env, link) {
    const state = this.directUse.get(env) ?? { on: false, since: -Infinity };
    const direct = this.direct?.estimate(env);
    if (!direct?.known) {
      if (state.on) this.directUse.set(env, { on: false, since: this.now() });
      return false;
    }
    const hub = this.estimate(link, env);
    const settled = this.now() - state.since >= SWITCH_HOLD_MS;
    if (hub?.known && settled) {
      const faster = (a, b) => a.ms < b.ms * SWITCH_RATIO && b.ms - a.ms > SWITCH_MIN_GAIN_MS;
      if (!state.on && faster(direct, hub)) {
        this.directUse.set(env, { on: true, since: this.now() });
        return true;
      }
      if (state.on && faster(hub, direct)) {
        this.directUse.set(env, { on: false, since: this.now() });
        return false;
      }
    }
    return state.on;
  }

  /**
   * A request may go direct when this machine is asking for itself or for a
   * phone or browser attached to it - the two cases the other machine
   * accepts on a channel (peer.js directCaller). A call this hub passes on
   * for another machine stays on a hub, where that is allowed.
   */
  #mayGoDirect(network, sub) {
    return sub === network.self
      || (typeof sub === 'string' && Object.hasOwn(network.devices ?? {}, sub) && !network.revoked?.[sub]);
  }

  /** Close the channels of machines taken out of the network. */
  dropRevoked(revoked) {
    this.direct?.dropRevoked(revoked);
    for (const env of Object.keys(revoked ?? {})) this.directUse.delete(env);
  }

  /** Which way each reachable machine is reached, and how long it takes. */
  table() {
    return [...this.machines().keys()].map((env) => {
      const link = this.route(env);
      const via = (candidate) => ({
        url: candidate.url ?? null,
        own: this.ownHub(candidate, env),
        ms: this.estimate(candidate, env)?.known ? Math.round(this.estimate(candidate, env).ms) : null,
        hubMs: typeof candidate.rtt === 'number' ? Math.round(candidate.rtt) : null,
      });
      const row = { env, ...via(link), others: this.#candidates(env).filter((c) => c !== link).map(via) };
      if (this.direct) row.direct = { ...this.direct.status(env), used: this.#preferDirect(env, link) };
      return row;
    });
  }

  call(env, method, params, { sub, timeout = 130_000 } = {}) {
    const network = this.network();
    if (!Object.hasOwn(network?.machines ?? {}, env) || network.revoked?.[env]) return Promise.reject(new Error('unknown machine'));
    const link = this.route(env);
    if (!link) return Promise.reject(Object.assign(new Error('environment is not connected'), { code: 'offline' }));
    const asker = sub ?? network.self;
    if (this.direct && this.#mayGoDirect(network, asker)) {
      this.direct.want(env);
      if (this.#preferDirect(env, link)) return this.#callDirect(env, method, params, { sub: asker, timeout });
    }
    return this.#request(link, env, method, params, { sub: asker, timeout });
  }

  /**
   * One request over the direct channel, with the hub as the backup. It
   * moves to a hub only when it certainly never left, or when it only
   * reads; a write that may have arrived fails as uncertain, exactly as one
   * lost on a hub link does, and is never sent a second time.
   */
  #callDirect(env, method, params, { sub, timeout }) {
    return this.direct.call(env, method, params, { sub, timeout }).catch((error) => {
      if (error.rpc) throw error;
      if (!error.unsent && !(error.code === 'disconnected' && READS.has(method))) throw error;
      const link = this.route(env);
      if (!link) throw Object.assign(new Error('environment is not connected'), { code: 'offline' });
      return this.#request(link, env, method, params, { sub, timeout });
    });
  }

  #request(link, env, method, params, { sub, timeout }) {
    return new Promise((resolve, reject) => {
      const id = `mesh-${randomUUID()}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('remote request timed out; delivery may be uncertain'), { code: 'timeout' }));
      }, timeout);
      timer.unref?.();
      this.pending.set(id, { link, resolve, reject, timer });
      link.send(T.HUB_RPC, { id, env, method, params, sub });
    });
  }

  signal(env, peer, payload, device) {
    if (!this.machines().has(env)) return;
    const key = `${peer}:${env}`;
    let route = this.signals.get(key);
    if (!route || payload?.type === 'offer') {
      const link = this.route(env);
      if (!link) return;
      route = { link, peer, env };
      this.signals.set(key, route);
    }
    route.link.send(T.HUB_SIGNAL, { env, peer, payload, device });
  }

  forgetPeer(peer) {
    const links = new Set();
    for (const [key, route] of this.signals) {
      if (route.peer !== peer) continue;
      links.add(route.link);
      this.signals.delete(key);
    }
    for (const link of links) link.send(T.HUB_SIGNAL_CLOSE, { peer });
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.direct?.stop();
    for (const link of [...this.links.keys()]) this.down(link);
  }
}

/**
 * `helm status`'s account of how each machine is reached, one line each.
 * Times are whole round trips through that hub to the machine and back; a
 * hub's own ping is shown only when that is all there is.
 */
export function routeLines(report) {
  const ms = (n) => (n == null ? '' : `${n}ms`);
  const width = Math.max(8, ...(report.machines ?? []).map((m) => String(m.name).length));
  const lines = (report.machines ?? []).map((m) => {
    const name = String(m.name).padEnd(width);
    if (m.attached) return `  ${name}  connected straight to this machine${m.hubMs != null ? ` (${ms(m.hubMs)} to its hub)` : ''}`;
    if (!m.url) return `  ${name}  not reachable right now`;
    const time = m.ms != null ? ms(m.ms) : m.hubMs != null ? `${ms(m.hubMs)} to the hub, not timed through it` : 'not timed yet';
    const hub = `${m.own ? 'via its own hub' : 'through'} ${m.url}  ${time}`;
    const others = (m.others ?? []).map((o) => `${o.url}${o.ms != null ? ` ${ms(o.ms)}` : ''}`);
    const pad = `\n  ${' '.repeat(width)}  `;
    const d = m.direct;
    // Direct and in use: that is the route, and the hub is the backup.
    if (d?.used) return `  ${name}  direct  ${ms(d.ms)}${pad}backup: ${hub}${others.length ? `${pad}also: ${others.join(', ')}` : ''}`;
    const note = !d ? null
      : d.state === 'open' ? `direct ${ms(d.ms) || 'not timed yet'}, not faster so not used`
        : d.state === 'connecting' ? 'direct: connecting'
          : d.state === 'retrying' ? 'direct: could not connect, trying again'
            : d.state === 'unsupported' ? 'direct: its Helm is too old, hub only'
              : null;
    return `  ${name}  ${hub}` +
      (others.length ? `${pad}also: ${others.join(', ')}` : '') +
      (note ? `${pad}${note}` : '');
  });
  const lan = report.lan;
  const names = new Map((report.machines ?? []).map((m) => [m.env, m.name]));
  lines.push(lan?.on
    ? `  local network: listening${lan.heard?.length ? `; heard ${lan.heard.map((h) => `${names.get(h.id) ?? h.id} at ${h.url}`).join(', ')}` : ', nobody heard yet'}`
    : `  local network: off${lan?.reason ? ` (${lan.reason})` : ''}`);
  return lines;
}
