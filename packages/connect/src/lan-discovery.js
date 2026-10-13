import dgram from 'node:dgram';
import { proofOf } from '@helm/protocol/identity';
import { loadSettings } from './settings.js';
import { broadcastAddresses, isPrivateV4, lanIsRoutable } from './net-addr.js';

/**
 * Machines on the same network finding each other without the roster.
 *
 * The roster carries each machine's LAN address, but it is often wrong in
 * exactly the moment it matters: a laptop that just moved to the home wifi
 * advertises its new address only after its next tick reaches a hub the
 * others can also reach - and the hub they share is the VM, over the VPN
 * that made the trip slow in the first place. So each machine also says
 * "I am here, my hub is on port N" to its own network, and the others dial
 * that address directly.
 *
 * A plain UDP broadcast, not mDNS. mDNS would mean a DNS packet parser or a
 * dependency, and port 5353 already belongs to the system's own responder
 * (Avahi, Bonjour) on most desktops; all we need is for Helm machines to
 * hear each other, and one small datagram to the subnet's broadcast address
 * does that. Neither crosses a router, which is the point: same network only.
 *
 * An announcement is only ever a hint of where to dial. It names no machine
 * in the clear - the tag is a MAC over the machine id under the network's
 * key, rotated every ten minutes, so a stranger on a cafe wifi learns
 * nothing it could follow you with - and the address it points to still has
 * to pass the usual hub handshake, which proves the network key before this
 * machine says anything. A replay may admit a bounded number of dial candidates;
 * the handshake never releases a credential to a hub without the key.
 *
 * Off with `"lanDiscovery": false` in ~/.helm/config.json.
 */

/** UDP, so the same number as the hub's TCP port without getting in its way. */
export const LAN_PORT = 8787;
const ANNOUNCE_EVERY_MS = 30_000;
/** Long enough to survive two lost announcements in a row. */
const HINT_TTL_MS = 100_000;
const TAG_PERIOD_MS = 10 * 60_000;
const ROUTE_CHECK_MS = 5 * 60_000;
const MAX_HINTS = 32;
const MAX_HINTS_PER_MACHINE = 2;
const LABEL = 'lan-announce';

export function announceTag(net, id, period) {
  return proofOf(net.key, LABEL, `${net.id}:${id}:${period}`).slice(0, 22);
}

/**
 * On unless the owner said no. Test runs (HELM_NO_SERVICE) stay quiet on the
 * real network unless they ask for it, so a test daemon never shouts on the
 * owner's wifi.
 */
export function lanDiscoveryEnabled(cfg = loadSettings(), env = process.env) {
  if (cfg?.lanDiscovery === false || env.HELM_LAN_DISCOVERY === '0') return false;
  if (env.HELM_LAN_DISCOVERY === '1') return true;
  return env.HELM_NO_SERVICE !== '1';
}

/**
 * The hub addresses to dial, once the ones heard on the local network are
 * added to the roster's.
 *
 * Only one way into any machine's own hub at a time. That hub supersedes the
 * older socket for our machine id, so two live links into it - one through
 * the roster's address, one through a heard one - would knock each other off
 * in a loop. While the roster's address works the heard one is not needed;
 * while a heard one works, the roster's stale addresses for that machine
 * wait until it stops. With nothing up yet both are tried, and whichever
 * connects first makes the next call drop the other.
 *
 * `heard` is [{ url, id }], live hint links first. Returns the urls and,
 * for each heard address kept, the machine it should belong to.
 */
export function withHeardAddresses({ urls, net, self, mine = new Set(), heard, connected }) {
  const out = [...new Set(urls)];
  const owners = new Map();
  const machineFor = new Map();
  for (const [id, machine] of Object.entries(net.machines ?? {})) {
    if (id === self || net.revoked?.[id]) continue;
    for (const url of machine.endpoints ?? []) machineFor.set(url, id);
  }
  for (const { url, id } of heard) {
    if (id === self || mine.has(url) || net.revoked?.[id]) continue;
    const listed = net.machines?.[id]?.endpoints;
    if (!listed) continue;
    // A replay cannot relabel an address already owned by the roster.
    if (machineFor.has(url) && machineFor.get(url) !== id) continue;
    machineFor.set(url, id);
    if (!listed.includes(url)) owners.set(url, id);
    if (!out.includes(url)) out.push(url);
  }
  // Group roster addresses too: a heard address can become a roster address
  // on the very next gossip round, and a machine can publish several NICs.
  const live = new Map();
  for (const url of out) {
    const id = machineFor.get(url);
    if (id && connected(url) && !live.has(id)) live.set(id, url);
  }
  const keep = out.filter(url => !live.has(machineFor.get(url)) || live.get(machineFor.get(url)) === url);
  for (const url of owners.keys()) if (!keep.includes(url)) owners.delete(url);
  return { urls: keep, owners };
}

export class LanDiscovery {
  #socket = null;
  #timer = null;
  #tags = { period: null, at: 0, byTag: new Map() };
  #routable = { ok: true, at: -Infinity };
  #warned = false;
  #stopped = false;
  #reason = null;

  /**
   * @param {object} opts
   * @param {() => object} opts.network    the roster, read fresh each time
   * @param {number} opts.port             this machine's hub port, announced
   * @param {boolean} [opts.announce]      say we are here (listen either way)
   * @param {() => void} [opts.onChange]   a new address was heard, or one expired
   */
  constructor({
    network, port, announce = true, onChange = () => {},
    discoveryPort = LAN_PORT, bindAddress = '0.0.0.0',
    targets = () => broadcastAddresses().map((address) => ({ address, port: discoveryPort })),
    accept = isPrivateV4, enabled = () => lanDiscoveryEnabled(), routable = lanIsRoutable,
    now = Date.now, every = ANNOUNCE_EVERY_MS,
  }) {
    Object.assign(this, { network, port, announce, onChange, discoveryPort, bindAddress, targets, accept, enabled, routable, now, every });
    /** url -> { id, seen } */
    this.hints = new Map();
  }

  /** Listening and allowed to be used. */
  get active() { return !!this.#socket; }

  async start() {
    this.#stopped = false;
    await this.tick();
    this.#timer = setInterval(() => { void this.tick(); }, this.every);
    this.#timer.unref?.();
    return this;
  }

  stop() {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#timer = null;
    this.#close();
  }

  /** The addresses heard and still fresh, as { url, id }. */
  list() {
    return [...this.hints].map(([url, hint]) => ({ url, id: hint.id, seen: hint.seen }));
  }

  status() {
    return {
      on: this.active,
      reason: this.active ? null : this.#reason ?? null,
      heard: this.list().map(({ url, id }) => ({ url, id })),
    };
  }

  async tick() {
    if (this.#stopped) return;
    if (!this.enabled()) return this.#off('turned off');
    // A full-tunnel VPN sends this subnet's traffic into the tunnel: nothing
    // on the wifi would hear us, and an answer from it would never come
    // back. Do not advertise an address we cannot answer on.
    if (this.now() - this.#routable.at >= ROUTE_CHECK_MS) {
      const r = await this.routable().catch(() => null);
      this.#routable = { ok: r?.ok !== false, at: this.now() };
    }
    if (!this.#routable.ok) return this.#off('the local network is routed into a VPN');
    if (!this.#socket && !(await this.#open())) return;
    this.#reason = null;
    this.#expire();
    this.#announce();
  }

  #off(reason) {
    this.#reason = reason;
    this.#close();
    if (this.hints.size) { this.hints.clear(); this.onChange(); }
  }

  async #open() {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    try {
      await new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.bind({ port: this.discoveryPort, address: this.bindAddress }, () => {
          socket.off('error', reject);
          resolve();
        });
      });
      socket.setBroadcast(true);
    } catch (error) {
      try { socket.close(); } catch { /* never opened */ }
      this.#reason = `cannot listen on udp ${this.discoveryPort}: ${error.code ?? error.message}`;
      if (!this.#warned) console.warn(`[helm] local network discovery: ${this.#reason}`);
      this.#warned = true;
      return false;
    }
    if (this.#stopped) { socket.close(); return false; }
    // A bad packet or a vanished interface is not worth the daemon.
    socket.on('error', () => {});
    socket.on('message', (raw, rinfo) => this.#heard(raw, rinfo));
    this.#socket = socket;
    return true;
  }

  #close() {
    try { this.#socket?.close(); } catch { /* already closed */ }
    this.#socket = null;
  }

  #packet() {
    const net = this.network();
    if (!net?.key || !net.self) return null;
    const period = Math.floor(this.now() / TAG_PERIOD_MS);
    return Buffer.from(JSON.stringify({ helm: 'lan', v: 1, tag: announceTag(net, net.self, period), port: this.port }));
  }

  #announce(to = null) {
    if (!this.announce || !this.#socket) return;
    const packet = this.#packet();
    if (!packet) return;
    for (const target of to ? [to] : this.targets()) {
      this.#socket.send(packet, target.port, target.address, () => {});
    }
  }

  /**
   * Which machine a tag belongs to. The table is rebuilt each period and
   * each announce round, so a flood of datagrams costs a map lookup each,
   * not a MAC per machine per packet. Neighbouring periods count too: two
   * machines' clocks need only agree to within ten minutes.
   */
  #whose(tag) {
    const net = this.network();
    if (!net?.key) return null;
    const period = Math.floor(this.now() / TAG_PERIOD_MS);
    if (this.#tags.period !== period || this.now() - this.#tags.at >= this.every) {
      const byTag = new Map();
      for (const id of Object.keys(net.machines ?? {})) {
        if (id === net.self || net.revoked?.[id]) continue;
        for (const p of [period - 1, period, period + 1]) byTag.set(announceTag(net, id, p), id);
      }
      this.#tags = { period, at: this.now(), byTag };
    }
    const id = this.#tags.byTag.get(tag);
    return id && !net.revoked?.[id] && Object.hasOwn(net.machines ?? {}, id) ? id : null;
  }

  #heard(raw, rinfo) {
    if (raw.length > 512 || rinfo.family !== 'IPv4' || !this.accept(rinfo.address)) return;
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg?.helm !== 'lan' || typeof msg.tag !== 'string' || msg.tag.length > 64) return;
    const port = Number(msg.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return;
    const id = this.#whose(msg.tag);
    if (!id) return;
    // The address is where the datagram came from, never what it says.
    const url = `http://${rinfo.address}:${port}`;
    const known = this.hints.get(url);
    if (known) {
      if (known.id === id) known.seen = this.now();
      return;
    }
    // A tag can be replayed with arbitrary source addresses and ports. Keep
    // admitted hints until expiry instead of evicting them on each packet:
    // otherwise a bounded map still starts unbounded in-flight handshakes.
    if (this.hints.size >= MAX_HINTS
        || [...this.hints.values()].filter(hint => hint.id === id).length >= MAX_HINTS_PER_MACHINE) return;
    this.hints.set(url, { id, seen: this.now() });
    // Someone new: answer them directly so they need not wait a round to
    // hear about us. They answer us only once in turn, for the same reason.
    this.#announce({ address: rinfo.address, port: rinfo.port });
    this.onChange();
  }

  #expire() {
    let changed = false;
    for (const [url, hint] of this.hints) {
      if (this.now() - hint.seen < HINT_TTL_MS) continue;
      this.hints.delete(url);
      changed = true;
    }
    if (changed) this.onChange();
  }
}
