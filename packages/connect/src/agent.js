import { listIntegrations, addMcp, removeMcp, connectMcp, addSkills, removeSkill, changePlugin } from './integrations.js';
import WebSocket from 'ws';
import { createHash } from 'node:crypto';
import { beginTransferActivity } from '@helm/protocol/transfer-activity';
import { hostname, platform, arch, release, homedir } from 'node:os';
import { connect as tcpConnect } from 'node:net';
import { T, M, E, CONTROLLER_WORDS, CONTROLLER_REFUSAL } from '@helm/protocol';
import { brainHost } from '@helm/protocol/brain-host';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  loadNetwork, mergeRoster, allEndpoints, describeSelf, hubCredential,
  roster as rosterOf, rosterHash, machineName, NAME_RULE, machineKind,
  MACHINE_KINDS, saveNetwork, watchNetwork,
} from '@helm/protocol/network';
import { createRuntime } from './runtime/index.js';
import { BASH_GUARD_MODES } from './pi-settings.js';
import { modesFor, defaultMode } from './modes.js';
import { Sessions, wire } from './sessions.js';
import { getProfiles, refreshProfiles, currentProfiles, materialize } from './profiles.js';
import { listModels, mergeLiveModelCatalog, followNewModels } from './models.js';
import { nativeControls, nativeModelChoices, nativeEffortChoices } from './native-controls.js';
import { nativeClaudeAccount, nativeAccount } from './native-account.js';
import { readProcess } from './takeover.js';
import { usableProfiles, authStatuses } from './auth.js';
import { listCommands } from './commands.js';
import { contextLimit } from './context-limit.js';
import { accountKey, modelPrefs, modelWatch, dismissModelNews, saveModelPrefs, startPrefs, saveStartPrefs, subagentPrefs, saveSubagentPrefs, pickerPrefs, savePickerPrefs, applyModelPrefs, loadSettings, listProjects, saveProject, removeProject, cliAutoUpdate, saveCliAutoUpdate } from './settings.js';
import { ENGINES } from './engines.js';
import * as fsApi from './fs.js';
import { join } from 'node:path';
import { inventory, scratchFolder } from './inventory.js';
import { UsageReader, foldBuckets } from '@helm/usage';
import { HELM_DIR, collapse, expand } from './paths.js';
import { sshInfo, applyPeers } from './ssh.js';
import { PeerHub, directCaller } from './peer.js';
import { allowDirectSignal } from './direct-auth.js';
import { lanAddresses } from './net-addr.js';
import { LanDiscovery, withHeardAddresses } from './lan-discovery.js';
import { describe as describeAsk, describeDone, askPreview } from './notify.js';
import { listShares, addShare, removeShare, publicShare } from './shares.js';
import { publicHosts } from '@helm/protocol/share';
import { brief, render, summaryLine, readThread, readSnapshot, writeSnapshot, mergeSnapshot } from './brain.js';
import { forWire } from './events.js';
import { hubRpc } from './hub-client.js';
import { HubMesh } from './hub-mesh.js';
import { transcribe, canTranscribe, setGroqKey, directVoice } from './voice.js';
import { codeKeyInfo, codeSigningInfo, answerCodeKeyProof } from './code-transfer.js';
import { Handoffs } from './handoffs.js';
import { TaskTransfers } from './task-transfer.js';
import { TunnelSender, TunnelReceiver, TUNNEL_SOCKET_LIMIT } from './tunnel-flow.js';
import { Transfers } from './transfers.js';
import { CliUpdater } from './cli-updates.js';
import { selfUpdate, currentVersion, makeBundle, syncFromBundle, rebuildIfCommitted, watchCheckout } from './update.js';
import { synchronizeVersion } from './version-sync.js';
import * as gitq from './git.js';
import { createGithubMonitor } from './github.js';
import { createGithubRepos } from './github-repos.js';
import { agentCatalog, markShown, helmBrief } from './delegation.js';
import { loadOwner, mergeOwner, ownerHash, editOwner } from '../../protocol/owner.js';
import { OwnerKeeper, ownerWords, askHidden } from './owner-keeper.js';
import { EVENTS_DIR } from './events.js';
import { SendEngine } from './send-engine.js';
import { CopyReceiver } from './copy-transport.js';
import { Schedules } from './schedules.js';
import { ExecutionJobs } from './execution.js';
import { ensureTcpRecovery } from './network-recovery.js';
import { NetworkMonitor } from './network-monitor.js';
import { createBrowserRoutes } from './browser-routes.js';
import { AgentMessages } from './agent-messages.js';
import { InputDelivery } from './input-delivery.js';

const RECONNECT_MIN = 250;
const RECONNECT_MAX = 5000;
/** How recently a machine must have answered to be called online. */
const FRESH_MS = 90_000;

const RECONCILE_MS = 15_000;
// The keeper looks once an hour whether its day is up (owner-keeper.js); the
// first look waits until the machine has settled after a start.
const KEEPER_CHECK_MS = 60 * 60_000;
const KEEPER_FIRST_MS = 10 * 60_000;
/** How often the brain's picture of the network is refreshed, while one exists. */
const BRAIN_REFRESH_MS = 45_000;
const HEARTBEAT_MS = 20_000;
/** Cache warm-ups wait this long, so they never compete with coming online. */
const WARM_DELAY_MS = 2_000;
/** The first quiet update check, once startup has settled. */
const UPDATE_AFTER_START_MS = 20_000;
/** How often machines compare saved versions. */
const SYNC_EVERY_MS = 2 * 60_000;

/**
 * One connection to one hub.
 *
 * A machine keeps one of these open to every hub it can currently reach,
 * including the one it is running itself. That redundancy is the point: a
 * phone that can only reach the VM and a laptop that can only be reached on
 * the LAN still meet, as long as some hub can see both of them.
 */
export class Link {
  #ws = null;
  #backoff = RECONNECT_MIN;
  #stopped = false;
  #beat = null;
  #waiting = false;
  #retryTimer = null;
  #pingAt = null;
  #generation = 0;
  #opening = null;
  #probeTimer = null;

  constructor(daemon, url, { hintFor, recoveryTimeout = 5000 } = {}) {
    this.daemon = daemon;
    this.url = url;
    this.id = url;
    this.connected = false;
    this.rtt = null;
    this.recoveryTimeout = recoveryTimeout;
    // Set when this address came from a machine announcing itself on the
    // local network rather than from the roster: whose hub it should be.
    this.hintFor = hintFor ?? null;
  }

  start() { this.#open().catch(() => this.#retry()); return this; }

  #retry() {
    if (this.#stopped || this.#retryTimer) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#open().catch(() => this.#retry());
    }, this.#backoff);
    this.#retryTimer.unref?.();
    this.#backoff = Math.min(this.#backoff * 2, RECONNECT_MAX);
  }

  stop() {
    this.#stopped = true;
    this.#reset();
  }

  #reset() {
    this.#generation++;
    this.#opening?.abort();
    this.#opening = null;
    const wasConnected = this.connected;
    this.connected = false;
    clearInterval(this.#beat);
    clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    clearTimeout(this.#probeTimer);
    this.#probeTimer = null;
    this.#pingAt = null;
    this.rtt = null;
    try { this.#ws?.terminate(); } catch { /* already gone */ }
    if (wasConnected) this.daemon.linkDown?.(this);
  }

  /** Keep a healthy socket; replace a stale path without waiting for its old timeout. */
  recover() {
    if (this.#stopped || this.#probeTimer) return;
    this.rtt = null;
    if (!this.connected) {
      this.#reset();
      this.#backoff = RECONNECT_MIN;
      this.start();
      return;
    }
    this.#probeTimer = setTimeout(() => {
      this.#probeTimer = null;
      if (this.#stopped) return;
      this.#reset();
      this.#backoff = RECONNECT_MIN;
      this.start();
    }, this.recoveryTimeout);
    this.#probeTimer.unref?.();
    this.#ping();
  }

  #alive() {
    this.#waiting = false;
    clearTimeout(this.#probeTimer);
    this.#probeTimer = null;
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
        console.warn(`[helm] ${this.url}: heartbeat timed out`);
        try { this.#ws?.terminate(); } catch { /* already gone */ }
        return;
      }
      this.#waiting = true;
      this.#ping();
    }, HEARTBEAT_MS);
    this.#beat.unref?.();
    // One straight away, so a fresh link has a round-trip time to show
    // rather than a blank for the first twenty seconds.
    this.#ping();
  }

  #ping() {
    this.#pingAt = performance.now();
    this.send(T.PING);
  }

  /**
   * The heartbeat doubles as a cheap measure of how far away this hub is:
   * `rtt` is a running average of ping to pong, in milliseconds. It is the
   * first leg only - `helm status` shows it next to the full trip the mesh
   * times through this hub to each machine.
   */
  onPong() {
    this.#alive();
    if (this.#pingAt == null) return;
    const sample = performance.now() - this.#pingAt;
    this.#pingAt = null;
    this.rtt = this.rtt == null ? sample : this.rtt + 0.3 * (sample - this.rtt);
  }

  send(t, extra = {}) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify({ t, ...extra }));
    }
  }

  get tunnelWritable() {
    return this.#ws?.readyState === WebSocket.OPEN && this.#ws.bufferedAmount < TUNNEL_SOCKET_LIMIT;
  }

  async #open() {
    if (this.#stopped) return;
    const generation = this.#generation;
    const current = () => !this.#stopped && generation === this.#generation;
    const opening = this.#opening = new AbortController();
    let info;
    // The one hub a machine attaches to as *itself* is its own, on loopback -
    // which is what lets a phone reach this machine through the very hub this
    // machine is running. Mark that link `role=self` so the hub can allow this
    // single case while still refusing any other self-attach (a machine that
    // accidentally dialled its own public address, which would set off the
    // supersede war invariant #2 exists to prevent).
    const isSelf = this.url === `http://127.0.0.1:${this.daemon.port}`;
    // The hub proves itself before it hears a credential from us, and what
    // it hears is good for this one socket. See hubCredential.
    let credential;
    try {
      info = await this.daemon.describe();
      if (!current()) return;
      credential = await hubCredential(loadNetwork() ?? this.daemon.net, this.url, { signal: opening.signal });
    } catch (err) {
      if (!current()) return;
      if (err.untrusted && !this.warned) {
        this.warned = true;
        console.log(`[helm] ${this.url}: ${err.message}`);
      }
      this.#retry();
      return;
    }
    if (!current()) return;
    this.#opening = null;
    this.warned = false;
    // The token travels as a header rather than in the URL, so it never
    // appears in the access logs of Caddy or a tunnel along the way.
    const ws = new WebSocket(
      `${this.url.replace(/^http/, 'ws')}/ws` +
      `?name=${encodeURIComponent(this.daemon.name)}` +
      `&info=${encodeURIComponent(JSON.stringify(info))}` +
      (isSelf ? '&role=self' : ''),
      { headers: { authorization: `Bearer ${credential}` }, handshakeTimeout: 15_000 }
    );
    this.#ws = ws;

    ws.on('open', () => {
      if (!current()) { ws.terminate(); return; }
      this.#backoff = RECONNECT_MIN;
      this.connected = true;
      this.#heartbeat();
      this.daemon.onLinkUp(this);
    });

    ws.on('message', (raw) => {
      if (!current()) return;
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      // Data and credit frames also prove the hub is alive. A pong queued
      // behind transfer bytes must not tear down an actively flowing link.
      this.#alive();
      this.daemon.onFrame(this, msg).catch((err) =>
        console.error(`[helm] ${this.url}: ${err?.message || err}`)
      );
    });

    ws.on('close', (code, reason) => {
      if (!current()) return;
      const was = this.connected;
      this.connected = false;
      clearInterval(this.#beat);
      clearTimeout(this.#probeTimer);
      this.#probeTimer = null;
      if (this.#stopped) return;
      if (was) console.log(`[helm] lost ${this.url} (${code}${reason?.length ? `: ${reason}` : ''}); retrying`);
      if (was) this.daemon.linkDown?.(this);
      this.#retry();
    });

    // Unreachable hubs are normal - a laptop that is asleep, a LAN address
    // from a network we are not on. Retrying quietly is the correct response.
    ws.on('error', () => {});
    ws.on('unexpected-response', (_request, response) => {
      response.resume();
      ws.terminate();
    });
  }
}

export class Daemon {
  #links = new Map();
  #versionP = null;
  #about = null;
  #wake = null;
  #stopWatchCheckout = null;
  #syncing = false;
  #syncAgain = false;
  /** Set when this machine and another both have their own changes. */
  syncNote = null;

  async #syncVersions() {
    // A version checked out mid-round is looked at again once the round ends.
    if (this.#syncing) { this.#syncAgain = true; return; }
    if (process.env.HELM_NO_UPDATE === '1' || process.env.HELM_NO_SERVICE === '1') return;
    // Only a daemon the service manager started can restart itself into a
    // new version: systemd on Linux, the LaunchAgent on macOS.
    if (!process.env.INVOCATION_ID && process.env.XPC_SERVICE_NAME !== 'dev.helm.serve') return;
    this.#syncing = true;
    try {
      const running = (await this.#versionP)?.full;
      const net = loadNetwork() ?? this.net;
      const r = await synchronizeVersion({ running, currentVersion, rebuildIfCommitted,
        selfUpdate, syncFromBundle, net, id: this.id, rpc: hubRpc });
      this.syncNote = r.note ?? null;
      if (r.updated) { this.#syncAgain = false; console.log('[helm] updated Helm - restarting when safe'); }
    } catch (err) {
      console.error('[helm] version sync:', err?.message || err);
    } finally {
      this.#syncing = false;
      if (this.#syncAgain && !this.#stopped) { this.#syncAgain = false; void this.#syncVersions(); }
    }
  }
  #offlineSince = null;
  #tunnels = new Map();
  #brainTimer = null;
  #keeperFirst = null;
  #keeperTimer = null;
  #brainOpening = null;
  #stopped = false;
  #reconcile = null;
  #stopWatch = null;
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
    this.copyReceiver = new CopyReceiver({ network: () => loadNetwork() ?? this.net });
    this.executions = new ExecutionJobs();
    this.browsers = createBrowserRoutes({ sessions: { get: id => this.sessions.get(id) }, onOpen: payload => this.#emit(E.BROWSER_TAB, payload) });
    this.cliUpdates = new CliUpdater({
      auto: () => cliAutoUpdate(),
      // Only asked on Windows, where a running program can not be replaced.
      busy: async (engine) => (await this.sessions.list())
        .some((x) => x.engine === engine && ['working', 'blocked', 'starting'].includes(x.status)),
    });
  }

  async start() {
    await this.#checkNetworkRecovery();
    // What every link reports about this machine starts being worked out now,
    // beside the wait for herdr, instead of after it - see describe().
    this.#versionP = currentVersion().catch(() => null);
    import('./pty.js').then((m) => m.loadPty()).catch(() => {});
    this.runtime = await createRuntime();
    this.runtimeInfo = await this.runtime.ensureReady();

    this.peers = new PeerHub(
      (peer, payload, link) =>
        (link ?? { send: (t, e) => this.broadcastFrame(t, e) }).send(T.SIGNAL, { peer, payload }),
      (method, params, caller) => this.dispatch(method, params, caller),
      {
        onTunnel: (link, frame, caller) => this.#directTunnel(link, frame, caller),
        onTunnelClose: (link) => this.copyReceiver?.dropLink(link),
        // Every request on a direct channel is checked as a hub checks the
        // ones it forwards: against who the hub introduced, never who the
        // request says it is from. Machine offers first prove that identity
        // with their pinned signing key in onFrame below.
        authorize: (device, frame) => directCaller(loadNetwork() ?? this.net, device, frame.sub, loadSettings()?.directRoutes !== false),
        // Machines open channels to ask questions; they hear events through
        // their hubs. Only phones and browsers want them sent direct.
        events: (device) => !Object.hasOwn((loadNetwork() ?? this.net).machines ?? {}, device),
      }
    );

    this.sessions = new Sessions(this.runtime, { log: (m) => console.error(`[helm] ${m}`) });
    this.inputDelivery = new InputDelivery(this.sessions, { log: m => console.error(`[helm] ${m}`) });
    this.agentMessages = new AgentMessages({ sessions: this.sessions, delivery: this.inputDelivery, self: this.id,
      rpc: (env, method, params) => hubRpc(loadNetwork() ?? this.net, env, method, params, { timeout: 30_000 }),
      emit: payload => this.#emit('agent.message', payload) });
    if (brainHost((loadNetwork() ?? this.net).machines)?.id !== this.id) this.sessions.retireBrains();
    this.github = createGithubMonitor({
      context: gitq.githubContext, watchFile: join(HELM_DIR, 'github-watches.json'),
      accountFile: join(HELM_DIR, 'github-accounts.json'),
      session: id => { try { return { ...this.sessions.get(id), envId: this.id }; } catch { return null; } },
      canWake: id => this.sessions.canReturnTask(id),
      wake: (id, prompt, options) => this.sessions.input(id, prompt, options),
      notify: payload => this.broadcastFrame(T.NOTIFY, { payload }),
      emit: payload => this.#emit(E.GIT_MONITOR, payload),
    });
    this.githubRepos = createGithubRepos({ noteFolder: fsApi.noteFolder });
    this.sessions.cloner = this.githubRepos;
    try { this.schedules = new Schedules({ sessions: this.sessions, shareName: `helm-hooks-${createHash('sha256').update(this.id).digest('hex').slice(0, 16)}`,
      publicOrigin: () => { const host = publicHosts(loadNetwork() ?? this.net)[0]; return host ? `https://${this.schedules.shareName}.${host}` : null; } }); }
    catch (error) { console.error(`[helm] schedules unavailable: ${error.message}`); }
    this.sessions.delegationBrief = () => helmBrief(loadNetwork() ?? this.net);
    this.keeper = new OwnerKeeper({
      self: () => this.id, name: () => this.name, network: () => loadNetwork() ?? this.net,
      words: async (p) => ownerWords(await this.sessions.list(), { dir: EVENTS_DIR, since: Number(p.since) || 0, read: p.read }),
      rpc: (env, method, params) => hubRpc(loadNetwork() ?? this.net, env, method, params, { timeout: 30_000 }),
      agents: async () => { const profiles = await getProfiles(); return agentCatalog(profiles, await authStatuses(profiles)); },
      ask: (p) => askHidden(this.sessions, p),
      changed: (record) => this.broadcastFrame(T.OWNER, { record }),
      log: (line) => console.log(`[helm] ${line}`),
    });
    this.handoffs = new Handoffs({
      sessions: this.sessions,
      network: () => loadNetwork() ?? this.net,
    });
    this.transfers = new Transfers({
      network: () => loadNetwork() ?? this.net,
      rpc: (env, method, params, opts) =>
        hubRpc(loadNetwork() ?? this.net, env, method, params, opts),
    });
    this.sendEngine = new SendEngine({ network: () => loadNetwork() ?? this.net, presence: () => this.sendPresence(),
      rpc: (env, method, params, opts) => hubRpc(loadNetwork() ?? this.net, env, method, params, opts),
      emit: payload => this.#emit(E.SEND_UPDATE, payload),
    });
    this.taskTransfers = new TaskTransfers({
      sendEngine: this.sendEngine,
      network: () => loadNetwork() ?? this.net,
      sessions: this.sessions,
      rpc: (env, method, params, opts) => hubRpc(loadNetwork() ?? this.net, env, method, params, opts),
      enqueue: async (targetMachineId, params) => {
        const { hubBroadcastRpc } = await import('./hub-client.js');
        return hubBroadcastRpc(loadNetwork() ?? this.net, targetMachineId,
          M.DISPATCH_SUBMIT, { targetMachineId, params }, { timeout: 120_000, remoteOnly: true });
      },
    });
    this.taskTransfers.start();
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
    this.sessionRecovery = this.sessions.adoptTerminals()
      .catch(() => {})
      .then(() => this.sessions.resume())
      .then(() => { if (!this.#stopped) { this.inputDelivery.resume(); this.schedules?.start(); this.sessions.startLimitRecovery(); } })
      .catch((error) => console.error(`[helm] session recovery: ${error.message}`));
    // Caches worth having warm, none worth being late for: they start once
    // the links are up. Re-reading the shell's aliases blocks for a moment,
    // and that moment used to sit in front of this machine coming online.
    const warm = setTimeout(() => {
      if (this.#stopped) return;
      // The folder index behind `fs.search`: one background walk now, so the
      // first query is answered from memory rather than starting the walk then.
      fsApi.warmIndex?.();
      // Likewise which accounts are signed in - and, as a side effect of asking
      // agy, their model lists - so opening the picker or choosing an account
      // soon after a restart answers from memory instead of from the CLIs.
      currentProfiles().then(async (profiles) => {
        const statuses = await authStatuses(profiles);
        this.cliAgents = await agentCatalog(profiles, statuses, { models: false });
      }).catch(() => {});
    }, WARM_DELAY_MS);
    warm.unref?.();
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
      if (!session.delegation && !this.sessions.hasActiveDelegations(session.id) && session.notifyDone && to === 'idle' && from !== 'idle') {
        this.#notifyDone(session);
      }
    });
    this.sessions.on('event', ({ id, event }) => {
      this.#queueEvent(id, event);
      if (event?.type === 'permission.request') {
        this.#notify(id, event);
        // The list only hears "blocked"; this says what about, so the
        // in-app notice and the Needs-you card can show the question.
        let session = null;
        try { session = this.sessions.get(id); } catch { /* gone already */ }
        if (session) this.#emit(E.SESSION_UPDATE, { session: { ...wire(session), ask: { ...askPreview(event), requestId: event.requestId } }, asked: true });
      }
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
    // The daemon's own timer is the keeper's whole trigger: no schedule, and
    // on every machine but the keeper's this is a roster read once an hour.
    const keep = () => { if (!this.#stopped) this.keeper.maybeRun().catch((err) => console.error('[helm] keeper:', err?.message || err)); };
    this.#keeperFirst = setTimeout(keep, KEEPER_FIRST_MS);
    this.#keeperFirst.unref?.();
    this.#keeperTimer = setInterval(keep, KEEPER_CHECK_MS);
    this.#keeperTimer.unref?.();

    await this.#tick();
    // Listen for machines on the same network, and say we are here. Started
    // after the first tick so the roster links go out first; an address
    // heard here only adds a link, it never replaces one that works.
    this.lan = new LanDiscovery({
      network: () => loadNetwork() ?? this.net,
      port: this.port,
      announce: this.advertiseLan,
      onChange: () => this.#reconcileLinks(),
    });
    this.lan.start().catch((err) => console.error('[helm] local network discovery:', err?.message || err));
    this.networkMonitor = new NetworkMonitor(reason => this.#networkChanged(reason));
    void this.networkMonitor.start().catch(error => console.warn('[helm] network monitor:', error.message));
    // Start the fingerprint exchange the moment our roster changes instead of
    // at the next tick: a removal typed on this machine reaches the hubs in a
    // second, not up to fifteen. The tick below remains the net under it.
    this.#stopWatch = watchNetwork((net) => {
      if (this.#stopped) return;
      // The later `rosterOf(this.net)` broadcasts must not offer a roster from
      // before the change that woke us.
      this.net = net;
      for (const link of this.#links.values()) link.offered = false;
      this.broadcastFrame(T.ROSTER, { hash: rosterHash(net) });
      if (net.revoked?.[net.self]) this.peers?.stop();
      else this.peers?.dropRevoked(net.revoked);
      this.copyReceiver?.dropRevoked(net.revoked);
      this.mesh?.dropRevoked(net.revoked);
    });
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

    // Every machine checks the published release and peers: a
    // version saved here is built and started, and a newer one saved on
    // another machine is copied over the network. Soon after start, then
    // every couple of minutes.
    const first = setTimeout(() => { if (!this.#stopped) void this.#syncVersions(); }, UPDATE_AFTER_START_MS);
    first.unref?.();
    this.#wake = setInterval(() => { if (!this.#stopped) void this.#syncVersions(); }, SYNC_EVERY_MS);
    this.#wake.unref?.();
    // A version checked out here is taken at once, not on the next round.
    if (process.env.HELM_NO_UPDATE !== '1' && process.env.HELM_NO_SERVICE !== '1') {
      this.#stopWatchCheckout = watchCheckout(() => { if (!this.#stopped) void this.#syncVersions(); });
    }

    // Test runs and `HELM_NO_UPDATE` machines never touch the coding tools.
    if (process.env.HELM_NO_UPDATE !== '1' && process.env.HELM_NO_SERVICE !== '1') this.cliUpdates.start();
  }

  /** A remote hub came back after a long time away: the machine is back online. */
  #noteRemote(up) {
    const remote = [...this.#links.values()].filter((l) => !l.url.includes('127.0.0.1'));
    if (!up) {
      if (!remote.some((l) => l.connected)) this.#offlineSince ??= Date.now();
      return;
    }
    if (this.#offlineSince) void this.#syncVersions();
    this.#offlineSince = null;
  }

  linkDown(link) {
    this.mesh?.down(link);
    this.#noteRemote(false);
    this.copyReceiver?.dropLink(link);
    for (const [key, tunnel] of this.#tunnels) {
      if (tunnel.link !== link) continue;
      tunnel.release?.();
      tunnel.sender?.stop();
      tunnel.receiver?.stop();
      tunnel.sock.destroy();
      this.#tunnels.delete(key);
    }
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
          ? { name: this.name, projects: listProjects(), ...(await this.sessions.digest()) }
          : await hubRpc(net, id, M.BRAIN_DIGEST, {}, { timeout: 8000, budget: 6000 });
        fresh[id] = { name: r.name ?? net.machines[id]?.name ?? id, sessions: r.sessions ?? [], projects: r.projects ?? [] };
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

  async stop() {
    if (this.#stopped) return;
    this.#stopped = true;
    this.inputDelivery?.stop();
    await this.executions.stop();
    await this.browsers?.stop();
    clearInterval(this.#brainTimer);
    clearTimeout(this.#keeperFirst);
    clearInterval(this.#keeperTimer);
    clearInterval(this.#reconcile);
    clearInterval(this.#wake);
    this.#stopWatchCheckout?.();
    this.cliUpdates?.stop();
    this.taskTransfers?.stop();
    await this.sendEngine?.stop();
    this.schedules?.stop();
    this.github?.stop();
    this.#stopWatch?.();
    this.lan?.stop();
    this.networkMonitor?.stop();
    for (const link of this.#links.values()) link.stop();
    this.mesh?.stop();
    // A locally terminated tunnel is a live socket even after every hub link
    // is gone. Close those too, or stopping the daemon can leave connections
    // (and the process that owns them) alive indefinitely.
    for (const tunnel of this.#tunnels.values()) {
      tunnel.release?.();
      tunnel.sender?.stop();
      tunnel.receiver?.stop();
      tunnel.sock.destroy();
    }
    this.#tunnels.clear();
    this.#media?.server.close();
    this.#media = null;
    await this.copyReceiver?.stop();
    this.peers?.stop();
    this.runtime?.stop();
    this.usage?.stop();
    // Hosted agents are detached by Sessions.stop() and rebound at boot;
    // local ones are stopped as before. Awaiting this is important during a
    // systemd restart: the daemon must release its side of every session
    // before the service exits.
    await this.sessions?.stop().catch(() => {});
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
    this.#hintOwners = new Map();
    const plan = withHeardAddresses({
      urls, net, self: this.id, mine,
      connected: (url) => !!this.#links.get(url)?.connected,
      // A hint link that is up stays up, even if an announcement or two was lost.
      heard: this.lan?.active ? [
        ...[...this.#links.values()].filter((l) => l.hintFor && l.connected).map((l) => ({ url: l.url, id: l.hintFor })),
        ...this.lan.list(),
      ] : [],
    });
    this.#hintOwners = plan.owners;
    return plan.urls;
  }

  /** Hinted address -> the machine that announced it, for this round's links. */
  #hintOwners = new Map();

  async #networkChanged(reason) {
    if (this.#stopped) return;
    console.log(`[helm] ${reason}; checking remote connections`);
    // Loopback never crosses a VPN. Leave it, hosted sessions and healthy
    // remote sockets alone. Lost writes keep the existing uncertain-delivery
    // semantics; only future requests take a freshly chosen route.
    for (const link of this.#links.values()) {
      if (link.url !== `http://127.0.0.1:${this.port}`) link.recover();
    }
    this.mesh?.networkChanged();
    this.#networkRecoveryAt = -Infinity;
    await Promise.all([this.lan?.networkChanged(), this.#tick()]);
  }

  #networkRecoveryAt = -Infinity;
  networkRecovery = null;

  async #checkNetworkRecovery() {
    if (Date.now() - this.#networkRecoveryAt < SYNC_EVERY_MS) return;
    this.#networkRecoveryAt = Date.now();
    const previous = this.networkRecovery;
    this.networkRecovery = await ensureTcpRecovery();
    if (this.networkRecovery.repair && (!previous?.repair || previous.reason !== this.networkRecovery.reason)) {
      console.warn(`[helm] packet-size recovery needs setup: ${this.networkRecovery.reason} Run helm network-repair.`);
    }
  }

  async #tick() {
    if (this.#stopped) return;
    void this.#checkNetworkRecovery().catch(error => console.warn('[helm] packet-size recovery:', error.message));
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
      for (const link of this.#links.values()) link.ownerOffered = false;
      this.broadcastFrame(T.OWNER, { hash: ownerHash(loadOwner()) });
      // A direct WebRTC channel is authenticated once, when the hub makes the
      // introduction. Revocation has to reach it too, or a removed phone
      // keeps a working side door to this machine.
      if (net.revoked?.[net.self]) this.peers?.stop();
      else this.peers?.dropRevoked(net.revoked);
      this.copyReceiver?.dropRevoked(net.revoked);
      this.mesh?.dropRevoked(net.revoked);
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
      this.#links.set(url, new Link(this, url, { hintFor: this.#hintOwners.get(url) }).start());
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
    const code = codeKeyInfo();
    const signing = codeSigningInfo();
    this.net = describeSelf(net, {
      endpoints,
      pubkey: ssh.pubkey,
      sshUser: ssh.sshUser,
      sshPort: ssh.sshPort,
      codePubkey: code.codePubkey,
      codeSignPubkey: signing.codeSignPubkey,
      sendV2: true,
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
    void this.taskTransfers?.reconcile();
    const local = link.url.includes('127.0.0.1');
    if (!local) this.#noteRemote(true);
    console.log(
      `[helm] ${local ? 'serving locally' : `linked to ${link.url}`} as "${this.name}"`
    );
    // Say what we know straight away rather than waiting for the next
    // reconcile tick: this is how a hub learns our addresses, and how a
    // revocation made while it was offline reaches it.
    const net = loadNetwork();
    if (net) link.send(T.ROSTER, { roster: rosterOf(net) });
    link.send(T.OWNER, { hash: ownerHash(loadOwner()) });
    if (!local) this.mesh?.up(link);
    // One way into each machine's hub: whichever of a heard address and the
    // roster's came up first, the other is dropped now rather than at the
    // next tick, before the two can take turns superseding each other.
    if (!local) this.#reconcileLinks();
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

  /**
   * How this machine reaches every other one right now: which hub, whether
   * it is the machine's own, and the measured round trip - plus what the
   * local network discovery has heard. What `helm status` prints.
   */
  routes() {
    const net = loadNetwork() ?? this.net;
    const name = (id) => net.machines?.[id]?.name ?? id;
    // A machine that dialled into this machine's own hub is reached on that
    // socket, before any other hub is asked; the closest thing to its round
    // trip is our own heartbeat to its hub, when we hold a link there too.
    const attached = [...(this.localOnline?.keys() ?? [])].filter((id) => id !== this.id && !net.revoked?.[id])
      .map((env) => {
        const mine = this.live.find((l) => l.hintFor === env || (net.machines?.[env]?.endpoints ?? []).includes(l.url));
        return { env, attached: true, url: null, own: true, ms: null, hubMs: mine?.rtt == null ? null : Math.round(mine.rtt), others: [] };
      });
    const table = [...attached, ...(this.mesh?.table() ?? []).filter((r) => !this.localOnline?.has(r.env))];
    const reached = new Set(table.map((r) => r.env));
    return {
      recovery: this.networkRecovery,
      machines: [
        ...table.map((r) => ({ ...r, name: name(r.env) })),
        ...Object.keys(net.machines ?? {}).filter((id) => id !== this.id && !net.revoked?.[id] && !reached.has(id))
          .map((env) => ({ env, name: name(env), url: null })),
      ],
      lan: this.lan?.status() ?? { on: false, reason: 'not started', heard: [] },
    };
  }

  /** The hubs we can actually talk to right now. */
  get live() {
    return [...this.#links.values()].filter((l) => l.connected);
  }

  // Send availability follows live hub routes; brain snapshots can be stale or absent.
  sendPresence() {
    if (!this.localOnline) return this.rosterState();
    const reached = new Set([...this.localOnline.keys(), ...(this.mesh?.machines().keys() ?? [])]);
    const net = loadNetwork() ?? this.net;
    return Object.fromEntries(Object.keys(net.machines ?? {}).map(id => [id, { online: reached.has(id) }]));
  }

  attachHub(hub) {
    this.localOnline = hub.online;
    // Direct channels to other machines, with the hubs as the backup. Off
    // with `"directRoutes": false` in ~/.helm/config.json.
    this.mesh = new HubMesh(loadNetwork, hub.meshChanged, hub.meshEvent, hub.meshSignal,
      { direct: loadSettings()?.directRoutes === false ? false : { enabled: () => loadSettings()?.directRoutes !== false } });
    hub.attachMesh(this.mesh);
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
    if (session?.delegation) return;
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
    this.broadcastFrame(T.NOTIFY, {
      payload: describeDone({ ...session, envId: this.id }),
    });
  }

  async describe() {
    // Worked out once and shared: every link asks at the same moment on
    // startup, and each used to run its own git commands and pty check. The
    // answer changes only when an update lands, and an update restarts us.
    this.#about ??= Promise.all([
      this.#versionP ?? currentVersion().catch(() => null),
      this.sessions.terminalBackend().catch(() => 'panes'),
    ]);
    const [version, terminals] = await this.#about;
    this.version = version;
    return {
      version,
      host: hostname(),
      // Where a big project sent here lands by default, and a sign that this
      // machine accepts one copied ahead of its handoff (bulk-transfer.js).
      home: homedir(),
      precopiedHandoff: true,
      agentMessages: true,
      sendV2: true,
      // Answers requests from other machines over a direct channel, checking
      // each one as a hub would (direct-mesh.js). Older machines leave this
      // out, and are only ever asked through a hub.
      ...(loadSettings()?.directRoutes === false ? {} : { directRpc: 1 }),
      platform: platform(),
      arch: arch(),
      release: release(),
      runtime: this.runtimeInfo,
      // 'pty' or 'panes': what a terminal here will actually be.
      terminals,
      // Whether this machine can turn a recording into words. The composer
      // only offers a microphone when something in the network can, so a
      // button that could not possibly work is never drawn.
      voice: canTranscribe(),
      sync: this.syncNote,
      // Whether a `claude` typed in a terminal here shows up in Helm.
      cliLink: await import('./native-cli.js').then((m) => m.nativeIntegrationStatus()).catch(() => null),
      startedAt: Date.now(),
    };
  }

  // ----------------------------------------------------------------- frames

  async onFrame(link, msg) {
    if (this.mesh?.receive(link, msg)) return;
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

      // A queued handoff arriving from a hub's store. The same job can be
      // delivered by several hubs and more than once by each - the accept
      // underneath is idempotent, so the work is only ever done once.
      case T.HANDOFF_JOB: {
        const p = msg.params;
        const malformed = !p || typeof p !== 'object'
          || p.handoffId !== msg.handoffId
          || p.sourceMachineId !== msg.sourceMachineId
          || p.targetMachineId !== this.id;
        if (malformed) {
          link.send(T.HANDOFF_RESULT, {
            handoffId: msg.handoffId, ok: false,
            error: 'the handoff job does not match this machine',
          });
          return;
        }
        this.handoffs.accept(p, msg.sourceMachineId)
          .then((receipt) => link.send(T.HANDOFF_RESULT, { handoffId: msg.handoffId, ok: true, receipt }))
          .catch((err) => link.send(T.HANDOFF_RESULT, {
            handoffId: msg.handoffId, ok: false,
            error: String(err?.message || err).slice(0, 500),
          }));
        return;
      }

      // A queued handoff that finished while this machine was a target of
      // nothing - it was the source. The hub tells us where the child
      // session landed; linkChild dedupes by handoffId, so every reconnect
      // may repeat this harmlessly.
      case T.HANDOFF_COMPLETE: {
        try {
          const receipt = msg.receipt;
          const net = loadNetwork() ?? this.net;
          const clean = typeof msg.handoffId === 'string' && /^[a-f0-9]{24}$/.test(msg.handoffId)
            && !!net?.machines?.[msg.targetMachineId] && !net?.revoked?.[msg.targetMachineId]
            && typeof msg.parentSessionId === 'string'
            && msg.parentSessionId.length > 0 && msg.parentSessionId.length <= 80
            && receipt && typeof receipt === 'object'
            && typeof receipt.sessionId === 'string'
            && receipt.sessionId.length > 0 && receipt.sessionId.length <= 80
            && typeof receipt.folder === 'string' && receipt.folder.length <= 1024
            && typeof receipt.digest === 'string' && /^[a-f0-9]{64}$/.test(receipt.digest);
          if (!clean) throw new Error('malformed handoff completion');
          this.sessions.linkChild(msg.parentSessionId, {
            handoffId: msg.handoffId,
            machineId: msg.targetMachineId,
            sessionId: receipt.sessionId,
            title: typeof msg.title === 'string' ? msg.title : null,
            folder: receipt.folder,
            digest: receipt.digest,
          });
        } catch (err) {
          // A stale or malformed completion is noise, not a reason to drop
          // the link carrying it.
          console.error(`[helm] handoff completion ignored: ${err?.message || err}`);
        }
        return;
      }

      case T.SIGNAL:
        if (!allowDirectSignal(loadNetwork() ?? this.net, msg.device, msg.payload, loadSettings()?.directRoutes !== false)) return;
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

      // The owner's preferences: the roster's exchange above, for one record
      // any machine may write (protocol/owner.js).
      case T.OWNER: {
        const ours = loadOwner();
        if (msg.hash && !msg.record) {
          if (msg.hash !== ownerHash(ours)) link.send(T.OWNER, { record: ours });
          return;
        }
        if (!msg.record) return;
        if (mergeOwner(msg.record)) {
          // New to us, so maybe to the other hubs we reach too.
          for (const other of this.live) if (other !== link) other.send(T.OWNER, { record: msg.record });
        } else if (!link.ownerOffered && ownerHash(msg.record) !== ownerHash(ours)) {
          // Theirs is older. Once per tick, so two sides can never ping-pong.
          link.ownerOffered = true;
          link.send(T.OWNER, { record: ours });
        }
        return;
      }

      case T.PEERS: {
        // Someone joined or left; take on whatever this hub knows that we do
        // not, then rewrite our SSH files to match.
        //
        // The keys come from our own roster after the merge, not from the
        // frame's `peers`: that list is the hub's word alone, and what lands
        // in authorized_keys should have passed the same checks as the
        // roster it was derived from on the hub side anyway.
        const net = loadNetwork();
        if (net && msg.roster && mergeRoster(net, msg.roster)) {
          this.net = net;
          this.#reconcileLinks();
        }
        const known = loadNetwork() ?? net;
        if (!known) return;
        return applyPeers(Object.values(known.machines ?? {})
          .filter((m) => m.pubkey && m.id !== known.self)
          .map((m) => ({ name: m.name, pubkey: m.pubkey, sshUser: m.sshUser, sshPort: m.sshPort ?? 22 })));
      }

      case T.TUNNEL_OPEN:
        if (msg.copy !== undefined) {
          this.copyReceiver?.handle(link, msg, msg.caller);
          return;
        }
        return this.#openTunnel(link, msg);

      case T.TUNNEL_ACK:
        if (this.copyReceiver?.handle(link, msg, msg.caller)) return;
        this.#tunnels.get(this.#key(link, msg.sid))?.sender?.ack(msg.bytes);
        return;
      case T.TUNNEL_DATA: {
        if (this.copyReceiver?.handle(link, msg, msg.caller)) return;
        const tunnel = this.#tunnels.get(this.#key(link, msg.sid));
        if (tunnel?.receiver) tunnel.receiver.write(msg.data);
        else tunnel?.sock.write(Buffer.from(msg.data, 'base64'));
        return;
      }

      case T.TUNNEL_CLOSE: {
        if (this.copyReceiver?.handle(link, msg, msg.caller)) return;
        const key = this.#key(link, msg.sid);
        const tunnel = this.#tunnels.get(key);
        this.#tunnels.delete(key);
        tunnel?.release?.();
        tunnel?.sender?.stop();
        tunnel?.receiver?.stop();
        tunnel?.sock.destroy();
        return;
      }

      case T.PING:
        return link.send(T.PONG);

      case T.PONG:
        return link.onPong();
    }
  }

  /** A share as a member sees it: no hash, and the address it answers on. */
  #shareView = (share) => {
    const host = publicHosts(loadNetwork() ?? this.net)[0];
    return { ...publicShare(share), url: host ? `https://${share.name}.${host}` : null };
  };

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
      this.schedules?.share()?.port,
      // Ports shared on purpose with `helm share`, and only those.
      ...listShares().map((share) => share.port),
      ...(Array.isArray(extra) ? extra.map(Number) : []),
    ].filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  }

  #directTunnel(link, frame, caller) {
    if (frame?.t === T.TUNNEL_OPEN && frame.copy === undefined) {
      link.send(T.TUNNEL_CLOSE, { sid: frame.sid, reason: 'direct tunnels carry signed copy requests only' });
      return;
    }
    this.copyReceiver?.handle(link, frame, caller);
  }

  /**
   * Terminate a tunnel by connecting to a port on this machine's loopback
   * interface. This is how ssh reaches a box behind NAT: the daemon already
   * holds the outbound connection, so nothing has to accept an inbound one.
   */
  #openTunnel(link, { sid, port, flow }) {
    const wanted = Number(port) || 22;
    if (!this.#allowedTunnelPorts().includes(wanted)) {
      return link.send(T.TUNNEL_CLOSE, { sid, reason: 'port not allowed' });
    }
    const key = this.#key(link, sid);
    const sock = tcpConnect({ host: '127.0.0.1', port: wanted });
    const tunnel = { sock, link, release: beginTransferActivity() };
    this.#tunnels.set(key, tunnel);
    const end = reason => {
      tunnel.release?.();
      tunnel.sender?.stop();
      tunnel.receiver?.stop();
      if (!this.#tunnels.delete(key)) return;
      link.send(T.TUNNEL_CLOSE, { sid, reason });
      sock.destroy();
    };
    sock.on('connect', () => {
      const negotiated = flow === 1;
      link.send(T.TUNNEL_READY, { sid, ...(negotiated ? { flow: 1 } : {}) });
      if (negotiated) {
        tunnel.receiver = new TunnelReceiver(sock,
          bytes => link.send(T.TUNNEL_ACK, { sid, bytes }), err => end(err.message));
        tunnel.sender = new TunnelSender(sock,
          chunk => link.send(T.TUNNEL_DATA, { sid, data: chunk.toString('base64') }), err => end(err.message),
          { canSend: () => link.tunnelWritable !== false });
      } else {
        sock.on('data', chunk => link.send(T.TUNNEL_DATA, { sid, data: chunk.toString('base64') }));
      }
    });
    sock.on('error', err => end(err.message));
    sock.on('close', () => {
      if (tunnel.sender && this.#tunnels.has(key)) tunnel.sender.finish(() => end('closed'));
      else end('closed');
    });
  }

  // --------------------------------------------------------------- dispatch

  async openNetworkBrain(p) {
    let session = this.sessions.brainSession();
    const created = !session;
    let recovered = '';
    let renewed = false;
    const renew = async error => {
      if (renewed || !/thread not found:|no conversation found with session id/i.test(error.message)) throw error;
      recovered = readThread(this.sessions.events.tail(session.id, 200), { limit: 60 }).join('\n');
      await this.sessions.resetBrainProvider(session.id);
      await this.sessions.connect(session.id);
      renewed = true;
    };
    if (!session) {
      if (!p.profileId) throw new Error('brain.open needs a profileId the first time');
      const cwd = join(HELM_DIR, 'brain');
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      session = await this.sessions.start({
        cwd, profileId: p.profileId, model: p.model, mode: p.mode,
        title: 'Helm brain', brain: true,
      });
    } else {
      try { await this.sessions.connect(session.id); }
      catch (error) {
        // Authentication, permissions and network failures are never a reason
        // to replace a conversation. Only the provider's explicit missing-id
        // response allows renewal; Helm's session id and event log stay put.
        await renew(error);
      }
      if (p.model && p.model !== session.model) await this.sessions.setModel(session.id, p.model);
      if (p.mode && p.mode !== session.mode) await this.sessions.setMode(session.id, p.mode);
    }
    if (session.brainVersion !== 2) {
      // Existing VM conversations learn the new role without losing history.
      const knowledge = join(HELM_DIR, 'brain', 'KNOWLEDGE.md');
      mkdirSync(join(HELM_DIR, 'brain'), { recursive: true, mode: 0o700 });
      if (!existsSync(knowledge)) writeFileSync(knowledge,
        '# Helm brain knowledge\n\nKeep owner-confirmed machine and project locations, preferences, and task destinations here.\nThe last-observed network map is in ../snapshot.json; verify paths before using them.\n', { mode: 0o600 });
      const snap = await this.refreshSnapshot();
      const prompt = () => brief(this.name, [render(snap, { roster: this.rosterState(snap), limit: 2 }),
        recovered ? `Previous conversation retained by Helm (its provider thread was missing):\n${recovered}` : ''].filter(Boolean).join('\n\n'));
      try { await this.sessions.input(session.id, prompt(), { raw: true }); }
      catch (error) {
        // An adopted Codex server can only discover a missing idle thread
        // when turn/start tries to address it, after connect already passed.
        await renew(error);
        await this.sessions.input(session.id, prompt(), { raw: true });
      }
      this.sessions.setBrainVersion(session.id, 2);
    }
    return { session: wire(this.sessions.get(session.id)), created, envId: this.id };
  }

  async dispatch(method, p, caller) {
    if (method.startsWith('browser.')) return this.browsers.dispatch(method, p);
    switch (method) {
      case M.EXEC_START:
        if (p.sessionId && ['plan', 'readonly', 'read'].includes(this.sessions.get(p.sessionId).mode)) {
          throw new Error('a read-only session cannot start managed commands');
        }
        return this.executions.start(p, caller ?? this.id);
      case M.EXEC_READ: return this.executions.read(p, caller ?? this.id);
      case M.EXEC_CANCEL: return this.executions.cancel(p, caller ?? this.id);
      case M.ENV_INFO:
        return { ...(await this.describe()), name: this.name };

      case M.GIT_STATUS: return gitq.status(p.cwd);
      case M.GIT_GRAPH: return gitq.graph(p.cwd, await this.sessions.list());
      case M.GIT_DIFF: return gitq.diff(p.cwd, p.path);
      case M.GIT_FILES: return gitq.files(p.cwd);
      case M.GIT_FILE: return gitq.file(p.cwd, p.path);
      case M.GIT_COMMIT: return gitq.commit(p.cwd, p.hash, p.path);
      case M.GIT_WORKTREE: return gitq.addWorktree(p.cwd, p.name);
      case M.GIT_PRS: return this.github.pullRequests(p.cwd, p);
      case M.GIT_PR_DETAIL: return this.github.pullRequest(p.cwd, p.number);
      case M.GIT_PR_ACTION: return this.github.prAction(p.cwd, p);
      case M.GIT_PUBLISH: return this.github.publish(p.cwd, p);
      case M.GIT_PR: return { pr: (await this.github.get(p.cwd)).pr || null };
      case M.GIT_MONITOR: return { ...(await this.github.get(p.cwd, { force: p.force === true })), watching: this.github.watching(p.sessionId), agentWatch: this.github.watchState(p.sessionId) };
      case M.GIT_JOBS: return this.github.jobs(p.cwd, p.runId);
      case M.GIT_WATCH: return this.github.watch(p.sessionId, p.on === true, p);
      case M.GIT_ACCOUNTS: return this.github.accounts(p.cwd);
      case M.GIT_ACCOUNT: return this.github.selectAccount(p.cwd, p.login);
      case M.GITHUB_REPOS: return this.githubRepos.repos({ login: typeof p.login === 'string' ? p.login : undefined, refresh: p.refresh === true });
      case M.GITHUB_CHECK: return this.githubRepos.check({ repo: p.repo, target: p.target });
      case M.GITHUB_FIND: return this.githubRepos.find({ login: typeof p.login === 'string' ? p.login : undefined, query: p.query });
      case M.SESSION_CLONE_RETRY: return this.sessions.retryClone(p.id);
      case M.GITHUB_CLONE: return this.githubRepos.clone({ repo: p.repo, parent: p.parent, login: typeof p.login === 'string' ? p.login : undefined, job: typeof p.job === 'string' ? p.job : undefined });

      // The coding tools on this machine. Updating answers at once and runs
      // in the background; the app asks for the versions again to watch it.
      case M.CLI_VERSIONS: return this.cliUpdates.versions({ refresh: p.refresh === true });
      case M.CLI_UPDATE: return this.cliUpdates.begin({ engine: typeof p.engine === 'string' ? p.engine : undefined });
      case M.CLI_AUTO_UPDATE: return { auto: saveCliAutoUpdate(p.on === true) };

      case M.ENV_BUNDLE: return makeBundle({ have: Array.isArray(p.have) ? p.have : [] });

      // GitHub's version, only when the owner asks; `replace` keeps their
      // own changes on a backup branch and then uses GitHub's.
      case M.ENV_UPDATE: {
        const r = await selfUpdate(undefined, { replace: !!p.replace });
        // The restart is on a five second timer, so this reply gets out first.
        return { ...r, version: r.updated ? null : this.version };
      }

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
      // The owner's preferences: the same list on every machine, so any one
      // answers; the keeper's run state lives on the keeper's machine.
      case M.OWNER_GET:
        return { record: loadOwner(), keeper: this.keeper.status() };
      case M.OWNER_SET: {
        const { record, changed } = editOwner({
          lines: p.lines === undefined ? undefined : Array.isArray(p.lines) ? p.lines.map(String) : String(p.lines),
          keeper: typeof p.keeper === 'boolean' ? p.keeper : undefined,
        }, {
          by: 'owner', where: this.name,
          why: p.lines === undefined ? `Keeper turned ${p.keeper ? 'on' : 'off'}` : 'Edited in the app',
        });
        if (changed) this.broadcastFrame(T.OWNER, { record });
        return { record, keeper: this.keeper.status() };
      }
      case M.OWNER_KEEP:
        return { record: loadOwner(), keeper: this.keeper.runNow() };
      case M.OWNER_WORDS:
        return ownerWords(await this.sessions.list(), {
          dir: EVENTS_DIR, since: Number(p.since) || 0, read: p.read && typeof p.read === 'object' ? p.read : {},
        });

      case M.MACHINE_SET_KIND:
        return this.setMachineKind(String(p.kind ?? '').toLowerCase(), { address: p.address });

      // Public links. `share.list` is what a hub asks when a link is opened;
      // it carries the password hash so the hub can check a visitor without
      // a round trip here. Apps get `publicShare`, without it.
      case M.SHARE_LIST: {
        const shares = [...listShares(), ...(this.schedules?.share() ? [this.schedules.share()] : [])];
        // Only a hub's own call (no member behind it) gets the hashes. A
        // private link goes only to a hub that says it can keep one private:
        // an older hub would not know the flag and serve it to anyone.
        if (p.forHub && !caller) return { shares: p.members ? shares : shares.filter((s) => !s.private) };
        // `features` tells the app and CLI this machine can make private links.
        return { shares: shares.map(this.#shareView), features: ['private'] };
      }
      case M.SHARE_ADD: {
        const taken = (p.replace ? [] : listShares()).find((x) => x.name === String(p.name ?? '').toLowerCase());
        if (taken) throw new Error(`"${taken.name}" is already shared from here (port ${taken.port}); use replace`);
        return { share: this.#shareView(addShare(p)) };
      }
      case M.SHARE_REMOVE:
        return { removed: removeShare(p.name) };

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
      case M.FS_INDEX:  return fsApi.folderIndex({ since: typeof p.since === 'string' ? p.since : null, refresh: p.refresh === true });

      case M.PROJECT_LIST: {
        const byPath = new Map(listProjects().map((x) => [x.path, x]));
        // A worktree is a checkout of a repo that already has a project, so
        // its threads belong under that one rather than under a project each.
        const worktrees = new Map();
        for (const s of await this.sessions.list()) {
          // A quick chat's scratch folder is not a project.
          if (s.engine === 'shell' || !s.cwd || s.quick) continue;
          try {
            const base = gitq.worktreeBase(s.cwd);
            const found = await fsApi.project(base ?? s.cwd);
            if (!byPath.has(found.path)) byPath.set(found.path, found);
            if (base) {
              const set = worktrees.get(found.path) ?? new Set();
              set.add(collapse(expand(s.cwd)));
              worktrees.set(found.path, set);
            }
          } catch {}
        }
        return {
          projects: [...byPath.values()]
            .map((x) => (worktrees.has(x.path) ? { ...x, worktrees: [...worktrees.get(x.path)] } : x))
            .sort((a, b) => a.title.localeCompare(b.title)),
        };
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

      case M.INTEGRATIONS_LIST: return listIntegrations(p);
      case M.INTEGRATIONS_MCP_ADD: return addMcp(p);
      case M.INTEGRATIONS_MCP_REMOVE: return removeMcp(p);
      case M.INTEGRATIONS_MCP_CONNECT: return connectMcp(p, this.sessions);
      case M.INTEGRATIONS_SKILLS_ADD: return addSkills(p);
      case M.INTEGRATIONS_SKILLS_REMOVE: return removeSkill(p);
      case M.INTEGRATIONS_PLUGINS_ADD: return changePlugin(p);
      case M.INTEGRATIONS_PLUGINS_REMOVE: return changePlugin(p, true);

      case M.PROFILE_LIST: {
        // Asked for the list means somebody is looking at what this machine
        // can run - the one moment a stale answer is a wrong one. Discovery
        // is cheap enough to redo every few minutes; between those the saved
        // file answers.
        const found = p.refresh
          ? (await refreshProfiles()).profiles
          : await currentProfiles();
        // Offer only accounts that can sign in: a profile whose CLI says it is
        // signed out is left out until it isn't (auth.js).
        const profiles = await usableProfiles(found, { refresh: !!p.refresh });
        // Each profile carries its account key and model prefs, so the app
        // groups aliases and renders the picker filter with no extra call.
        const cfg = loadSettings();
        return {
          profiles: profiles.map((x) => ({
            ...x, account: accountKey(x), prefs: modelPrefs(x, cfg), defaults: startPrefs(x, cfg),
          })),
          picker: pickerPrefs(cfg),
        };
      }

      case M.AGENT_LIST: {
        const profiles = p.refresh ? (await refreshProfiles()).profiles : await currentProfiles();
        const statuses = await authStatuses(profiles, { refresh: !!p.refresh });
        this.cliAgents = markShown(await agentCatalog(profiles, statuses, { models: p.models !== false, credentials: true }),
          profiles, pickerPrefs().hidden);
        return { agents: this.cliAgents };
      }

      case M.PROFILE_DEFAULTS: {
        const profile = (await getProfiles()).find((x) => x.id === p.profileId);
        if (!profile) throw new Error(`unknown profile: ${p.profileId}`);
        if (p.scope === 'subagent') return { ok: true, subagentDefaults: saveSubagentPrefs(profile, p) };
        return { ok: true, defaults: saveStartPrefs(profile, p) };
      }

      case M.MODEL_LIST: {
        const profile = (await getProfiles()).find((x) => x.id === p.profileId);
        if (p.id) await this.sessions.refreshNativeSettings?.(p.id);
        const native = p.id ? this.sessions.get(p.id) : null;
        if (native?.nativeCli && !(native.nativeChat && native.engine === 'claude')) {
          let nativeEnv = null;
          if (native.nativePid) try { nativeEnv = readProcess(native.nativePid).env; } catch { /* exited */ }
          const account = nativeAccount(native, await getProfiles(), { env: nativeEnv });
          const engine = ENGINES[native.engine];
          const home = native.nativeHome ?? engine?.defaultHome;
          const hasModels = nativeModelChoices(native.engine);
          const catalog = hasModels ? await listModels(native.engine, home, nativeEnv ?? {}) : { models: [] };
          const prefs = account ? modelPrefs(account) : null;
          const filtered = applyModelPrefs(catalog, prefs, { all: !!p.all });
          const hasEffort = nativeEffortChoices(native.engine) && !!(catalog.efforts?.length || Object.keys(catalog.effortsByModel ?? {}).length);
          return { ...filtered, default: null, effort: null, defaultMode: null, modes: native.permissionControl === 'bash-guard' ? BASH_GUARD_MODES : [], speeds: [], speedByModel: {},
            ...(!hasEffort ? { efforts: [], effortsByModel: {} } : {}),
            // No "settings" chip: it only jumped to the CLI's own menu, which
            // the terminal button already shows.
            nativeControls: nativeControls(native.engine).filter(kind => kind !== 'settings' &&
              !(kind === 'model' && (filtered.models?.length || filtered.more?.length)) && !(kind === 'effort' && hasEffort)),
            favs: pickerPrefs().favs[native.engine] ?? [], effortFavs: pickerPrefs().favs[`${native.engine}-effort`] ?? [],
            ...(account ? { prefs, defaults: startPrefs(account), account: accountKey(account), profileId: account.id } : { defaults: {} }) };
        }
        if (native?.nativeChat && native.engine === 'claude') {
          const home = native.nativeHome ?? profile?.env?.CLAUDE_CONFIG_DIR ?? ENGINES.claude.defaultHome;
          const catalog = await listModels('claude', home);
          // The account this terminal runs as, for its favorites and the
          // defaults new chats start with - the same tray a Helm chat has.
          let nativeEnv = null;
          if (native.nativePid) try { nativeEnv = readProcess(native.nativePid).env; } catch { /* exited or unreadable */ }
          const account = nativeClaudeAccount({ ...native, nativeHome: home }, await getProfiles(), { env: nativeEnv });
          if (account) followNewModels(account, catalog);
          const prefs = account ? modelPrefs(account) : null;
          const filtered = applyModelPrefs(catalog, prefs, { all: !!p.all });
          // Account defaults are not evidence of the terminal's live settings:
          // the chips show what Claude reports, and `default`/`effort` stay
          // empty so they never stand in for it.
          return { ...filtered, default: null, effort: null, modes: modesFor('claude'), defaultMode: null,
            favs: pickerPrefs().favs.claude ?? [], effortFavs: pickerPrefs().favs['claude-effort'] ?? [],
            ...(account ? { prefs, defaults: startPrefs(account), account: accountKey(account), profileId: account.id, ...modelWatch(account) } : { defaults: {} }) };
        }
        if (!profile) throw new Error(`unknown profile: ${p.profileId}`);
        const engine = ENGINES[profile.engine];
        const spec = materialize(profile);
        const catalog = await listModels(
          profile.engine,
          spec.env?.[engine?.homeEnv] ?? engine?.defaultHome,
          spec.env,
          profile.wraps ? { cmd: spec.cmd, args: spec.args } : null,
        );
        // A live agent reports the pickers it actually has - real display
        // names, the levels this session offers - which beats what the CLI
        // can print. The printed list is the fallback for a cold session.
        const live = p.id ? this.sessions.catalog(p.id) : null;
        // What the static list claims beyond the live picker is demoted, not
        // deleted: the printed catalogue names rows `set_config_option` then
        // refuses (devin's `models list` shows ~600 uids; the session accepts
        // ~100 plus fuzzy spellings), so they are no longer offered as
        // first-class choices but stay reachable through `more`. `all` keeps
        // the union - the settings editor manages approvals against
        // everything the CLI knows.
        const { models, extra } = mergeLiveModelCatalog(catalog, live, { all: !!p.all });
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
        // A model the catalogue just gained joins this account (settings.js).
        followNewModels(profile, catalog);
        const prefs = modelPrefs(profile);
        // `models` is the cached catalogue object - copy before folding in
        // prefs/extras so the cache never carries one session's answer.
        const filtered = applyModelPrefs({ ...models }, prefs, { all: !!p.all });
        if (extra.length) filtered.more = [...(filtered.more ?? []), ...extra];
        // A stored default the running agent refuses must not read as the
        // session's model.
        if (live?.models?.length && filtered.default && !live.models.includes(filtered.default)) {
          filtered.default = live.current ?? filtered.default;
        }
        // The permission modes this engine offers, so the app never has to know the flags.
        // Starred models and the start defaults ride along, so the in-chat
        // picker can show and change both without a second round trip.
        return {
          ...filtered, prefs, modes: engine?.driver ? live?.modes ?? modesFor(profile.engine) : [], defaultMode: defaultMode(profile.engine),
          favs: pickerPrefs().favs[profile.engine] ?? [], defaults: startPrefs(profile), subagentDefaults: subagentPrefs(profile), account: accountKey(profile),
          ...modelWatch(profile),
          effortFavs: pickerPrefs().favs[`${profile.engine}-effort`] ?? [],
        };
      }

      case M.CONTEXT_LIMIT: return contextLimit(await getProfiles(), p);

      case M.PICKER_PREFS: return { ok: true, picker: savePickerPrefs(p) };

      case M.MODEL_PREFS: {
        const profile = (await getProfiles()).find((x) => x.id === p.profileId);
        if (!profile) throw new Error(`unknown profile: ${p.profileId}`);
        return { ok: true, prefs: saveModelPrefs(profile, { default: p.default, approved: p.approved, auto: p.auto, keepApproved: p.keepApproved === true }), ...modelWatch(profile) };
      }

      case M.MODEL_NEWS: {
        const profile = (await getProfiles()).find((x) => x.id === p.profileId);
        if (!profile) throw new Error(`unknown profile: ${p.profileId}`);
        dismissModelNews(profile);
        return { ok: true };
      }

      case M.SESSION_LIST:    return { sessions: await this.sessions.list({ parentId: p.parentId, includeDelegations: p.includeDelegations === true, includeDetected: p.includeDetected === true }) };
      case 'session.agent-address': return { address: this.agentMessages.address(p.id, p.callerThreadId) };
      case 'session.agent-messages': return this.agentMessages.list(p.id, p);
      case 'session.agent-send':
        await this.sessionRecovery;
        return this.agentMessages.send(p);
      case 'session.agent-receive':
        await this.sessionRecovery;
        if (!(loadNetwork() ?? this.net).machines?.[caller]) throw new Error('Agent messages must come from a paired machine.');
        return this.agentMessages.receive(p.message, caller);
      // Only the keeper starts a hidden helper; one asked for from outside is
      // always a card in its chat, where the owner can see it.
      case M.SESSION_DELEGATE: return this.sessions.delegate({ ...p, hidden: false });
      case M.SESSION_DELEGATION_RESULT: {
        await this.sessionRecovery;
        const result = this.sessions.delegationResult(p.id, p);
        // Polls that are not returned to the CLI must not consume replies.
        if (result.complete || result.status === 'blocked') {
          const messages = await this.agentMessages.collectResult(p);
          if (messages.length) result.messages = messages;
        }
        return result;
      }
      case M.SESSION_DELEGATION_MESSAGE: return this.sessions.messageDelegation(p.parentId, p.id, p.data);
      case M.SESSION_NATIVE_AGENT: return this.sessions.nativeAgent(p.id, p.agentId, { full: p.full === true });
      case M.SESSION_NATIVE_MESSAGE: return this.sessions.messageNative(p.id, p.agentId, p.data);
      case M.SESSION_START: {
        if (p.brain) throw new Error('Use brain.open to start the single Helm brain on the VM.');
        const { originHandoffId: _originHandoffId, delegation: _delegation, ...start } = p;
        return { session: await this.sessions.start({ ...start, quick: start.quick === true }) };
      }
      case M.SESSION_LINK:    return this.sessions.linkChild(p.id, p.child);
      // Attaching starts a push stream of the screen (E.SESSION_DATA); the
      // reply carries the current screen so the viewer has something at once.
      case M.SESSION_ATTACH:  return this.sessions.attach(p.id, {
        lines: p.lines ?? 400, ansi: p.ansi ?? true, cols: p.cols, rows: p.rows,
        renew: p.renew === true, watcher: p.watcher,
      });
      case M.SESSION_CONNECT: return { session: await this.sessions.connect(p.id) };
      case M.SESSION_DETACH:  return this.sessions.detach(p.id, p.watcher);
      case M.SESSION_RESIZE:  return this.sessions.resize(p.id, p.cols, p.rows);
      case M.SESSION_DELIVER:
        await this.sessionRecovery;
        this.inputDelivery ??= new InputDelivery(this.sessions);
        return this.inputDelivery.deliver(p, caller);
      case M.SESSION_INPUT:   return this.sessions.input(p.id, p.data, { raw: p.raw, attachments: p.attachments, delivery: p.delivery, references: p.references });
      case M.SESSION_KEYS:    await this.sessions.keys(p.id, p.keys); return { ok: true };
      case M.SESSION_MESSAGES: return this.sessions.messages(p.id, { limit: p.limit });
      case M.SESSION_KILL:    return this.sessions.kill(p.id);
      case M.SESSION_DISCARD_EMPTY: return this.sessions.discardEmpty(p.id);
      case M.SESSION_TITLE:   return this.sessions.rename(p.id, p.title);
      case M.SESSION_ARCHIVE: return this.sessions.archive(p.id, p.archived !== false);
      case M.SESSION_DISMISS_CHILD_FAILURES: return this.sessions.dismissChildFailures(p.id);
      case M.SESSION_SEEN:    return this.sessions.markSeen(p.id);
      case M.SESSION_FORK: return { session: await this.sessions.fork(p.id, p.turnId) };
      case M.SESSION_REWIND: return this.sessions.rewind(p.id, p.turnId, { restoreFiles: p.restoreFiles });
      case M.SESSION_REWIND_CHECK: return this.sessions.rewindCheck(p.id, p.turnId);

      // Headless agent sessions.
      case M.SESSION_RENDER: return this.sessions.renderVisual(p.id, p);
      case M.SESSION_VISUAL: return this.sessions.readVisual(p.id, p.ref);
      case M.SESSION_EVENTS:
        await this.sessions.prepareHistory(p.id);
        return this.sessions.history(p.id, {
          since: p.since ?? 0, limit: p.limit ?? 500, tail: p.tail ?? 0, before: p.before ?? 0,
        });
      // A view owns its lease. Refreshing or closing one tab cannot cancel
      // another device's stream, even when both use the same login.
      case M.SESSION_WATCH:
      case M.SESSION_UNWATCH: {
        if (p.watchId != null && (typeof p.watchId !== 'string' || !p.watchId || p.watchId.length > 128)) {
          throw new Error('invalid session watch ID');
        }
        const watcher = JSON.stringify([caller ?? 'legacy', p.watchId ?? 'legacy']);
        return method === M.SESSION_WATCH ? this.sessions.watch(p.id, watcher) : this.sessions.unwatch(p.id, watcher);
      }
      case M.SESSION_ANSWER:  return this.sessions.answer(p.id, p.requestId, p.decision ?? {});
      case M.SESSION_INTERRUPT: return this.sessions.interrupt(p.id);
      case M.SESSION_DEQUEUE:  return this.sessions.dequeue(p.id, p.turnId);
      case M.SESSION_SEND_NOW: return this.sessions.sendNow(p.id, p.turnId);
      case M.SESSION_QUEUE_EDIT: return this.sessions.editQueued(p.id, p.turnId, p.text, p.attachments);
      case M.SESSION_QUEUE_REORDER: return this.sessions.reorderQueue(p.id, p.turnIds);
      case M.SESSION_RECOVER: return this.sessions.recover(p.id);
      case M.SESSION_AUTO_RESUME: return this.sessions.setAutoResumeLimited(p.id, p.on);
      case M.SCHEDULE_LIST:
      case M.SCHEDULE_SAVE:
      case M.SCHEDULE_DELETE:
      case M.SCHEDULE_RUN:
        if (!this.schedules) throw new Error('Schedules could not load on this machine.');
        if (method === M.SCHEDULE_LIST) return this.schedules.list(p.sessionId);
        if (method === M.SCHEDULE_SAVE) return this.schedules.save(p);
        if (method === M.SCHEDULE_DELETE) return this.schedules.remove(p.id);
        return this.schedules.run(p.id);
      case M.SESSION_NOTIFY:   return this.sessions.setNotifyDone(p.id, p.on !== false);
      case M.SESSION_CONTROL: return this.sessions.control(p.id, p.kind);
      case M.SESSION_MODE:    return this.sessions.setMode(p.id, p.mode);
      case M.SESSION_MODEL:   return this.sessions.setModel(p.id, p.model, { pick: p.pick === true, ask: p.ask === true });
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
          if (this.sessions.isDelegatedConversation(x.engine, x.id) || scratchFolder(x.cwd)) continue;
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
            home: s2.nativeHome ?? profile?.env?.[engine?.homeEnv] ?? engine?.defaultHome,
            available,
            native: !!s2.nativeCli || !!s2.nativeChat,
          }),
        };
      }

      // ----------------------------------------------------------- brain
      case M.BRAIN_DIGEST:    return { name: this.name, projects: listProjects(), ...(await this.sessions.digest()) };

      case M.BRAIN_SNAPSHOT: {
        // `cached` serves the picture this machine already had - the app uses
        // it to draw an offline machine's last-known threads without waiting
        // for a refresh that only proves the machine is still down.
        const snap = p.cached ? readSnapshot() : await this.refreshSnapshot();
        return { text: render(snap, { roster: this.rosterState(snap) }), snapshot: snap };
      }

      case M.BRAIN_OPEN: {
        const net = loadNetwork() ?? this.net;
        const home = brainHost(net.machines);
        if (!home) throw new Error('The Helm brain needs a VM in the network. Designate one with `helm redesignate <machine> vm`.');
        if (home.id !== this.id) {
          const result = await hubRpc(net, home.id, M.BRAIN_OPEN, p, { timeout: 60_000 });
          return { ...result, envId: home.id };
        }
        // Two devices can tap Start at once. Both join one creation.
        if (this.#brainOpening) await this.#brainOpening;
        const opening = this.openNetworkBrain(p);
        this.#brainOpening = opening;
        try { return await opening; }
        finally { if (this.#brainOpening === opening) this.#brainOpening = null; }
      }

      // Picking up a conversation the CLI recorded on its own. The protocol
      // has had a name for this since the beginning and nothing behind it.
      case M.SESSION_RESUME:
        return { session: wire(await this.sessions.resumeExternal(p)) };

      case M.SESSION_TAKEOVER:
        return p.cancel ? this.sessions.cancelTakeOver(p.id) : this.sessions.takeOver(p.id);

      // The device records; the machine holding the key does the rest, so no
      // phone ever has to be trusted with one.
      case M.VOICE_TRANSCRIBE: return transcribe({ audio: p.audio, mime: p.mime, prompt: p.prompt });
      case M.VOICE_DIRECT: return directVoice();
      case M.VOICE_KEY: return setGroqKey(p.key);

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
      case M.USAGE_LIMITS:
        return this.sessions.accountLimits(await currentProfiles());

      case M.USAGE_REPORT: {
        const rollup = await this.#usageRollup(!!p.rebuild);
        this.broadcastFrame(T.USAGE_SYNC, rollup);
        return foldBuckets(rollup.buckets, {
          model: typeof p.model === 'string' ? p.model : null,
          since: p.since ?? null,
          until: p.until ?? null,
          tz: Number(p.tz) || 0,
          by: Array.isArray(p.by) && p.by.length ? p.by : ['engine', 'model'],
          accounts: rollup.accounts,
          scan: rollup.scan,
        });
      }

      // The rollup itself, un-folded. What a hub stores for us; the app only
      // ever asks for a folded report.
      case M.USAGE_BUCKETS:
        return this.#usageRollup(!!p.rebuild);

      case M.CODE_KEY: {
        // Proving the code key is for machines: a handoff's whole chain of
        // custody is machine-to-machine, and a device holds no key anyone
        // would encrypt a workspace to. Missing or revoked callers get the
        // same refusal as devices.
        const net = loadNetwork() ?? this.net;
        if (!caller || !net.machines?.[caller] || net.revoked?.[caller]) {
          throw new Error('code.key is answered for machines of this network only');
        }
        return answerCodeKeyProof(p);
      }
      case M.HANDOFF_ACCEPT:
        return this.handoffs.accept(p, caller);
      case M.SEND_PLAN: return this.sendEngine.plan(p, caller);
      case M.SEND_START: return this.sendEngine.start(p, caller);
      case M.SEND_STATUS: return this.sendEngine.status(p, caller);
      case M.SEND_LIST: return this.sendEngine.list(p, caller);
      case M.SEND_CANCEL: return this.sendEngine.cancel(p, caller);
      case M.SEND_RETRY: return this.sendEngine.retry(p, caller);
      case M.SEND_RECEIPT: {
        const net = loadNetwork() ?? this.net;
        if (!net.machines?.[caller] || net.revoked?.[caller]) throw new Error('send receipts are for current source machines only');
        return this.copyReceiver.sendReceiver.status(p.jobId, caller);
      }
      case M.TASK_SEND:
        return this.taskTransfers.send(p, caller);
      case M.TASK_COLLECT:
        return this.handoffs.collect(p.handoffId, caller);
      case M.TASK_RETURNED:
        return this.handoffs.returned(p, caller);
      case M.TASK_STATUS:
        return this.taskTransfers.status(p, caller);
      case M.TASK_RETRY_RETURN:
        return this.taskTransfers.retryReturn(p, caller);
      case M.HANDOFF_STATUS:
        return this.handoffs.status(p.handoffId, caller);
      case M.TRANSFER_RECEIVE:
        return this.transfers.receive(p, caller);
      case M.TRANSFER_PREVIEW:
        return this.transfers.preview(p, caller);
      case M.TRANSFER_INVITE:
        return this.transfers.invite(p, caller);
      case M.TRANSFER_SEND:
        return this.transfers.send(p, caller);
      case M.TRANSFER_VERIFY:
        return this.transfers.verify(p, caller);
      case M.TRANSFER_ACCEPT:
        return this.transfers.accept(p, caller);

      case M.PING:            return { t: Date.now() };
      case M.NET_ROUTES:      return this.routes();

      case M.SSH_INFO:        return sshInfo();

      default:
        throw Object.assign(new Error(`unknown method: ${method}`), {
          code: 'unknown_method',
        });
    }
  }
}
