import WebSocket from 'ws';
import { hostname, platform, arch, release } from 'node:os';
import { connect as tcpConnect } from 'node:net';
import { T, M, E, CONTROLLER_WORDS, CONTROLLER_REFUSAL } from '@helm/protocol';
import {
  loadNetwork, machineToken, mergeRoster, allEndpoints, describeSelf,
  roster as rosterOf, rosterHash, machineName, NAME_RULE, machineKind,
  MACHINE_KINDS, saveNetwork,
} from '@helm/protocol/network';
import { createRuntime } from './runtime/index.js';
import { modesFor } from './modes.js';
import { Sessions, wire } from './sessions.js';
import { getProfiles, refreshProfiles, currentProfiles, materialize } from './profiles.js';
import { listModels } from './models.js';
import { listCommands } from './commands.js';
import { accountKey, modelPrefs, saveModelPrefs, startPrefs, saveStartPrefs, applyModelPrefs, loadSettings, listProjects, saveProject, removeProject } from './settings.js';
import { ENGINES } from './engines.js';
import * as fsApi from './fs.js';
import { join } from 'node:path';
import { inventory } from './inventory.js';
import { UsageReader, foldBuckets } from '@helm/usage';
import { HELM_DIR, collapse, expand } from './paths.js';
import { sshInfo, applyPeers } from './ssh.js';
import { PeerHub } from './peer.js';
import { lanAddresses } from './net-addr.js';
import { describe as describeAsk } from './notify.js';
import { brief, render, summaryLine, readSnapshot, writeSnapshot, mergeSnapshot } from './brain.js';
import { forWire } from './events.js';
import { hubRpc } from './hub-client.js';
import { transcribe, canTranscribe } from './voice.js';

const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 30_000;
/** How recently a machine must have answered to be called online. */
const FRESH_MS = 90_000;

const RECONCILE_MS = 15_000;
/** How often the brain's picture of the network is refreshed, while one exists. */
const BRAIN_REFRESH_MS = 45_000;
const HEARTBEAT_MS = 20_000;

/**
 * One connection to one hub.
 *
 * A machine keeps one of these open to every hub it can currently reach,
 * including the one it is running itself. That redundancy is the point: a
 * phone that can only reach the VM and a laptop that can only be reached on
 * the LAN still meet, as long as some hub can see both of them.
 */
class Link {
  #ws = null;
  #backoff = RECONNECT_MIN;
  #stopped = false;
  #beat = null;
  #waiting = false;

  constructor(daemon, url) {
    this.daemon = daemon;
    this.url = url;
    this.id = url;
    this.connected = false;
  }

  start() { this.#open(); return this; }

  stop() {
    this.#stopped = true;
    this.connected = false;
    clearInterval(this.#beat);
    try { this.#ws?.close(); } catch { /* already gone */ }
  }

  /**
   * Prove the hub is still there.
   *
   * A TCP connection that dies without a FIN - a laptop suspended mid-session,
   * a NAT table dropping the mapping, a tunnel edge going away - looks exactly
   * like an idle healthy one until the kernel eventually gives up, which can
   * take hours. The hub notices us because it pings; we have to do the same,
   * or we sit there believing we are reachable while the phone sees us as
   * offline. Which is the common case for a machine you carry around.
   */
  #heartbeat() {
    clearInterval(this.#beat);
    this.#waiting = false;
    this.#beat = setInterval(() => {
      if (this.#waiting) {
        // A close event follows, and with it the usual reconnect.
        try { this.#ws?.terminate(); } catch { /* already gone */ }
        return;
      }
      this.#waiting = true;
      this.send(T.PING);
    }, HEARTBEAT_MS);
    this.#beat.unref?.();
  }

  onPong() { this.#waiting = false; }

  send(t, extra = {}) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ t, ...extra }));
    }
  }

  async #open() {
    if (this.#stopped) return;
    const info = await this.daemon.describe();
    // The one hub a machine attaches to as *itself* is its own, on loopback -
    // which is what lets a phone reach this machine through the very hub this
    // machine is running. Mark that link `role=self` so the hub can allow this
    // single case while still refusing any other self-attach (a machine that
    // accidentally dialled its own public address, which would set off the
    // supersede war invariant #2 exists to prevent).
    const isSelf = this.url === `http://127.0.0.1:${this.daemon.port}`;
    // The token travels as a header rather than in the URL, so it never
    // appears in the access logs of Caddy or a tunnel along the way.
    const ws = new WebSocket(
      `${this.url.replace(/^http/, 'ws')}/ws` +
      `?name=${encodeURIComponent(this.daemon.name)}` +
      `&info=${encodeURIComponent(JSON.stringify(info))}` +
      (isSelf ? '&role=self' : ''),
      { headers: { authorization: `Bearer ${this.daemon.token}` } }
    );
    this.#ws = ws;

    ws.on('open', () => {
      this.#backoff = RECONNECT_MIN;
      this.connected = true;
      this.#heartbeat();
      this.daemon.onLinkUp(this);
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      this.daemon.onFrame(this, msg).catch((err) =>
        console.error(`[helm] ${this.url}: ${err?.message || err}`)
      );
    });

    ws.on('close', () => {
      const was = this.connected;
      this.connected = false;
      clearInterval(this.#beat);
      if (this.#stopped) return;
      if (was) console.log(`[helm] lost ${this.url}; retrying`);
      setTimeout(() => this.#open(), this.#backoff).unref?.();
      this.#backoff = Math.min(this.#backoff * 2, RECONNECT_MAX);
    });

    // Unreachable hubs are normal - a laptop that is asleep, a LAN address
    // from a network we are not on. Retrying quietly is the correct response.
    ws.on('error', () => {});
  }
}

export class Daemon {
  #links = new Map();
  #tunnels = new Map();
  #brainTimer = null;
  #stopped = false;
  #reconcile = null;
  /** This process's half of an event id; a restart must not reuse ids. */
  #boot = Math.random().toString(36).slice(2, 8);
  #emitted = 0;
  // The nas capability, only ever populated when this machine is designated
  // one: { server, port } for the media listener, plus the lazily imported
  // module. A machine that is never a nas never loads the package.
  #media = null;
  #nas = null;

  /**
   * @param {object} opts
   * @param {string} [opts.name]     how this machine appears in the app
   * @param {number} [opts.port]     the local hub's port, always linked first
   * @param {string[]} [opts.extra]  additional hub URLs (e.g. an active tunnel)
   */
  constructor({
    name, port = 8787, extra = [], advertised = [], advertiseLan = true,
  } = {}) {
    const net = loadNetwork();
    if (!net) throw new Error('this machine is not in a network - run `helm up`');
    this.net = net;
    this.port = port;
    this.extra = extra;
    // What was supplied by hand, as opposed to by a tunnel that may go away.
    this.advertised = advertised ?? [];
    this.advertiseLan = advertiseLan;
    this.id = net.self;
    // The roster wins over `--name`, which only ever named a machine that was
    // new to the network (`createNetwork` and `joinNetwork` take it there).
    // It has to: a name changed from the app is written to the roster, and a
    // service unit that still carries the `--name` it was installed with
    // would otherwise undo that rename on every restart.
    this.name = net.machines[net.self]?.name || name || hostname();
    this.token = machineToken(net);
  }

  async start() {
    this.runtime = await createRuntime();
    this.runtimeInfo = await this.runtime.ensureReady();

    this.peers = new PeerHub(
      (peer, payload, link) =>
        (link ?? { send: (t, e) => this.broadcastFrame(t, e) }).send(T.SIGNAL, { peer, payload }),
      (method, params, caller) => this.dispatch(method, params, caller)
    );

    this.sessions = new Sessions(this.runtime, { log: (m) => console.error(`[helm] ${m}`) });
    // The line the brain gets in front of what the owner types. Read from the
    // snapshot on disk rather than the network, because it is on the send
    // path: a message must not wait on every machine answering. The refresh
    // below keeps it at most one message stale, which for "2 machines, 1
    // waiting on you" is close enough to be worth nothing in latency.
    this.sessions.brief = () => {
      const snap = readSnapshot();
      // Fire and forget: the next message gets the fresher answer. Waiting
      // on every machine here would put the whole network's round trip in
      // front of the owner pressing send.
      this.refreshSnapshot().catch(() => {});
      return summaryLine(snap, { roster: this.rosterState(snap) });
    };
    // Terminals and agent processes live in their own host, so some of them
    // are still running. Ask which before resuming: `resume` reads the
    // surviving-proc list to know which open turns are still live rather
    // than interrupted.
    this.sessions.adoptTerminals()
      .catch(() => {})
      .then(() => this.sessions.resume());
    // The folder index behind `fs.search`: one background walk now, so the
    // first query is answered from memory rather than starting the walk then.
    fsApi.warmIndex?.();
    this.sessions.on('session', (session) => this.#emit(E.SESSION_UPDATE, { session: wire(session) }));
    this.sessions.on('digest', (digest) => this.#emit(E.DIGEST, { digest }));
    this.sessions.on('data', (delta) => this.#emit(E.SESSION_DATA, delta));
    this.sessions.on('exit', (e) => this.#emit(E.SESSION_EXIT, e));
    this.sessions.on('transcript', (ref) => this.#emit(E.SESSION_TRANSCRIPT, ref));
    this.sessions.on('status', ({ session, from, to }) => {
      this.#emit(E.SESSION_UPDATE, { session: wire(session), transition: { from, to } });
      // The bell rings when the thread settles back to idle, not when it
      // pauses to ask: a completion notification means finished - a thread
      // that is merely blocked has its own notification already. Done,
      // interrupted and errored all land on idle, so any of them rings it.
      if (session.notifyDone && to === 'idle' && from !== 'idle') {
        this.#notifyDone(session);
      }
    });
    this.sessions.on('event', ({ id, event }) => {
      this.#queueEvent(id, event);
      if (event?.type === 'permission.request') this.#notify(id, event);
      // The matching "needs you" is stale the moment anyone answers - on
      // this device, another, or the CLI itself. Hubs pass `resolve` through
      // to the service worker, which closes the notification by its tag.
      if (event?.type === 'permission.resolved') {
        this.broadcastFrame(T.NOTIFY, {
          payload: {
            tag: `helm-${id}-${event.requestId ?? ''}`,
            envId: this.id, sessionId: id, resolve: true,
          },
        });
      }
    });

    // Kept warm only while there is a brain to read it. A network with no
    // brain thread pays nothing for this; one with a brain gets a digest
    // that is current when the owner opens it rather than when they send
    // their second message.
    this.#brainTimer = setInterval(() => {
      if (this.sessions?.brainSession()) this.refreshSnapshot().catch(() => {});
    }, BRAIN_REFRESH_MS);
    this.#brainTimer.unref?.();

    await this.#tick();
    this.#reconcile = setInterval(
      () => this.#tick().catch((err) =>
        console.error('[helm] reconcile:', err?.message || err)),
      RECONCILE_MS
    );
    this.#reconcile.unref?.();

    // The opt-in half of being a nas. Synced with the kind at start and on
    // every redesignation, so a machine that is never one never pays for it.
    this.#syncMedia().catch((err) =>
      console.error('[helm] nas media:', err?.message || err));
  }

  /**
   * Every machine's own line in the digest, gathered and written down.
   *
   * Asked of each machine over its own hub, in parallel, and merged onto what
   * was there before - so a machine that did not answer keeps its last known
   * state with the time it was taken. A brain that quietly omits a sleeping
   * laptop does not have a gap, it has a wrong answer.
   */
  async refreshSnapshot() {
    const net = loadNetwork() ?? this.net;
    const fresh = {};
    const ids = Object.keys(net.machines ?? {});
    await Promise.all(ids.map(async (id) => {
      try {
        const r = id === this.id
          ? { name: this.name, ...(await this.sessions.digest()) }
          : await hubRpc(net, id, M.BRAIN_DIGEST, {}, { timeout: 8000 });
        fresh[id] = { name: r.name ?? net.machines[id]?.name ?? id, sessions: r.sessions ?? [] };
      } catch { /* offline, or too old to know the method: keep what we had */ }
    }));
    return writeSnapshot(mergeSnapshot(readSnapshot(), fresh));
  }

  /**
   * Which machines are up, as the digest prints them.
   *
   * Taken from the snapshot's own timestamps rather than from the link state:
   * "it answered when we last asked" is exactly the claim the digest makes
   * about a machine, so deriving it from anything else would let the two
   * disagree - a machine listed online above sessions that are hours old.
   */
  rosterState(snap = readSnapshot(), now = Date.now()) {
    const net = loadNetwork() ?? this.net;
    return Object.fromEntries(Object.values(net.machines ?? {}).map((m) => {
      const at = snap?.machines?.[m.id]?.at ?? 0;
      return [m.id, { name: m.name, online: now - at < FRESH_MS }];
    }));
  }

  stop() {
    this.#stopped = true;
    clearInterval(this.#brainTimer);
    clearInterval(this.#reconcile);
    for (const link of this.#links.values()) link.stop();
    // A locally terminated tunnel is a live socket even after every hub link
    // is gone. Close those too, or stopping the daemon can leave connections
    // (and the process that owns them) alive indefinitely.
    for (const { sock } of this.#tunnels.values()) sock.destroy();
    this.#tunnels.clear();
    this.#media?.server.close();
    this.#media = null;
    this.peers?.stop();
    this.runtime?.stop();
    // Headless agents die with the daemon; their sessions resume on demand.
    this.sessions?.stop().catch(() => {});
  }

  // ------------------------------------------------------------------ links

  /**
   * Which hubs should we be attached to?
   *
   * Our own on loopback, always - it is what makes this machine reachable
   * when nothing else is - plus the addresses of every *other* machine. Dead
   * addresses cost one failed socket per cycle and are worth keeping: a
   * laptop that is asleep now is the same laptop you want this evening.
   *
   * Our own addresses are deliberately excluded. A LAN address and a tunnel
   * URL both resolve to the hub we are already attached to on loopback, and
   * connecting twice makes a machine evict itself: a hub supersedes the older
   * socket for a given machine id, so the two links knock each other down in
   * a loop.
   */
  #desiredLinks() {
    const net = loadNetwork() ?? this.net;
    // Both what we advertise and what we were handed: an address we hold is
    // ours whether or not the roster has caught up, and dialling it would
    // make us evict ourselves.
    const mine = new Set([...(net.machines?.[this.id]?.endpoints ?? []), ...this.extra]);
    const urls = [`http://127.0.0.1:${this.port}`];
    for (const url of allEndpoints(net)) {
      if (!mine.has(url) && !urls.includes(url)) urls.push(url);
    }
    return urls;
  }

  async #tick() {
    if (this.#stopped) return;
    await this.#publishSelf();

    // Offer a fingerprint of what we know on every cycle. It is what makes a
    // revocation typed on one machine reach a machine that has been asleep
    // since - but the answer is almost always "same as mine", so send the
    // 16-byte summary and let the hub ask for the rest if it differs.
    const net = loadNetwork();
    if (net) {
      // A new tick, a new chance to push our roster to a hub that disagrees.
      for (const link of this.#links.values()) link.offered = false;
      this.broadcastFrame(T.ROSTER, { hash: rosterHash(net) });
      // A direct WebRTC channel is authenticated once, when the hub makes the
      // introduction. Revocation has to reach it too, or a removed phone
      // keeps a working side door to this machine.
      this.peers?.dropRevoked(net.revoked);
    }

    this.#reconcileLinks();
  }

  #reconcileLinks() {
    if (this.#stopped) return;
    const want = new Set(this.#desiredLinks());

    for (const [url, link] of this.#links) {
      if (want.has(url)) continue;
      link.stop();
      this.#links.delete(url);
    }
    for (const url of want) {
      if (this.#links.has(url)) continue;
      this.#links.set(url, new Link(this, url).start());
    }
  }

  /**
   * Describe ourselves into the roster.
   *
   * Run on every cycle rather than once at startup, because the answer
   * changes: a laptop that boots at home and is opened in a cafe had been
   * advertising its old `192.168.x` address forever, so the other machines
   * kept dialling somewhere it no longer was and nothing could find it.
   * `describeSelf` only moves the timestamp when something really changed, so
   * the steady state is a no-op.
   */
  async #publishSelf() {
    const net = loadNetwork() ?? this.net;
    const endpoints = [...new Set([
      ...this.extra,
      ...(this.advertiseLan
        ? lanAddresses().map((a) => `http://${a.address}:${this.port}`)
        : []),
    ])];
    const ssh = await sshInfo().catch(() => ({}));
    this.net = describeSelf(net, {
      endpoints,
      pubkey: ssh.pubkey,
      sshUser: ssh.sshUser,
      sshPort: ssh.sshPort,
    });
  }

  /** Addresses that reach this machine, whoever supplied them. */
  setExtra(urls) {
    this.extra = [...new Set(urls)];
    return this.#tick();
  }

  /**
   * Add or drop the tunnel address, leaving anything passed with --advertise
   * alone. Retracting takes effect on this tick, so the next reconcile both
   * stops claiming the address and starts dialling whoever holds it now.
   */
  setTunnel(url) {
    const fixed = this.advertised ?? [];
    return this.setExtra(url ? [...fixed, url] : fixed);
  }

  /**
   * Change what this machine is for.
   *
   * `kind` lives on this machine's own roster record, which has exactly one
   * author - so this is only ever asked of the machine itself, never written
   * at whichever hub the caller happened to reach. The set is closed (pc,
   * vm, nas) and a controller is refused outright rather than mapped into
   * it: a controller is not a kind of machine, it is a device - it runs
   * nothing and cannot become one.
   *
   * pc and nas are a record change only; the flag is what the rest of the
   * network reads. Becoming the vm is real work: an https address has to be
   * claimed before anything is written, so a failure there leaves the
   * machine exactly what it was rather than half a home. Leaving vm is the
   * reverse - the advertised https endpoint comes off the record and out of
   * the service arguments, while the Caddy site behind it is left for the
   * owner to remove by hand: helm wrote it, but a file under /etc is not
   * ours to delete.
   */
  async setMachineKind(kind, { address } = {}) {
    if (CONTROLLER_WORDS.includes(String(kind))) throw new Error(CONTROLLER_REFUSAL);
    if (!machineKind(kind)) {
      throw new Error(`a machine's kind is one of: ${MACHINE_KINDS.join(', ')}`);
    }

    let home = null;
    if (address) {
      // A caller may hand over an https address it has already configured;
      // held to the same origin-only shape `helm setup` insists on.
      let url;
      try { url = new URL(address); } catch { throw new Error(`invalid address: ${address}`); }
      if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('a machine address is a bare https origin, e.g. https://helm.example.com');
      }
      home = url.origin;
    }

    const net = loadNetwork() ?? this.net;
    const from = net.machines[this.id]?.kind ?? net.role ?? 'pc';
    const notes = [];

    // The service change stops this process when this daemon is the one
    // systemd is running, so it is deferred until the answer is on the
    // wire. A daemon running in a terminal is not restarted: the flags it
    // was started with are the owner's to change, and the note says so.
    const underService = Boolean(process.env.INVOCATION_ID);
    const reinstall = (args) => {
      if (!underService) {
        notes.push('not running as the installed service - ' +
          'restart `helm up` with the new flags to keep the change');
        return;
      }
      setTimeout(async () => {
        const { installService } = await import('./service.js');
        await installService({ mode: 'serve', args })
          .catch((err) => console.error(`[helm] service after redesignate: ${err?.message || err}`));
      }, 1500);
    };

    if (from === kind) {
      // Still write it: the record and the local note can each be missing
      // the value the other already has, and a no-op here is cheap.
      net.role = kind;
      this.net = describeSelf(net, { kind });
      saveNetwork(this.net);
      return { id: this.id, kind, from, changed: false, notes };
    }

    if (kind === 'vm') {
      // Claim the address first, before anything is written: if https
      // cannot be set up the machine stays what it was.
      home ??= this.advertised.find((e) => e.startsWith('https://'))
        ?? await (await import('./caddy.js')).claimFreeHttps(this.port);
      if (!this.advertised.includes(home)) this.advertised.push(home);
      if (!this.extra.includes(home)) this.extra.push(home);
      // --host 127.0.0.1: behind Caddy only this machine itself should answer.
      reinstall(['--advertise', home, '--host', '127.0.0.1']);
      notes.push(`serving ${home} as a home for the network`);
    } else if (from === 'vm') {
      // The advertised https address is what made it the home. Tunnels and
      // LAN addresses stay - they are still true of a pc or a nas.
      const drop = new Set(this.advertised.filter((e) => e.startsWith('https://')));
      this.advertised = this.advertised.filter((e) => !drop.has(e));
      this.extra = this.extra.filter((e) => !drop.has(e));
      reinstall(['--host', '0.0.0.0']);
      notes.push('its Caddy site can be removed by hand: ' +
        'sudo rm /etc/caddy/helm.caddy && sudo systemctl reload caddy');
    }

    // Publish the new endpoint set before the kind lands, so the record
    // never says "vm" while still advertising a dead address or vice versa.
    await this.#publishSelf();
    const fresh = loadNetwork() ?? net;
    fresh.role = kind;
    this.net = describeSelf(fresh, { kind });
    saveNetwork(this.net);
    // Now rather than at the next reconcile: the caller is waiting on the
    // answer, and every other machine holds the old word until this lands.
    this.broadcastFrame(T.ROSTER, { roster: rosterOf(this.net) });
    await this.#syncMedia();
    return { id: this.id, kind, from, changed: true, notes };
  }

  // -------------------------------------------------------------------- nas

  /** What this machine is for, as its own record currently says. */
  #isNas() {
    const net = loadNetwork() ?? this.net;
    return (net.machines[this.id]?.kind ?? net.role) === 'nas';
  }

  /**
   * The media listener, present exactly while this machine is a nas.
   *
   * It binds loopback only: the LAN-facing media path is the hub's /media
   * route, and the remote one is a tunnel to this port. The listener exists
   * for the tunnel - a hub on another machine reaches in through the
   * connection this daemon already holds open, which is how a NAS behind
   * NAT still streams. Nothing is ever served without the authorization
   * plug, and the port enters the tunnel allowlist only while it is ours.
   */
  async #syncMedia() {
    if (this.#isNas()) {
      if (this.#media) return;
      this.#nas ??= await import('@helm/nas');
      const { server, port } = await this.#nas.startMediaServer({
        host: '127.0.0.1', port: 0,
        authorize: this.#nas.mediaAuthorize({ self: this.id }),
      });
      this.#media = { server, port };
    } else if (this.#media) {
      this.#media.server.close();
      this.#media = null;
    }
  }

  /**
   * The media RPCs, gated on the kind: a machine that is not a nas has no
   * media answers, full stop. `caller` is the member id the frame arrived
   * under - the ticket it gets back is minted for that member alone.
   */
  async #mediaRpc(method, p, caller) {
    if (!this.#isNas()) {
      throw Object.assign(new Error('this machine is not a nas'), { code: 'not-nas' });
    }
    this.#nas ??= await import('@helm/nas');
    switch (method) {
      case M.MEDIA_INFO:
        return { kind: 'nas', port: this.#media?.port ?? null, roots: this.#nas.mediaRoots() };
      case M.MEDIA_ROOTS:
        return { roots: this.#nas.mediaRoots() };
      case M.MEDIA_ROOT_ADD:
        return { roots: this.#nas.addMediaRoot(p.path) };
      case M.MEDIA_ROOT_REMOVE:
        return { roots: this.#nas.removeMediaRoot(p.path) };
      case M.MEDIA_LIST: {
        const root = this.#nas.mediaRoots()[Number(p.root)];
        if (!root) throw new Error('no such shared folder');
        return { root: root.id, ...(await this.#nas.listMedia(root.path, p.path ?? '')) };
      }
      case M.MEDIA_TICKET:
        return this.#nas.mediaTicket(loadNetwork() ?? this.net, { sub: caller, env: this.id });
    }
  }

  onLinkUp(link) {
    const local = link.url.includes('127.0.0.1');
    console.log(
      `[helm] ${local ? 'serving locally' : `linked to ${link.url}`} as "${this.name}"`
    );
    // Say what we know straight away rather than waiting for the next
    // reconcile tick: this is how a hub learns our addresses, and how a
    // revocation made while it was offline reaches it.
    const net = loadNetwork();
    if (net) link.send(T.ROSTER, { roster: rosterOf(net) });
    // Nudge the hub to redistribute SSH keys now that we are attached. Our
    // identity travelled in the roster above; the hub does not write it.
    sshInfo().then((ssh) => link.send(T.SSH_INFO_REPORT, ssh)).catch(() => {});
    // And hand this hub our usage rollup now rather than when somebody asks:
    // it is what lets the hub keep answering for us while we are asleep.
    this.#usageRollup()
      .then((r) => link.send(T.USAGE_SYNC, r))
      .catch(() => {});
  }

  /** The machine's whole usage rollup - shared by the report and the push. */
  async #usageRollup(rebuild = false) {
    this.usage ??= new UsageReader({ indexPath: join(HELM_DIR, 'usage-index.json') });
    const profiles = await currentProfiles();
    return this.usage.buckets(profiles, { rebuild });
  }

  /** The hubs we can actually talk to right now. */
  get live() {
    return [...this.#links.values()].filter((l) => l.connected);
  }

  broadcastFrame(t, extra) {
    for (const link of this.live) link.send(t, extra);
  }

  /** sessionId -> events waiting for the next flush */
  #eventQueue = new Map();
  #eventFlush = null;

  /**
   * Session events go out in small batches, one frame per session per tick,
   * and only while somebody has asked to watch that session: the relay fans
   * out per machine, so this is what keeps a phone from receiving the text
   * of every session on the box.
   */
  #queueEvent(id, event) {
    if (!this.sessions.watching(id)) return;
    if (!this.#eventQueue.has(id)) this.#eventQueue.set(id, []);
    // The same cap a fetched reply gets: a 140KB edit is no cheaper to push
    // than it was to send, and a phone reading it live is the same phone.
    this.#eventQueue.get(id).push(forWire(event));
    if (!this.#eventFlush) {
      this.#eventFlush = setImmediate(() => {
        this.#eventFlush = null;
        const batches = [...this.#eventQueue];
        this.#eventQueue.clear();
        for (const [sid, events] of batches) this.#emit(E.SESSION_EVENT, { id: sid, events });
      });
    }
  }

  /**
   * Push an event to everyone watching this machine.
   *
   * A client with a direct peer connection is *also* still attached to a hub
   * - the direct channel is preferred for sending, not a replacement - so
   * both paths reach it and it saw every event twice. The transcript hid
   * that because it applies events by sequence number, but the terminal
   * wrote each keystroke's echo twice, which is what "I type one letter and
   * it shows up as two" was.
   *
   * So each event carries an id: this process's boot tag plus a counter.
   * Whichever copy arrives first wins, the other is dropped, and a restarted
   * daemon cannot collide with its own past because the boot half is new.
   */
  #emit(kind, payload) {
    const eid = `${this.#boot}:${++this.#emitted}`;
    this.broadcastFrame(T.EVENT, { kind, payload, eid });
    this.peers?.broadcast(kind, payload, eid);
  }

  /**
   * A session has stopped and is waiting on a person. Tell their phone.
   *
   * Notifications are the difference between "the agent is blocked" and
   * "the agent has been blocked for forty minutes", which is the whole
   * reason this project exists. Everything here is best-effort: a push
   * service that is slow or down must never hold up the event reaching the
   * app, which is why the caller does not await it.
   */
  #notify(id, event) {
    let session = null;
    try { session = this.sessions.get(id); } catch { /* gone already */ }
    const payload = describeAsk({ ...session, envId: this.id }, event);
    // Each connected hub receives the small, already-redacted notification.
    // The hub that accepted the phone's subscription is the one that can
    // deliver it; a laptop's own local hub normally has no subscriptions.
    this.broadcastFrame(T.NOTIFY, { payload });
  }

  /**
   * A completion bell going off. Deliberately plainer than
   * `describeAsk` - there is nothing to decide, so the notification carries
   * the thread's name and that it finished, nothing more.
   */
  #notifyDone(session) {
    const where = session.title || session.cwd?.split('/').pop() || 'a session';
    this.broadcastFrame(T.NOTIFY, {
      payload: {
        title: `${where} · finished`,
        body: `${session.engine ?? 'the agent'} is done`,
        tag: `helm-done-${session.id}-${Date.now()}`,
        envId: this.id, sessionId: session.id,
      },
    });
  }

  async describe() {
    return {
      host: hostname(),
      platform: platform(),
      arch: arch(),
      release: release(),
      runtime: this.runtimeInfo,
      // 'pty' or 'panes': what a terminal here will actually be.
      terminals: await this.sessions.terminalBackend(),
      // Whether this machine can turn a recording into words. The composer
      // only offers a microphone when something in the network can, so a
      // button that could not possibly work is never drawn.
      voice: canTranscribe(),
      startedAt: Date.now(),
    };
  }

  // ----------------------------------------------------------------- frames

  async onFrame(link, msg) {
    switch (msg.t) {
      case T.WELCOME:
        return;

      case T.RPC: {
        try {
          const result = await this.dispatch(msg.method, msg.params ?? {}, msg.sub);
          link.send(T.RPC_RESULT, { id: msg.id, ok: true, result });
        } catch (err) {
          link.send(T.RPC_RESULT, {
            id: msg.id, ok: false,
            error: { code: err.code || 'error', message: String(err?.message || err) },
          });
        }
        return;
      }

      case T.SIGNAL:
        return this.peers.signal(msg.peer, msg.payload, link, msg.device);

      case T.ROSTER: {
        const net = loadNetwork();
        if (!net) return;
        // A bare fingerprint: answer with the real thing only if we disagree.
        if (msg.hash && !msg.roster) {
          if (msg.hash !== rosterHash(net)) link.send(T.ROSTER, { roster: rosterOf(net) });
          return;
        }
        if (mergeRoster(net, msg.roster)) {
          this.net = net;
          // We learned something; make sure they get our side of it too.
          link.send(T.ROSTER, { roster: rosterOf(loadNetwork()) });
        } else if (!link.offered && rosterHash(msg.roster) !== rosterHash(net)) {
          // Theirs taught us nothing, yet we still disagree - so we know
          // something they do not, typically a revocation typed on this
          // machine. The hub only sends its roster in reply to our hash, so
          // without this a machine that dials out (a laptop) could never get
          // a removal to the hub it dials (the VM) until it reconnected.
          // Once per tick: two sides that can never agree must not ping-pong.
          link.offered = true;
          link.send(T.ROSTER, { roster: rosterOf(net) });
        }
        return;
      }

      case T.PEERS: {
        // Someone joined or left; take on whatever this hub knows that we do
        // not, then rewrite our SSH files to match.
        const net = loadNetwork();
        if (net && msg.roster && mergeRoster(net, msg.roster)) {
          this.net = net;
          this.#reconcileLinks();
        }
        return applyPeers(msg.peers ?? []);
      }

      case T.TUNNEL_OPEN:
        return this.#openTunnel(link, msg);

      case T.TUNNEL_DATA: {
        this.#tunnels
          .get(this.#key(link, msg.sid))
          ?.sock.write(Buffer.from(msg.data, 'base64'));
        return;
      }

      case T.TUNNEL_CLOSE: {
        const key = this.#key(link, msg.sid);
        this.#tunnels.get(key)?.sock.destroy();
        this.#tunnels.delete(key);
        return;
      }

      case T.PING:
        return link.send(T.PONG);

      case T.PONG:
        return link.onPong();
    }
  }

  // Stream ids are only unique within one hub, and we are attached to
  // several; scope them so two hubs cannot collide on the same number.
  #key = (link, sid) => `${link.id} ${sid}`;

  /**
   * Ports a tunnel may terminate on here.
   *
   * A hub is trusted to carry bytes, not to choose which local service they
   * reach. Without this list, anything holding any credential in the network -
   * a paired phone included - can ask a machine to connect to any port on its
   * own loopback interface and get a full duplex byte stream back, which is
   * every database, admin socket and localhost-only HTTP server on the box.
   *
   * The only things that have ever needed a tunnel are ssh and - while this
   * machine is a nas - its own media listener, which is how a remote hub
   * reaches the byte stream. `tunnel.ports` in ~/.helm/config.json adds to
   * the list for anyone who wants more, deliberately and on the machine
   * itself.
   */
  #allowedTunnelPorts() {
    const extra = loadSettings()?.tunnel?.ports;
    return [
      Number(process.env.HELM_SSH_PORT || 22),
      this.#media?.port,
      ...(Array.isArray(extra) ? extra.map(Number) : []),
    ].filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  }

  /**
   * Terminate a tunnel by connecting to a port on this machine's loopback
   * interface. This is how ssh reaches a box behind NAT: the daemon already
   * holds the outbound connection, so nothing has to accept an inbound one.
   */
  #openTunnel(link, { sid, port }) {
    const wanted = Number(port) || 22;
    if (!this.#allowedTunnelPorts().includes(wanted)) {
      return link.send(T.TUNNEL_CLOSE, { sid, reason: 'port not allowed' });
    }
    const key = this.#key(link, sid);
    const sock = tcpConnect({ host: '127.0.0.1', port: wanted });
    this.#tunnels.set(key, { sock, link });

    sock.on('connect', () => link.send(T.TUNNEL_READY, { sid }));
    sock.on('data', (chunk) =>
      link.send(T.TUNNEL_DATA, { sid, data: chunk.toString('base64') })
    );
    const end = (reason) => {
      if (!this.#tunnels.delete(key)) return;
      link.send(T.TUNNEL_CLOSE, { sid, reason });
      sock.destroy();
    };
    sock.on('error', (err) => end(err.message));
    sock.on('close', () => end('closed'));
  }

  // --------------------------------------------------------------- dispatch

  async dispatch(method, p, caller) {
    switch (method) {
      case M.ENV_INFO:
        return { ...(await this.describe()), name: this.name };

      /**
       * What this machine is called, changed from the app.
       *
       * It is an RPC to the machine being renamed rather than an edit at
       * whichever hub the phone reached, because a machine's roster record
       * has exactly one author: `mergeRoster` drops everyone else's version
       * of us. A name written anywhere else would spread to every machine
       * except this one, and the two halves of the network would then
       * disagree forever - fingerprints never matching, full rosters traded
       * every tick, which is the one failure the gossip design is built to
       * avoid.
       */
      case M.ENV_RENAME: {
        const name = machineName(p.name);
        if (!name) throw new Error(`a machine name is ${NAME_RULE}`);

        const net = loadNetwork() ?? this.net;
        // Names address machines: `ssh laptop`, `helm brain laptop`. Two of
        // them called the same thing makes both ambiguous, and the CLI
        // resolves by name before it resolves by id.
        const taken = Object.values(net.machines).find(
          (m) => m.id !== this.id && String(m.name).toLowerCase() === name.toLowerCase()
        );
        if (taken) throw new Error(`"${name}" is already another machine in this network`);

        this.name = name;
        this.net = describeSelf(net, { name });
        // Now, rather than at the next reconcile: the phone that asked is
        // waiting to see it, and every other machine has the old name in its
        // ssh config until the hub redistributes the roster.
        this.broadcastFrame(T.ROSTER, { roster: rosterOf(this.net) });
        return { id: this.id, name };
      }

      /**
       * What this machine is for, changed by asking the machine itself.
       *
       * Same authorship rule as the name above: `kind` lives on this
       * machine's own roster record, so a CLI or app redesignating a machine
       * asks its daemon - a hub that answered the phone is never asked to
       * write it. pc and nas are a record change; becoming the vm claims an
       * https address first, and failing that fails the whole change.
       */
      case M.MACHINE_SET_KIND:
        return this.setMachineKind(String(p.kind ?? '').toLowerCase(), { address: p.address });

      case M.MEDIA_INFO:
      case M.MEDIA_ROOTS:
      case M.MEDIA_ROOT_ADD:
      case M.MEDIA_ROOT_REMOVE:
      case M.MEDIA_LIST:
      case M.MEDIA_TICKET:
        return this.#mediaRpc(method, p, caller);

      case M.FS_LIST:   return fsApi.list(p.path);
      case M.FS_ROOTS:  return fsApi.roots();
      case M.FS_MKDIR:  return fsApi.makeDir(p);
      case M.FS_SEARCH: return fsApi.search(p.query);

      case M.PROJECT_LIST: {
        const byPath = new Map(listProjects().map((x) => [x.path, x]));
        for (const s of await this.sessions.list()) {
          if (s.engine === 'shell' || !s.cwd) continue;
          try {
            const found = await fsApi.project(s.cwd);
            if (!byPath.has(found.path)) byPath.set(found.path, found);
          } catch {}
        }
        return { projects: [...byPath.values()].sort((a, b) => a.title.localeCompare(b.title)) };
      }

      case M.PROJECT_SAVE: {
        const project = await fsApi.project(p.path);
        const title = String(p.title ?? '').trim();
        if (title) project.title = title;
        return { project: saveProject(project) };
      }

      case M.PROJECT_REMOVE: {
        const path = fsApi.projectPath(p.path);
        for (const s of await this.sessions.list()) {
          if (s.engine === 'shell' || !s.cwd) continue;
          let cwd = collapse(expand(s.cwd));
          try { cwd = (await fsApi.project(s.cwd)).path; } catch {}
          if (cwd === path) throw new Error('delete or move this project’s threads before removing it');
        }
        removeProject(path);
        return { ok: true };
      }

      case M.PROFILE_LIST: {
        // Asked for the list means somebody is looking at what this machine
        // can run - the one moment a stale answer is a wrong one. Discovery
        // is cheap enough to redo every few minutes; between those the saved
        // file answers.
        const profiles = p.refresh
          ? (await refreshProfiles()).profiles
          : await currentProfiles();
        // Each profile carries its account key and model prefs, so the app
        // groups aliases and renders the picker filter with no extra call.
        const cfg = loadSettings();
        return {
          profiles: profiles.map((x) => ({
            ...x, account: accountKey(x), prefs: modelPrefs(x, cfg), defaults: startPrefs(x, cfg),
          })),
        };
      }

      case M.PROFILE_DEFAULTS: {
        const profile = (await getProfiles()).find((x) => x.id === p.profileId);
        if (!profile) throw new Error(`unknown profile: ${p.profileId}`);
        return { ok: true, defaults: saveStartPrefs(profile, p) };
      }

      case M.MODEL_LIST: {
        const profile = (await getProfiles()).find((x) => x.id === p.profileId);
        if (!profile) throw new Error(`unknown profile: ${p.profileId}`);
        const engine = ENGINES[profile.engine];
        const spec = materialize(profile);
        const models = await listModels(
          profile.engine,
          spec.env?.[engine?.homeEnv] ?? engine?.defaultHome,
          spec.env,
        );
        // A live agent reports the pickers it actually has - real display
        // names, the levels this session offers - which beats what the CLI
        // can print. The printed list is the fallback for a cold session.
        const live = p.id ? this.sessions.catalog(p.id) : null;
        if (live) {
          if (live.models?.length) models.models = [...new Set([...live.models, ...models.models])];
          models.labels = { ...(models.labels ?? {}), ...(live.labels ?? {}) };
          // The running agent's pickers are the truth for what it takes: a
          // session whose agent advertises no thinking level gets no chip -
          // offering one would set a value the agent then refuses.
          models.efforts = live.efforts ?? [];
          if (!live.efforts?.length) delete models.effortsByModel;
          if (live.current && !models.default) models.default = live.current;
        }
        // Whether the composer offers a clip at all. A running agent's own
        // answer beats the catalogue's guess: opencode's models.dev entry
        // says what the provider can do, `initialize` says what this agent
        // will actually accept, and only the second one can be right.
        const liveImages = p.id ? this.sessions.acceptsImages(p.id) : null;
        if (liveImages !== null) {
          models.images = liveImages;
          models.imagesByModel = {};
        }
        // The account's approved list trims the picker; `all` skips that for
        // the settings editor, which needs everything to pick from.
        const prefs = modelPrefs(profile);
        const filtered = applyModelPrefs(models, prefs, { all: !!p.all });
        // The permission modes this engine offers, so the app never has to know the flags.
        return { ...filtered, prefs, modes: engine?.driver ? modesFor(profile.engine) : [] };
      }

      case M.MODEL_PREFS: {
        const profile = (await getProfiles()).find((x) => x.id === p.profileId);
        if (!profile) throw new Error(`unknown profile: ${p.profileId}`);
        return { ok: true, prefs: saveModelPrefs(profile, { default: p.default, approved: p.approved }) };
      }

      case M.SESSION_LIST:    return { sessions: await this.sessions.list() };
      case M.SESSION_START:   return { session: await this.sessions.start(p) };
      // Attaching starts a push stream of the screen (E.SESSION_DATA); the
      // reply carries the current screen so the viewer has something at once.
      case M.SESSION_ATTACH:  return this.sessions.attach(p.id, {
        lines: p.lines ?? 400, ansi: p.ansi ?? true, cols: p.cols, rows: p.rows,
      });
      case M.SESSION_DETACH:  return this.sessions.detach(p.id);
      case M.SESSION_RESIZE:  return this.sessions.resize(p.id, p.cols, p.rows);
      case M.SESSION_INPUT:   await this.sessions.input(p.id, p.data, { raw: p.raw, attachments: p.attachments }); return { ok: true };
      case M.SESSION_KEYS:    await this.sessions.keys(p.id, p.keys); return { ok: true };
      case M.SESSION_MESSAGES: return this.sessions.messages(p.id, { limit: p.limit });
      case M.SESSION_KILL:    return this.sessions.kill(p.id);
      case M.SESSION_DISCARD_EMPTY: return this.sessions.discardEmpty(p.id);
      case M.SESSION_TITLE:   return this.sessions.rename(p.id, p.title);
      case M.SESSION_ARCHIVE: return this.sessions.archive(p.id, p.archived !== false);

      // Headless agent sessions.
      case M.SESSION_EVENTS:  return this.sessions.history(p.id, {
        since: p.since ?? 0, limit: p.limit ?? 500, tail: p.tail ?? 0, before: p.before ?? 0,
      });
      case M.SESSION_WATCH:   return this.sessions.watch(p.id);
      case M.SESSION_UNWATCH: return this.sessions.unwatch(p.id);
      case M.SESSION_ANSWER:  return this.sessions.answer(p.id, p.requestId, p.decision ?? {});
      case M.SESSION_INTERRUPT: return this.sessions.interrupt(p.id);
      case M.SESSION_DEQUEUE:  return this.sessions.dequeue(p.id, p.turnId);
      case M.SESSION_SEND_NOW: return this.sessions.sendNow(p.id, p.turnId);
      case M.SESSION_NOTIFY:   return this.sessions.setNotifyDone(p.id, p.on !== false);
      case M.SESSION_MODE:    return this.sessions.setMode(p.id, p.mode);
      case M.SESSION_MODEL:   return this.sessions.setModel(p.id, p.model);
      case M.SESSION_EFFORT:  return this.sessions.setEffort(p.id, p.effort);
      case M.SESSION_SPEED:   return this.sessions.setSpeed(p.id, p.speed);

      // Past transcripts from each CLI's own store. Off by default: scanning
      // them is only worth it when you actually want to reopen an old chat.
      case M.SESSION_INVENTORY: {
        // What the owner archived or dismissed applies here too: these rows
        // are the ones most worth getting rid of, since a machine's CLIs
        // remember every session ever run on it.
        const marks = this.sessions.marks();
        const recent = [];
        for (const x of await inventory(await currentProfiles())) {
          const mark = marks[`found:${x.engine}:${x.id}`];
          if (mark === 'removed') continue;
          // Transcript paths are machine-private. The app only needs the
          // ownership signal; opening the row asks Sessions to resolve the
          // path again on the machine.
          const { transcript, writerPid, ...publicRow } = x;
          recent.push(mark === 'archived' ? { ...publicRow, archived: true } : publicRow);
        }
        return { recent };
      }

      // What `/` offers in this session: helm's own actions plus whatever
      // commands the owner has written for this engine, in this directory.
      case M.SESSION_COMMANDS: {
        const s2 = this.sessions.get(p.id);
        const profile = (await getProfiles()).find((x) => x.id === s2.profileId);
        const engine = ENGINES[s2.engine];
        const available = await this.sessions.commands(p.id);
        return {
          commands: listCommands({
            engine: s2.engine,
            cwd: s2.cwd,
            home: profile?.env?.[engine?.homeEnv] ?? engine?.defaultHome,
            available,
          }),
        };
      }

      // ----------------------------------------------------------- brain
      case M.BRAIN_DIGEST:    return { name: this.name, ...(await this.sessions.digest()) };

      case M.BRAIN_SNAPSHOT: {
        // `cached` serves the picture this machine already had - the app uses
        // it to draw an offline machine's last-known threads without waiting
        // for a refresh that only proves the machine is still down.
        const snap = p.cached ? readSnapshot() : await this.refreshSnapshot();
        return { text: render(snap, { roster: this.rosterState(snap) }), snapshot: snap };
      }

      case M.BRAIN_OPEN: {
        const existing = this.sessions.brainSession();
        if (existing) {
          // Changing the brain is changing the model, not starting a second
          // one: the thread, and everything it has learned, is the point.
          if (p.model && p.model !== existing.model) await this.sessions.setModel(existing.id, p.model);
          if (p.mode && p.mode !== existing.mode) await this.sessions.setMode(existing.id, p.mode);
          return { session: wire(this.sessions.get(existing.id)), created: false };
        }
        if (!p.profileId) throw new Error('brain.open needs a profileId the first time');
        const session = await this.sessions.start({
          cwd: '~', profileId: p.profileId, model: p.model, mode: p.mode,
          title: 'Brain', brain: true,
        });
        // The brief goes in as the first message rather than a system prompt:
        // helm drives four CLIs and not all of them take one, and a message
        // survives `--resume`, so a restarted brain still knows what it is.
        await this.sessions.input(session.id, brief(this.name), { raw: true });
        return { session: wire(this.sessions.get(session.id)), created: true };
      }

      // Picking up a conversation the CLI recorded on its own. The protocol
      // has had a name for this since the beginning and nothing behind it.
      case M.SESSION_RESUME:
        return { session: wire(await this.sessions.resumeExternal(p)) };

      // The device records; the machine holding the key does the rest, so no
      // phone ever has to be trusted with one.
      case M.VOICE_TRANSCRIBE: return transcribe({ audio: p.audio, mime: p.mime, prompt: p.prompt });

      // Nothing to compute: the answer is the round trip itself.
      /**
       * What this machine's agents have spent.
       *
       * Read from each CLI's own records rather than from helm's event log,
       * which is trimmed to the last couple of thousand events - a long thread
       * would otherwise start forgetting what its early turns cost. Answered
       * pre-aggregated: the phone asking may be three network hops away.
       *
       * Every answer is also pushed to the hubs we are attached to, so a hub
       * holding the rollup can keep answering for us after we go to sleep -
       * the same trick digest's snapshot.json plays for the brain.
       */
      case M.USAGE_REPORT: {
        const rollup = await this.#usageRollup(!!p.rebuild);
        this.broadcastFrame(T.USAGE_SYNC, rollup);
        return foldBuckets(rollup.buckets, {
          since: p.since ?? null,
          until: p.until ?? null,
          by: Array.isArray(p.by) && p.by.length ? p.by : ['engine', 'model'],
          accounts: rollup.accounts,
          scan: rollup.scan,
        });
      }

      // The rollup itself, un-folded. What a hub stores for us; the app only
      // ever asks for a folded report.
      case M.USAGE_BUCKETS:
        return this.#usageRollup(!!p.rebuild);

      case M.PING:            return { t: Date.now() };

      case M.SSH_INFO:        return sshInfo();

      default:
        throw Object.assign(new Error(`unknown method: ${method}`), {
          code: 'unknown_method',
        });
    }
  }
}
