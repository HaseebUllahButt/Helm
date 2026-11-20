import dgram from 'node:dgram';
import { createCipheriv, createDecipheriv, createPublicKey, hkdfSync, randomBytes, sign, verify } from 'node:crypto';
import { T } from '@helm/protocol';
import { bootstrapAddress, machineSigningInfo } from '@helm/protocol/network';
import { allowDirectSignal } from './direct-auth.js';
import { loadSettings } from './settings.js';
import { broadcastAddresses, isPrivateV4, lanIsRoutable } from './net-addr.js';

/**
 * Machines on the same Wi-Fi finding each other, and carrying the direct
 * link's setup messages straight across it.
 *
 * A direct link (direct-mesh.js) needs an offer, an answer and a few
 * address candidates to go between the two machines before it opens. Those
 * went only through a hub. When the hub is the VM over a lossy path, each
 * one can wait seconds behind a chat list, so two machines one metre apart
 * waited minutes for a link (2026-11-18: VM round trip 8 s, "no answer").
 * Now each setup message also goes in one datagram to the other machine on
 * the local network. Whichever copy arrives first is used; the receiver
 * ignores the other (peer.js twin offers, direct-rpc.js repeat answers).
 *
 * A plain UDP broadcast, not mDNS: port 5353 already belongs to the system's
 * own responder on most desktops, and one small datagram to the subnet's
 * broadcast address is all Helm machines need. Neither crosses a router.
 *
 * Every packet is sealed with AES-256-GCM under a key derived from the
 * network key, so a stranger on a cafe Wi-Fi learns nothing, not even which
 * machine sent it. Inside, the sender signs it with its machine signing key,
 * checked against the key pinned in the roster: the network key alone
 * cannot speak for a machine. A packet outside the clock window, or one whose
 * nonce was seen, is refused, so a recorded packet cannot be played back. A
 * removed machine is refused, and so is everything once this machine itself
 * is removed. Offers then pass the same check a hub's do (allowDirectSignal).
 *
 * No hub address is announced or dialled here any more. Hubs stay HTTPS;
 * the local network only introduces the encrypted direct link.
 *
 * Off with `"lanDiscovery": false` in ~/.helm/config.json or
 * HELM_LAN_DISCOVERY=0.
 */

/** UDP, so the same number as the hub's TCP port without getting in its way. */
export const LAN_PORT = 8787;
const ANNOUNCE_EVERY_MS = 30_000;
/** Extra hellos after a start or a Wi-Fi change: the first can go out before the interface is up. */
const BURST_MS = [1_000, 3_000];
/** Long enough to survive two lost announcements in a row. */
const HINT_TTL_MS = 100_000;
const ROUTE_CHECK_MS = 5 * 60_000;
/** Two machines' clocks must agree to within this. */
export const CLOCK_WINDOW_MS = 2 * 60_000;
const MAX_PACKET = 16 * 1024;
const MAX_SEEN = 8192;
const MAX_HINTS = 64;
const MAGIC = Buffer.from('HLM2');
const LABEL = 'helm-lan-v2';

const keys = new Map();
/** The packet key: the network key, stretched for this one use. */
function packetKey(net) {
  const id = `${net.id}\n${net.key}`;
  let key = keys.get(id);
  if (!key) {
    key = Buffer.from(hkdfSync('sha256', Buffer.from(String(net.key), 'base64url'), Buffer.from(String(net.id)), Buffer.from(LABEL), 32));
    if (keys.size > 8) keys.clear();
    keys.set(id, key);
  }
  return key;
}

const signedBody = (net, body) => Buffer.from(`${LABEL}:${net.id}:${body}`);

/** One message, signed by this machine and sealed under the network key. */
export function sealPacket(net, message, privateKey) {
  const body = JSON.stringify(message);
  const plain = Buffer.from(JSON.stringify({ m: body, s: sign(null, signedBody(net, body), privateKey).toString('base64url') }));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', packetKey(net), iv);
  cipher.setAAD(MAGIC);
  const sealed = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), sealed]);
}

/** The message and its signature, or null for anything not sealed under this network's key. */
export function openPacket(net, raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 32 || raw.length > MAX_PACKET || !raw.subarray(0, 4).equals(MAGIC)) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', packetKey(net), raw.subarray(4, 16));
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(raw.subarray(16, 32));
    const outer = JSON.parse(Buffer.concat([decipher.update(raw.subarray(32)), decipher.final()]).toString('utf8'));
    if (typeof outer?.m !== 'string' || typeof outer.s !== 'string' || outer.s.length > 128) return null;
    const message = JSON.parse(outer.m);
    if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
    return { message, body: outer.m, signature: outer.s };
  } catch { return null; }
}

/**
 * On unless the owner said no. Test runs (HELM_NO_SERVICE) stay quiet on the
 * real network unless they ask for it, so a test daemon never shouts on the
 * owner's Wi-Fi.
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
  const boot = bootstrapAddress(net);
  if (boot) machineFor.set(boot.url, boot.machine);
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
  #burst = [];
  #routable = { ok: true, at: -Infinity };
  #warned = false;
  #stopped = false;
  #reason = null;
  #privateKey = null;
  #publicKeys = new Map();
  /** nonce -> when it can be forgotten: older packets fail the clock check anyway. */
  #seen = new Map();
  #rejected = 0;
  /** Until when our broadcasts ask everyone to answer: just after a start or a Wi-Fi change. */
  #askUntil = -Infinity;

  /**
   * @param {object} opts
   * @param {() => object} opts.network        the roster, read fresh each time
   * @param {boolean} [opts.announce]          say we are here (listen either way)
   * @param {() => boolean} [opts.direct]      whether this machine takes direct links now
   * @param {(id) => void} [opts.onPeer]       a machine was heard at a new address
   * @param {(signal) => void} [opts.onSignal] { from, side, peer, payload } for a direct link's setup
   * @param {() => object} [opts.signingKey]   this machine's private signing key
   */
  constructor({
    network, announce = true, direct = () => true, onPeer = () => {}, onSignal = () => {},
    discoveryPort = LAN_PORT, bindAddress = '0.0.0.0',
    targets = () => broadcastAddresses().map((address) => ({ address, port: discoveryPort })),
    accept = isPrivateV4, enabled = () => lanDiscoveryEnabled(), routable = lanIsRoutable,
    now = Date.now, every = ANNOUNCE_EVERY_MS, signingKey = () => machineSigningInfo().privateKey,
  }) {
    Object.assign(this, { network, announce, direct, onPeer, onSignal, discoveryPort, bindAddress, targets, accept, enabled, routable, now, every, signingKey });
    /** machine id -> { address, port, seen, direct } */
    this.hints = new Map();
  }

  /** Listening and allowed to be used. */
  get active() { return !!this.#socket; }

  async start() {
    this.#stopped = false;
    this.#askUntil = this.now() + BURST_MS.at(-1) + 1_000;
    await this.tick();
    this.#timer = setInterval(() => { void this.tick(); }, this.every);
    this.#timer.unref?.();
    this.#hurry();
    return this;
  }

  stop() {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#timer = null;
    for (const timer of this.#burst.splice(0)) clearTimeout(timer);
    this.#close();
  }

  /** The machines heard and still fresh. */
  list() {
    return [...this.hints].filter(([, hint]) => this.#fresh(hint))
      .map(([id, hint]) => ({ id, address: hint.address, port: hint.port, seen: hint.seen, direct: hint.direct }));
  }

  /** Heard lately, and its Helm takes direct links: worth a local setup. */
  ready(id) {
    const hint = this.hints.get(id);
    return !!this.#socket && this.#fresh(hint) && hint.direct;
  }

  /** Where that machine was last heard, as "address:port", or null. */
  where(id) {
    const hint = this.hints.get(id);
    return this.#socket && this.#fresh(hint) ? `${hint.address}:${hint.port}` : null;
  }

  status() {
    return {
      on: this.active,
      reason: this.active ? null : this.#reason ?? null,
      heard: this.list().map(({ id, address, seen }) => ({ id, address, ageMs: Math.max(0, this.now() - seen) })),
      rejected: this.#rejected,
    };
  }

  /** VPN and Wi-Fi changes invalidate both learned addresses and route checks. */
  networkChanged() {
    this.#routable.at = -Infinity;
    this.hints.clear();
    this.#askUntil = this.now() + BURST_MS.at(-1) + 1_000;
    const done = this.tick();
    this.#hurry();
    return done;
  }

  async tick() {
    if (this.#stopped) return;
    if (!this.enabled()) return this.#off('turned off');
    // A full-tunnel VPN sends this subnet's traffic into the tunnel: nothing
    // on the Wi-Fi would hear us, and an answer from it would never come
    // back. Do not advertise an address we cannot answer on.
    if (this.now() - this.#routable.at >= ROUTE_CHECK_MS) {
      const r = await this.routable().catch(() => null);
      this.#routable = { ok: r?.ok !== false, at: this.now() };
    }
    if (this.#stopped) return;
    if (!this.#routable.ok) return this.#off('the local network is routed into a VPN');
    if (!this.#socket && !(await this.#open())) return;
    this.#reason = null;
    this.#expire();
    this.#hello();
  }

  /**
   * Send one setup message for a direct link to a machine heard here.
   * Returns where it went ("address:port"), or null when that machine has
   * not been heard lately and only the hub can carry it.
   */
  signal(to, side, peer, payload) {
    const hint = this.hints.get(to);
    if (!this.#socket || !this.#fresh(hint)) return null;
    const sent = this.#send({ k: 'signal', to, side, peer, payload }, hint);
    return sent ? `${hint.address}:${hint.port}` : null;
  }

  #fresh(hint) {
    return !!hint && this.now() - hint.seen < HINT_TTL_MS;
  }

  #hurry() {
    this.#askUntil = this.now() + BURST_MS.at(-1) + 1_000;
    for (const timer of this.#burst.splice(0)) clearTimeout(timer);
    for (const ms of BURST_MS) {
      const timer = setTimeout(() => { if (!this.#stopped) this.#hello(); }, ms);
      timer.unref?.();
      this.#burst.push(timer);
    }
  }

  #off(reason) {
    this.#reason = reason;
    this.#close();
    this.hints.clear();
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

  #send(fields, target) {
    const net = this.network();
    if (!this.#socket || !net?.key || !net.self || net.revoked?.[net.self]) return false;
    let packet;
    try {
      this.#privateKey ??= this.signingKey();
      packet = sealPacket(net, { ...fields, from: net.self, at: this.now(), nonce: randomBytes(16).toString('hex') }, this.#privateKey);
    } catch { return false; }
    // Too big for one datagram: the hub carries this one alone.
    if (packet.length > MAX_PACKET) return false;
    for (const t of Array.isArray(target) ? target : [target]) this.#socket.send(packet, t.port, t.address, () => {});
    return true;
  }

  #hello(to = null, target = null) {
    if (!this.announce || !this.#socket) return;
    const targets = target ? [target] : this.targets();
    // Just started, or on a new network: ask everyone to answer now. A
    // machine that heard us before would otherwise wait a round to say so.
    const ask = to == null && this.now() < this.#askUntil ? 1 : 0;
    if (targets.length) this.#send({ k: 'hello', to, direct: this.direct() ? 1 : 0, ask }, targets);
  }

  #publicKey(id, net) {
    const text = net.machines?.[id]?.codeSignPubkey;
    if (typeof text !== 'string' || text.length > 512) return null;
    let key = this.#publicKeys.get(text);
    if (!key) {
      try { key = createPublicKey({ key: Buffer.from(text, 'base64url'), type: 'spki', format: 'der' }); } catch { return null; }
      if (this.#publicKeys.size > 64) this.#publicKeys.clear();
      this.#publicKeys.set(text, key);
    }
    return key;
  }

  /** Whether a nonce is new, after dropping the ones too old to matter. */
  #fresher(nonce) {
    if (this.#seen.has(nonce)) return false;
    if (this.#seen.size >= MAX_SEEN) {
      for (const [n, until] of this.#seen) if (until <= this.now()) this.#seen.delete(n);
    }
    return this.#seen.size < MAX_SEEN;
  }

  #reject() { this.#rejected++; }

  #heard(raw, rinfo) {
    if (raw.length > MAX_PACKET || rinfo.family !== 'IPv4' || !this.accept(rinfo.address)) return;
    const net = this.network();
    if (!net?.key || !net.self || net.revoked?.[net.self]) return;
    const opened = openPacket(net, raw);
    if (!opened) return this.#reject();
    const { message: m, body, signature } = opened;
    const from = m.from;
    // Our own broadcast comes back to us; that is not a rejection.
    if (from === net.self) return;
    if (typeof from !== 'string' || !Object.hasOwn(net.machines ?? {}, from) || net.revoked?.[from]
        || (m.to != null && m.to !== net.self)
        || typeof m.at !== 'number' || Math.abs(this.now() - m.at) > CLOCK_WINDOW_MS
        || typeof m.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(m.nonce)
        || !this.#fresher(m.nonce)) return this.#reject();
    const key = this.#publicKey(from, net);
    let good = false;
    try { good = !!key && verify(null, signedBody(net, body), key, Buffer.from(signature, 'base64url')); } catch { good = false; }
    if (!good) return this.#reject();
    this.#seen.set(m.nonce, this.now() + 2 * CLOCK_WINDOW_MS);

    // The address is where the datagram came from, never what it says.
    const before = this.hints.get(from);
    const moved = !this.#fresh(before) || before.address !== rinfo.address || before.port !== rinfo.port;
    if (moved && !before && this.hints.size >= MAX_HINTS) return;
    const direct = m.k === 'hello' ? m.direct === 1 : before?.direct ?? true;
    this.hints.set(from, { address: rinfo.address, port: rinfo.port, seen: this.now(), direct });

    if (m.k === 'hello') {
      // Someone new, or someone who just started: answer them directly so
      // they need not wait a round to hear about us. A reply names its
      // receiver and is never answered.
      const asked = moved || m.ask === 1;
      if (asked && m.to == null) this.#hello(from, { address: rinfo.address, port: rinfo.port });
      if (asked) this.#tell(() => this.onPeer(from));
      return;
    }
    if (m.k !== 'signal' || !['dial', 'answer'].includes(m.side) || m.to !== net.self
        || typeof m.peer !== 'string' || m.peer.length > 128
        || !m.payload || typeof m.payload !== 'object' || Array.isArray(m.payload)) return;
    if (moved) this.#tell(() => this.onPeer(from));
    this.#tell(() => this.onSignal({ from, side: m.side, peer: m.peer, payload: m.payload }));
  }

  #tell(fn) {
    try { void Promise.resolve(fn()).catch(() => {}); } catch { /* a listener's bug is not the socket's */ }
  }

  #expire() {
    for (const [id, hint] of this.hints) if (!this.#fresh(hint)) this.hints.delete(id);
    for (const [n, until] of this.#seen) if (until <= this.now()) this.#seen.delete(n);
  }
}

/**
 * Where setup messages heard on the local network go: the same places as a
 * hub's. An offer for this machine passes the same check a hub's T.SIGNAL
 * does, and its answers go back over the local network (and the hub, if a
 * copy of the offer also came that way - peer.js). An answer for a link this
 * machine dials goes to that link only when it names the machine dialled.
 */
export function localSignalRouter({ network, peers, direct, lan, enabled = () => true }) {
  const links = new Map();
  return ({ from, side, peer, payload }) => {
    const net = network();
    if (side === 'answer') return direct()?.receive({ env: from, peer, payload });
    // Phones and browsers never come this way: only machines sign packets.
    if (!Object.hasOwn(net?.machines ?? {}, from) || !allowDirectSignal(net, from, payload, enabled())) return;
    const id = `lan-${from}-${peer}`;
    let link = links.get(id);
    if (!link) {
      link = { local: true, send: (t, frame) => { if (t === T.SIGNAL) lan().signal(from, 'answer', peer, frame.payload); } };
      links.set(id, link);
      if (links.size > 256) links.delete(links.keys().next().value);
    }
    return peers()?.signal(id, payload, link, from);
  };
}
