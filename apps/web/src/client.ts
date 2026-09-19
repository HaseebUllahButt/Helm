/**
 * Talking to machines.
 *
 * Every call goes out as an RPC frame and comes back matched by id. Two
 * things underneath are deliberately hidden from the screens above.
 *
 * Which hub we are attached to: every machine in the network runs one and any
 * of them can authenticate us, so we race all the addresses we know and use
 * whichever answers first. A device therefore keeps working when the machine
 * it was originally added from is switched off.
 *
 * Which route a message takes: a direct peer connection is preferred when it
 * is up, and the hub carries the call when it is not.
 */

export type Status = 'idle' | 'working' | 'blocked' | 'done' | 'shell' | 'exited' | 'unknown';

export interface Environment {
  id: string;
  name: string;
  online: boolean;
  lastSeen: number | null;
  info: {
    host?: string;
    platform?: string;
    arch?: string;
    /** 'pty' when terminals are helm's own; 'panes' is the slow fallback. */
    terminals?: 'pty' | 'panes';
    /** This machine holds a Groq key, so it can transcribe what you say. */
    voice?: boolean;
    runtime?: { version: string };
  };
}

/** Per-account model picker settings, stored on the machine. */
export interface ModelPrefs {
  default: string | null;
  approved: string[];
}

export interface Profile {
  id: string;
  label: string;
  engine: string;
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
  envFrom?: string[];
  source: string;
  /** Account key every alias of the same login shares, from the daemon. */
  account?: string;
  prefs?: ModelPrefs | null;
}

export interface Session {
  id: string;
  title: string;
  cwd: string;
  engine: string;
  profileId: string;
  status: Status;
  alive?: boolean;
  updatedAt?: number;
  /** Set on a headless agent session: which driver runs it. */
  driver?: string;
  /** Set on a terminal helm owns: a pty, not a herdr pane. */
  pty?: boolean;
  model?: string | null;
  /** What the CLI said it actually started with, when nothing was picked. */
  engineModel?: string | null;
  engineEffort?: string | null;
  mode?: string | null;
  speed?: string | null;
  effort?: string | null;
  /** Prompts waiting on a person, for the list view. */
  pending?: number;
  adopted?: boolean;
  /** Archived threads stay on the machine but are hidden from active groups. */
  archived?: boolean;
  /** The network's own agent: one per machine, opened from the sidebar. */
  brain?: boolean;
  /** What the whole thread has cost and how many turns it took, so far. */
  costUsd?: number;
  turns?: number;
  /** "Ping me when it finishes" is armed; clears itself when it rings. */
  notifyDone?: boolean;
  /** The id the CLI itself gave this session; matches inventory rows. */
  engineSessionId?: string | null;
  /** On a row read from a CLI's history: the account it was recorded under. */
  account?: string;
}

/** A thread a CLI recorded on its own, whether or not helm started it. */
export interface InventorySession {
  engine: string;
  account: string;
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
  model?: string;
  /** Filed away by the owner; the machine remembers, so every device agrees. */
  archived?: boolean;
}

/** A permission mode an engine offers, in words; the daemon knows the flags. */
export interface Mode { id: string; label: string; short?: string; hint?: string; danger?: boolean }
export interface ModelList {
  default: string | null;
  models: string[];
  /** What the account's approved list filtered out - reachable, not offered first. */
  more?: string[];
  prefs?: ModelPrefs | null;
  /** Slug -> the name the CLI shows a person ("GPT-6-Astra"). */
  labels?: Record<string, string>;
  effort?: string | null;
  efforts?: string[];
  /** Not every model offers every level; the picker narrows to the one in use. */
  effortsByModel?: Record<string, string[]>;
  /** codex's service tiers, e.g. ["fast"]. */
  speeds?: string[];
  speedByModel?: Record<string, string[]>;
  /** Whether this engine takes image input at all; per-model when known. */
  images?: boolean;
  imagesByModel?: Record<string, boolean>;
  modes?: Mode[];
}

/**
 * What one machine's agents have spent, as the daemon pre-aggregates it.
 *
 * Costs are what the tokens would bill at the published rate on the day they
 * were spent. On a subscription that is not what you paid - it is the
 * API-equivalent figure, and the screen says so.
 */
export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
  turns: number;
  costUsd: number;
  /** Some model in here has no published rate; its tokens count, its cost does not. */
  unpriced: boolean;
  /** What the cached reads would have cost as fresh input, less what they did. */
  cacheSavedUsd: number;
  /** Writing the cache is billed above the fresh rate; this is that toll. */
  cacheWritePremiumUsd: number;
}

export interface UsageGroup extends UsageTotals {
  engine?: string;
  account?: string;
  model?: string;
  provider?: string;
  project?: string;
}

export interface UsageDay extends UsageTotals { date: string }

export interface UsageReport {
  totals: UsageTotals;
  daily: UsageDay[];
  groups: UsageGroup[];
  accounts: { account: string; engine: string; profileId: string }[];
  scan: Record<string, number>;
  at: number;
}

/** The share of input tokens that came back out of the prompt cache. */
export const hitRate = (t: Pick<UsageTotals, 'input' | 'cacheRead'>) => {
  const denom = (t.input || 0) + (t.cacheRead || 0);
  return denom ? t.cacheRead / denom : 0;
};

/** What prompt caching actually saved, after the write premium. */
export const cacheSaved = (t: Pick<UsageTotals, 'cacheSavedUsd' | 'cacheWritePremiumUsd'>) =>
  (t.cacheSavedUsd || 0) - (t.cacheWritePremiumUsd || 0);

export interface DirEntry { name: string; path: string; isRepo: boolean; skip: boolean }

export interface Project { path: string; title: string }

export interface Tool { name: string; input: string }
export interface Message {
  role: 'user' | 'assistant';
  text: string;
  tools: Tool[];
  thinking?: boolean;
  at?: string | number;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };
type Listener = (env: string, kind: string, payload: any) => void;

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/** A direct connection to one environment, with the relay as the fallback. */
interface Peer {
  pc: RTCPeerConnection;
  channel: RTCDataChannel;
  ready: boolean;
  fragments: Map<string, { n: number; parts: string[]; got: number }>;
}

/**
 * Mirrors packages/connect/src/peer.js: libdatachannel and browsers cap a
 * single data-channel message (~256KB max, less in practice), while an old
 * chat's history reply can be megabytes. Frames over DC_CHUNK_AT bytes are
 * fragmented into `dc-chunk` pieces and reassembled here. The WebSocket relay
 * path has no such limit and is never fragmented.
 */
const DC_CHUNK_AT = 16_000;
const DC_CHUNK_TYPE = 'dc-chunk';

function sendDirect(channel: RTCDataChannel, frame: string): boolean {
  try {
    if (frame.length <= DC_CHUNK_AT) {
      channel.send(frame);
      return true;
    }
    const gid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const n = Math.ceil(frame.length / DC_CHUNK_AT);
    for (let i = 0; i < n; i++) {
      channel.send(JSON.stringify({
        t: DC_CHUNK_TYPE, gid, i, n,
        data: frame.slice(i * DC_CHUNK_AT, (i + 1) * DC_CHUNK_AT),
      }));
    }
    return true;
  } catch {
    return false;
  }
}

/** How long to wait for a hub to answer before writing it off for this attempt. */
/**
 * How long to wait before settling for the hubs that have answered.
 *
 * Short, because on a good network every hub answers in milliseconds and this
 * is the cold open of the whole app.
 */
const PROBE_MS = 2500;

/**
 * How long a hub is still allowed to answer.
 *
 * These are two different questions and treating them as one was a bug. The
 * owner's laptop sits behind a VPN exit node in another country, so its own
 * hub answers on loopback in 2ms while the VM's answers in 3-7 seconds. With
 * one 2.5s deadline the VM's hub never answered at all, the laptop's hub won
 * by default - and that hub cannot see the VM, because the VM dials out to it
 * and never the other way round. The app then said the VM was offline while
 * it was serving the phone perfectly well.
 *
 * "Slow" must not be allowed to read as "gone". So a far hub gets until here
 * to reply, and `connect` attaches to the best answer it has at PROBE_MS and
 * upgrades if something with more reach arrives afterwards.
 */
const PROBE_PATIENCE_MS = 9000;

/** How many addresses to keep for a network. Newest win. */
const MAX_ENDPOINTS = 12;

/**
 * Can this page even try that address? A page served over https is forbidden
 * by the browser from fetching plain-http addresses (mixed content), so
 * probing a LAN hub like `http://192.168.x.x:8787` from the VM-hosted PWA
 * fails every time. Skip those rather than spending a probe timeout on them.
 */
/** The origin this page was served from, if it was served from one. */
const here = (): string[] => (typeof location === 'undefined' || !location.origin ? [] : [location.origin]);

const reachableFromHere = (base: string) =>
  typeof location === 'undefined' ||
  location.protocol !== 'https:' ||
  !base.startsWith('http://');

/**
 * Choose a hub to attach to.
 *
 * Probing in parallel beats trying addresses in order: the list includes
 * machines that are asleep and LAN addresses for networks we are not on, and
 * those fail slowly.
 *
 * The winner is the hub that can see the most machines, not the one that
 * answers first. Hubs differ in reach - a laptop on a home network can dial
 * out to a VM, but the VM cannot dial back in, so the laptop's hub sees only
 * itself while the VM's sees both. Picking the nearest hub would quietly cost
 * you every machine it cannot reach. Latency is only the tie-break, and costs
 * little either way: the hub introduces peers and then the session data goes
 * directly between devices.
 */
export async function pickEndpoint(
  endpoints: string[], token: string
): Promise<string | null> {
  return (await probeEndpoints(endpoints, token)).best;
}

/**
 * Probe every address at once. Besides the winner, report whether the
 * machines that did answer all refused the token: that is not "offline", it
 * is "this device is no longer in the network" - after `helm remove`, or a
 * network rebuilt from scratch - and retrying forever is the wrong response.
 */
export async function probeEndpoints(
  endpoints: string[], token: string, timeout = PROBE_PATIENCE_MS
): Promise<ProbeResult> {
  const round = startProbes(endpoints, token, timeout);
  await round.settled;
  return round.result();
}

/** A hub that answered: where it is, how much of the network it can see. */
interface Reached { base: string; reach: number; elapsed: number }

interface ProbeResult {
  best: string | null;
  unauthorized: boolean;
  answered: Set<string>;
  reached: Reached[];
}

/** Most machines visible wins; nearest is only the tie-break. */
const byReach = (a: Reached, b: Reached) => b.reach - a.reach || a.elapsed - b.elapsed;

/**
 * Ask every hub at once, and report what has come back whenever asked.
 *
 * One request per endpoint, ever: the results accumulate as they arrive, so
 * "the best answer so far" and "the best answer there is" are two reads of
 * the same round rather than two rounds.
 */
function startProbes(endpoints: string[], token: string, timeout: number) {
  const statuses: number[] = [];
  // Answering at all is worth knowing separately from winning: a 401 is a
  // machine that is there and refusing us, which is not a dead address.
  // `learn()` uses this to tell a stale address from a sleeping one.
  const answered = new Set<string>();
  const up: Reached[] = [];

  const probes = endpoints.map(async (base) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    const started = performance.now();
    try {
      const res = await fetch(`${base}/api/network`, {
        signal: ctl.signal,
        headers: { authorization: `Bearer ${token}` },
      });
      statuses.push(res.status);
      answered.add(base);
      if (!res.ok) return;
      const body = await res.json();
      up.push({
        base,
        reach: (body.machines ?? []).filter((m: Environment) => m.online).length,
        elapsed: performance.now() - started,
      });
    } catch { /* unreachable, or too slow even for our patience */ }
    finally { clearTimeout(timer); }
  });

  return {
    settled: Promise.allSettled(probes),
    result(): ProbeResult {
      const ranked = up.slice().sort(byReach);
      return {
        best: ranked[0]?.base ?? null,
        // Every machine that answered said no: the token is dead, and saying
        // so beats "retrying" until the end of time.
        unauthorized: !ranked.length && statuses.length > 0 && statuses.every((s) => s === 401),
        answered,
        reached: ranked,
      };
    },
  };
}

/**
 * The best hub we can have quickly, and the best hub there is.
 *
 * `soon` resolves when every probe has settled, or at `settleAfter` if some
 * are still out - the app attaches to whatever has answered by then, which on
 * a normal network is everything. `later` resolves when the last probe
 * finishes, so a hub that was merely far away still gets counted.
 */
function probeInTwoPhases(endpoints: string[], token: string, settleAfter = PROBE_MS) {
  const round = startProbes(endpoints, token, PROBE_PATIENCE_MS);
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, settleAfter));
  return {
    soon: Promise.race([round.settled, deadline]).then(() => round.result()),
    later: round.settled.then(() => round.result()),
  };
}

export class Client {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<string, Pending>();
  private listeners = new Set<Listener>();
  private subscribed = new Set<string>();
  private backoff = 500;
  private closed = false;
  private connecting = false;
  private peers = new Map<string, Peer>();
  private presencePoll: ReturnType<typeof setInterval> | null = null;
  private onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    // Picking the phone back up. It may well be on a different network than
    // it was when you put it down, so anything relaying is worth another go.
    this.retryDirectNow();
    // Coming back to the foreground: the socket is almost certainly dead and
    // the backoff timer may be ten seconds out. Try now.
    if (!this.connected && !this.connecting) {
      this.backoff = 500;
      this.connect().catch(() => {});
    }
  };

  /**
   * The network underneath us changed - Wi-Fi to cellular, one LAN to
   * another. A socket can survive that looking open while reaching nothing,
   * and the hub that was the right one to hold may not be reachable at all
   * any more. Drop it and race the addresses again; closing here goes through
   * `onclose`, which is what schedules the fresh attempt.
   */
  private onNetworkChange = () => {
    if (this.closed) return;
    this.backoff = 500;
    // Moving between networks is exactly when a direct connection that was
    // impossible becomes possible - the phone that just joined the wifi the
    // machine is on. Do not make it wait out a backoff to find that out.
    this.retryDirectNow();
    if (this.connected) this.ws?.close(4001, 'network changed');
    else if (!this.connecting) this.connect().catch(() => {});
  };
  /** What the last connection attempt ran into, for the diagnostics line. */
  public lastError = '';

  /** The hub we are currently attached to. */
  public relay: string;
  /**
   * A hub found to see more of the network than the one we would otherwise
   * settle on. Sticky, so the upgrade happens once rather than on every
   * reconnect; cleared the moment it stops answering.
   */
  private preferred: string | null = null;

  /** Which machines are currently reachable without going through a hub. */
  directTo(env: string) { return this.peers.get(env)?.ready ?? false; }

  /**
   * What one round trip to a machine costs, in milliseconds.
   *
   * Worth measuring rather than assuming, because the two routes differ by
   * two orders of magnitude. A direct peer connection on the same wifi is a
   * few milliseconds; the same phone relaying through a hub on the other
   * side of the world was measured at 1.1 seconds a round trip, every leg of
   * it crossing the same slow link twice. The terminal reads this to decide
   * how to draw, and the sidebar shows it so a bad connection looks like a
   * bad connection instead of like broken software.
   */
  private rttSamples = new Map<string, number[]>();
  private rttTimers = new Map<string, ReturnType<typeof setInterval>>();

  /**
   * The lowest of the last few samples, not an average of them.
   *
   * What we want to know is what the path costs, and every source of error
   * only ever adds: a busy main thread, a page still loading, a daemon
   * reading a file. Averaging folds all of that in, and smoothing spreads
   * it over the next minute - the first version of this showed "947ms" on a
   * connection that was actually 3ms, for forty seconds after opening the
   * machine, which is exactly the wrong thing to tell someone wondering why
   * their terminal feels slow. The minimum is the honest floor and it
   * recovers the moment one clean sample lands.
   */
  private static RTT_KEEP = 8;

  latency(env: string): number | null {
    const samples = this.rttSamples.get(env);
    return samples?.length ? Math.min(...samples) : null;
  }

  /**
   * Which pair of addresses a direct connection actually settled on.
   *
   * "Direct" is not one thing. A pair of `host` candidates on the same wifi
   * is a millisecond; a pair of `srflx` ones is a trip out to whatever the
   * internet thinks your address is and back, which behind a VPN means a
   * datacentre on another continent - measured here at 575ms while the app
   * cheerfully said "direct connection". Worth being able to see.
   */
  async route(env: string): Promise<{ local?: string; remote?: string; rttMs?: number } | null> {
    const peer = this.peers.get(env);
    if (!peer?.ready) return null;
    try {
      const stats = await peer.pc.getStats();
      let pair: any = null;
      stats.forEach((r: any) => {
        if (r.type === 'candidate-pair' && (r.nominated || r.selected) && r.state === 'succeeded') pair = r;
      });
      if (!pair) return null;
      const find = (id: string) => { let out: any = null; stats.forEach((r: any) => { if (r.id === id) out = r; }); return out; };
      return {
        local: find(pair.localCandidateId)?.candidateType,
        remote: find(pair.remoteCandidateId)?.candidateType,
        rttMs: pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * Start measuring, and keep measuring, until every watcher has stopped.
   *
   * Refcounted because two things want this at once - the machine header,
   * which shows the number, and the terminal, which uses it to decide
   * whether to draw keystrokes before they land. Without the count, closing
   * one would silently stop the other's measurements and the terminal would
   * quietly go back to feeling slow.
   */
  private rttWatchers = new Map<string, number>();

  watchLatency(env: string) {
    this.rttWatchers.set(env, (this.rttWatchers.get(env) ?? 0) + 1);
    if (this.rttTimers.has(env)) return () => this.unwatchLatency(env);
    const ping = async () => {
      if (!this.connected && !this.directTo(env)) return;
      const started = performance.now();
      try {
        await this.rpc(env, 'ping', {}, 15_000);
        const sample = performance.now() - started;
        const samples = this.rttSamples.get(env) ?? [];
        samples.push(sample);
        // A bounded window, so moving from wifi to cellular shows up rather
        // than being outvoted forever by one good sample from before.
        while (samples.length > Client.RTT_KEEP) samples.shift();
        this.rttSamples.set(env, samples);
      } catch {
        this.rttSamples.delete(env);
      }
      this.emit(env, 'latency', { env, ms: this.latency(env) });
    };
    ping();
    // Often enough that the window fills while you are still looking at the
    // machine you just opened, and cheap: the reply is a timestamp. Skipped
    // while hidden - a latency nobody can see is not worth a radio wake-up.
    const timer = setInterval(() => { if (!document.hidden) ping(); }, 3_000);
    this.rttTimers.set(env, timer);
    return () => this.unwatchLatency(env);
  }

  private unwatchLatency(env: string) {
    const left = (this.rttWatchers.get(env) ?? 1) - 1;
    if (left > 0) { this.rttWatchers.set(env, left); return; }
    this.rttWatchers.delete(env);
    const timer = this.rttTimers.get(env);
    if (timer) clearInterval(timer);
    this.rttTimers.delete(env);
    this.rttSamples.delete(env);
  }

  constructor(public endpoints: string[], public token: string) {
    // Wherever this page came from is a hub that works: it just served the
    // page. Stored endpoints can be years of addresses old, so it goes in
    // whether or not the list remembers it.
    this.endpoints = [...new Set([...here(), ...endpoints])].slice(0, MAX_ENDPOINTS);
    this.relay = this.endpoints[0];
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisible);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onNetworkChange);
    }
  }

  /**
   * While the socket is down but a hub still answers HTTP, keep presence
   * honest by asking over HTTP. A carrier that mangles WebSocket upgrades
   * should degrade the app to "a bit slower", not to "everything is offline".
   */
  private startPresencePoll() {
    if (this.presencePoll) return;
    this.presencePoll = setInterval(() => {
      if (this.connected || this.closed || document.hidden) return;
      this.environments()
        .then((r) => {
          for (const env of r.environments) {
            this.emit(env.id, 'presence', { env: env.id, online: env.online, info: env.info, name: env.name });
          }
          this.emit('', 'connection', { online: false, reachable: true, hub: this.relay });
        })
        .catch(() => {});
    }, 10_000);
  }
  private stopPresencePoll() {
    if (this.presencePoll) clearInterval(this.presencePoll);
    this.presencePoll = null;
  }

  get connected() { return this.ws?.readyState === WebSocket.OPEN; }

  /**
   * Keep trying to connect until it works or the client is closed.
   *
   * The retry has to be re-armed on *every* failure path. Failing to find any
   * reachable hub - a phone in airplane mode, the VM rebooting - throws before
   * a WebSocket ever exists, so the socket's own close handler cannot be the
   * only thing that schedules the next attempt; that is how the app used to
   * end up showing "retrying" forever while retrying nothing.
   */
  private scheduleReconnect() {
    if (this.closed) return;
    setTimeout(() => this.connect().catch(() => {}), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 15_000);
  }

  async connect(): Promise<void> {
    if (this.closed || this.connecting) return;
    this.connecting = true;

    let hub: string | null = null;
    let unauthorized = false;
    try {
      // What was actually tried, and what actually answered. `learn()` needs
      // both: an address it skipped is not an address that failed.
      const tried = this.endpoints.filter(reachableFromHere);
      this.tried = new Set(tried);

      // A hub already known to see more of the network than its neighbours is
      // used directly. Without this the upgrade below would happen on every
      // single reconnect - settle on the near hub, discover the far one is
      // better, close, reconnect, settle on the near hub again - and the app
      // would flap between them forever.
      if (this.preferred && tried.includes(this.preferred)) {
        const check = await probeEndpoints([this.preferred], this.token);
        if (check.best) {
          this.answered = check.answered;
          hub = check.best;
        } else {
          // It stopped answering; fall through and choose again.
          this.preferred = null;
        }
      }

      if (!hub) {
        const { soon, later } = probeInTwoPhases(tried, this.token);
        const probe = await soon;
        ({ best: hub, unauthorized } = probe);
        this.answered = probe.answered;

        // A hub that was still thinking when we settled may see more of the
        // network than the one we took. Attaching to a hub that cannot see a
        // machine makes that machine look switched off - which is exactly
        // what a VPN'd laptop did, showing its own VM as offline while the
        // phone was talking to it happily. Worth one reconnect to move, but
        // only for strictly more reach, never for a few milliseconds.
        const settledOn = hub;
        const chosenReach = probe.reached.find((r) => r.base === settledOn)?.reach ?? 0;
        later.then((full) => {
          if (this.closed || this.relay !== settledOn) return;
          const best = full.reached[0];
          if (!best || best.base === settledOn || best.reach <= chosenReach) return;
          this.preferred = best.base;
          this.relay = best.base;
          // Closing makes the socket's own onclose reconnect, which now goes
          // straight to the better hub through `preferred`.
          this.ws?.close();
        }).catch(() => {});
      }
    } finally {
      if (!hub) {
        this.connecting = false;
        if (unauthorized) {
          // Every machine that answered said no. The token is dead; say so
          // instead of showing "retrying" until the end of time.
          this.closed = true;
          this.emit('', 'unauthorized', {});
        } else {
          this.lastError = 'no hub answered';
          this.emit('', 'connection', { online: false, reachable: false });
          this.scheduleReconnect();
        }
      }
    }
    if (!hub) throw new Error('no machine in this network is reachable right now');
    if (this.closed) { this.connecting = false; return; }
    this.relay = hub;

    await new Promise<void>((resolve, reject) => {
      const url = `${hub.replace(/^http/, 'ws')}/ws`;
      // The token rides in the WebSocket subprotocol list rather than the
      // query string, so it never lands in Caddy or tunnel access logs. The
      // server answers with the plain "helm" protocol.
      const ws = new WebSocket(url, ['helm', this.token]);
      this.ws = ws;

      ws.onopen = () => {
        this.connecting = false;
        this.backoff = 500;
        this.lastError = '';
        this.stopPresencePoll();
        for (const env of this.subscribed) {
          ws.send(JSON.stringify({ t: 'subscribe', env }));
        }
        this.emit('', 'connection', { online: true, hub });
        settle();
      };

      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.t === 'rpcResult') {
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error?.message ?? 'failed'));
          return;
        }
        if (msg.t === 'event') this.deliver(msg.env, msg.kind, msg.payload, msg.eid);
        if (msg.t === 'presence') this.emit(msg.env, 'presence', msg);
        if (msg.t === 'signal') this.onSignal(msg.env, msg.payload);
      };

      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        err ? reject(err) : resolve();
      };

      ws.onerror = () => settle(new Error('could not reach any machine'));
      ws.onclose = (ev) => {
        this.connecting = false;
        // A deliberate close must not restart the reconnect loop.
        if (this.closed) return;
        this.lastError = `socket closed (${ev.code}${ev.reason ? ` ${ev.reason}` : ''})`;
        // The hub answered HTTP a moment ago, so machines are reachable even
        // though the socket is not; say that, and keep presence fresh.
        this.emit('', 'connection', { online: false, reachable: true, hub, error: this.lastError });
        this.startPresencePoll();
        // Every in-flight call is now unanswerable; fail them rather than
        // leaving the UI spinning forever.
        for (const p of this.pending.values()) p.reject(new Error('disconnected'));
        this.pending.clear();
        // Re-race on every retry rather than clinging to the hub that just
        // dropped: the usual reason it went away is that we moved networks,
        // and a different machine is now the reachable one.
        this.scheduleReconnect();
      };
    });

    // Machines come and go, and each one advertises fresh addresses as it
    // moves; folding them in here is what keeps a device working after the
    // address it was first added on has stopped existing.
    this.network()
      .then((n) => { if (n.endpoints?.length) this.learn(n.endpoints); })
      .catch(() => {});
  }

  /** What the last probe tried, and which of those answered. */
  private tried = new Set<string>();
  private answered = new Set<string>();

  /**
   * Remember addresses we did not previously know about, and forget the ones
   * that have stopped being either.
   *
   * Capped, and newest first. A laptop that travels advertises a different
   * private address on every network it joins, and an uncapped list means
   * every cafe it ever visited gets probed on every single connect - slower
   * every time, forever.
   *
   * Dropping is the other half, and it only happens here - after a *successful*
   * connect, holding a freshly advertised list from a hub that answered. An
   * address goes only if the network no longer advertises it AND it was just
   * tried AND it did not answer. So nothing is ever dropped while it works,
   * nothing is dropped that a sleeping machine still advertises, and nothing
   * is dropped on the strength of a failure that might just have been this
   * device being offline - because if it were, we would not be here.
   */
  learn(endpoints: string[]) {
    // `here()` leads, because the cap is a real eviction: two machines
    // advertising a LAN address, a tailnet address, a public one and whatever
    // they had last week is already more than twelve, and the address that
    // served the page was being pushed off the end of the list. The desktop
    // app then sat on "reconnecting" while probing two LAN addresses this
    // laptop had not had for days - with a working hub on the other end of
    // the socket that had just handed it the page.
    const advertised = new Set([...here(), ...endpoints]);
    const alive = this.endpoints.filter(
      (e) => advertised.has(e) || this.answered.has(e) || !this.tried.has(e));
    const merged = [...new Set([...here(), ...endpoints, ...alive])].slice(0, MAX_ENDPOINTS);
    const same =
      merged.length === this.endpoints.length &&
      merged.every((e, i) => e === this.endpoints[i]);
    if (same) return;
    this.endpoints = merged;
    this.emit('', 'endpoints', { endpoints: merged });
  }

  private emit(env: string, kind: string, payload: any) {
    for (const l of this.listeners) l(env, kind, payload);
  }

  on(listener: Listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Tear everything down; used when the signed-in account changes. */
  close() {
    this.closed = true;
    this.stopPresencePoll();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisible);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onNetworkChange);
    }
    this.wantDirect.clear();
    for (const timer of this.directRetry.values()) clearTimeout(timer);
    this.directRetry.clear();
    for (const env of [...this.peers.keys()]) this.dropDirect(env);
    try { this.ws?.close(); } catch { /* already closing */ }
  }

  subscribe(env: string) {
    this.subscribed.add(env);
    if (this.connected) this.ws!.send(JSON.stringify({ t: 'subscribe', env }));
  }

  /**
   * One machine's usage. Slow the first time on a machine with a long history
   * - it is reading every transcript the CLIs ever wrote - and milliseconds
   * after that, because the daemon keeps a per-file index. The timeout is
   * generous for exactly that first call.
   */
  usage(env: string, opts: { since?: string; until?: string; by?: string[]; rebuild?: boolean } = {}) {
    return this.rpc<UsageReport>(env, 'usage.report', opts, 120_000);
  }

  rpc<T = any>(env: string, method: string, params: any = {}, timeout = 30_000): Promise<T> {
    const peer = this.peers.get(env);
    const direct = peer?.ready && peer.channel.readyState === 'open';
    if (!direct && !this.connected) return Promise.reject(new Error('not connected'));

    const id = `w${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const frame = JSON.stringify({ t: 'rpc', id, env, method, params });
      // Prefer the direct channel: relaying costs two internet round trips
      // per call, which is what makes a remote session feel dead. A large
      // frame (image attachments, old-chat history) is fragmented; if the
      // direct send fails outright, fall back to the relay in the same call.
      let sent = false;
      if (direct) sent = sendDirect(peer!.channel, frame);
      if (!sent) {
        if (!this.connected) {
          this.pending.delete(id);
          reject(new Error('not connected'));
          return;
        }
        try {
          this.ws!.send(frame);
        } catch (e: any) {
          this.pending.delete(id);
          reject(e);
          return;
        }
      }
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, timeout);
    });
  }

  // ------------------------------------------------------------ direct path

  /**
   * Try to reach an environment directly. Safe to call repeatedly; if it
   * fails or never completes, everything keeps working over the relay.
   */
  /**
   * Machines we would like a direct connection to, and how long to wait
   * before the next attempt.
   *
   * A direct connection is attempted once when you open a machine, and if it
   * fails everything keeps working over the relay - which is correct, and was
   * also the end of it. Nothing ever tried again. So a phone that failed to
   * pair once stayed relayed for the life of the page: walk in the door,
   * swap from cellular to the same wifi as the laptop, and helm would still
   * be going through a hub on another continent. The owner's phone did
   * exactly this for a day.
   *
   * Now it keeps trying, backing off to every half minute, and starts over
   * immediately when the browser says the network changed - which is the
   * moment the answer is most likely to have changed too.
   */
  private wantDirect = new Set<string>();
  private directRetry = new Map<string, ReturnType<typeof setTimeout>>();
  private directWait = new Map<string, number>();
  private static DIRECT_FIRST_MS = 4_000;
  private static DIRECT_MAX_MS = 30_000;

  private retryDirect(env: string) {
    if (!this.wantDirect.has(env) || this.closed) return;
    if (this.directRetry.has(env) || this.peers.has(env)) return;
    const wait = this.directWait.get(env) ?? Client.DIRECT_FIRST_MS;
    this.directWait.set(env, Math.min(wait * 2, Client.DIRECT_MAX_MS));
    const timer = setTimeout(() => {
      this.directRetry.delete(env);
      this.openDirect(env).catch(() => {});
    }, wait);
    this.directRetry.set(env, timer);
  }

  /** The network moved under us: everything we know about routes is stale. */
  private retryDirectNow() {
    for (const env of this.wantDirect) {
      const timer = this.directRetry.get(env);
      if (timer) clearTimeout(timer);
      this.directRetry.delete(env);
      this.directWait.delete(env);
      this.openDirect(env).catch(() => {});
    }
  }

  async openDirect(env: string) {
    this.wantDirect.add(env);
    if (this.peers.has(env) || !this.connected) { this.retryDirect(env); return; }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const channel = pc.createDataChannel('helm', { ordered: true });
    const peer: Peer = { pc, channel, ready: false, fragments: new Map() };
    this.peers.set(env, peer);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.signal(env, { type: 'candidate', candidate: candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        this.dropDirect(env);
      }
    };

    channel.onopen = () => {
      peer.ready = true;
      // It worked, so the next failure starts its backoff from scratch.
      this.directWait.delete(env);
      this.emit(env, 'transport', { direct: true });
    };
    channel.onclose = () => this.dropDirect(env);
    channel.onmessage = (ev) => {
      const raw = this.accumulate(peer, ev.data);
      if (raw == null) return;
      let msg: any;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.t === 'rpcResult') {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error?.message ?? 'failed'));
        return;
      }
      if (msg.t === 'event') this.deliver(env, msg.kind, msg.payload, msg.eid);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signal(env, { type: 'offer', sdp: pc.localDescription!.sdp });
  }

  /** Ids of events already handed on, so the second copy is ignored. */
  private seenEvents = new Set<string>();
  private seenOrder: string[] = [];

  /**
   * Deliver an event once.
   *
   * The same push arrives over the hub and over the direct peer channel,
   * because a direct connection is preferred for sending but does not
   * replace the hub subscription. Without this, a terminal wrote every
   * keystroke's echo twice. Events from a daemon too old to stamp an id are
   * passed through rather than dropped.
   */
  private deliver(env: string, kind: string, payload: any, eid?: string) {
    if (eid) {
      if (this.seenEvents.has(eid)) return;
      this.seenEvents.add(eid);
      this.seenOrder.push(eid);
      // Only the recent past can duplicate; the rest is not worth remembering.
      if (this.seenOrder.length > 500) {
        this.seenEvents.delete(this.seenOrder.shift()!);
      }
    }
    this.emit(env, kind, payload);
  }

  private signal(env: string, payload: any) {
    if (this.connected) this.ws!.send(JSON.stringify({ t: 'signal', env, payload }));
  }

  private async onSignal(env: string, payload: any) {
    const peer = this.peers.get(env);
    if (!peer) return;
    if (payload?.type === 'answer') {
      await peer.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
    } else if (payload?.type === 'candidate' && payload.candidate) {
      await peer.pc.addIceCandidate(payload.candidate).catch(() => {});
    }
  }

  /**
   * Reassemble a possibly-fragmented direct-channel frame. Returns the full
   * JSON string once complete, or null while waiting for more pieces.
   */
  private accumulate(peer: Peer, raw: any): string | null {
    if (typeof raw !== 'string') return null;
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return null; }
    if (msg?.t !== DC_CHUNK_TYPE || typeof msg.gid !== 'string') return raw;
    const { gid, i, n, data } = msg;
    if (!Number.isInteger(n) || n <= 1 || n > 2000) return null;
    if (!Number.isInteger(i) || i < 0 || i >= n) return null;
    let entry = peer.fragments.get(gid);
    if (!entry) {
      entry = { n, parts: new Array(n), got: 0 };
      peer.fragments.set(gid, entry);
    }
    if (entry.parts[i] !== undefined) return null;
    entry.parts[i] = typeof data === 'string' ? data : '';
    entry.got++;
    if (peer.fragments.size > 8) {
      const oldest = peer.fragments.keys().next().value as string | undefined;
      if (oldest && oldest !== gid) peer.fragments.delete(oldest);
    }
    if (entry.got < entry.n) return null;
    peer.fragments.delete(gid);
    return entry.parts.join('');
  }

  dropDirect(env: string) {
    const peer = this.peers.get(env);
    if (!peer) return;
    this.peers.delete(env);
    try { peer.channel.close(); peer.pc.close(); } catch { /* already gone */ }
    this.emit(env, 'transport', { direct: false });
    // Losing it is not the end of trying for it.
    this.retryDirect(env);
  }

  // ------------------------------------------------------------- REST helpers

  private async http<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.relay}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}`, ...init.headers },
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    return res.json();
  }

  network() {
    return this.http<{
      id: string; self: string; you: string;
      machines: Environment[]; devices: Device[]; endpoints: string[];
    }>('/api/network');
  }

  environments() {
    return this.http<{ machines: Environment[] }>('/api/machines')
      .then((r) => ({ environments: r.machines }));
  }

  devices() { return this.http<{ devices: Device[] }>('/api/devices'); }

  /** An invite for adding another machine. Carries the network key. */
  invite() {
    return this.http<{ code: string; expiresAt: number; endpoints: string[] }>(
      '/api/invite', { method: 'POST' }
    );
  }

  /** A new short-lived password, for signing in another phone or browser. */
  newPassword(ttlMs?: number) {
    return this.http<{ password: string; expiresAt: number }>('/api/auth/rotate', {
      method: 'POST', body: JSON.stringify({ ttlMs }),
    });
  }

  /**
   * Change what a machine is called.
   *
   * Deliberately an RPC to that machine rather than a call to the hub: a
   * machine's roster record has one author, itself, and a name written
   * anywhere else reaches every machine in the network except the one it
   * describes. So a machine that is not connected cannot be renamed, and the
   * screen says so rather than pretending the edit landed.
   */
  renameMachine(env: string, name: string) {
    return this.rpc<{ id: string; name: string }>(env, 'env.rename', { name }, 15_000);
  }

  removeMachine(id: string) { return this.http(`/api/machines/${id}`, { method: 'DELETE' }); }
  removeDevice(id: string) { return this.http(`/api/devices/${id}`, { method: 'DELETE' }); }

  digests(limit = 50) { return this.http<{ digests: any[] }>(`/api/digests?limit=${limit}`); }

  /** The hub's VAPID public key: what a browser checks push signatures against. */
  pushKey() { return this.http<{ key: string }>('/api/push/key'); }

  /** Remember where to reach this browser when the app is closed. */
  pushSubscribe(body: { endpoint: string; keys: unknown; label?: string }) {
    return this.http<{ ok: true }>('/api/push/subscribe', {
      method: 'POST', body: JSON.stringify(body),
    });
  }

  pushUnsubscribe(endpoint?: string) {
    return this.http<{ ok: true }>('/api/push/unsubscribe', {
      method: 'POST', body: JSON.stringify({ endpoint }),
    });
  }
}

/**
 * What a machine may be called, checked here so the form can say so before
 * the round trip. The daemon checks the same thing and is the one that
 * decides; this is the copy that makes the button honest.
 *
 * The rule itself is in `@helm/protocol/network` (`machineName`), where the
 * reason for it lives: a machine's name is also its ssh Host alias.
 */
export const MACHINE_NAME_RULE =
  'a letter or number first, then letters, numbers, dots, dashes or underscores';

export const validMachineName = (value: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.trim());

export interface Device {
  id: string;
  label: string;
  addedAt: number;
  self?: boolean;
}

/**
 * Sign in.
 *
 * The password is spent here and never needed again: what comes back is a
 * token signed with the network key, which every machine in the network will
 * accept - including ones that have never seen this device, and ones added
 * long after it. Along with it comes the list of addresses to try in future,
 * so this device is no longer tied to whichever machine signed it in.
 */
/**
 * Sign in to a machine.
 *
 * Normally that means a pairing password from `helm add controller`. On the
 * machine itself, `helm open` supplies its local key instead - the daemon
 * accepts it only from loopback, and only if it matches the file in ~/.helm
 * that just handed it to us.
 */
export async function login(endpoint: string, password: string, local?: string) {
  const base = endpoint.replace(/\/$/, '');
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password, local, label: deviceLabel() }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({} as any));
    throw new Error(
      body.error ?? (res.status === 401 ? 'wrong password' : `the machine returned ${res.status}`)
    );
  }
  const { token, deviceId, endpoints } = await res.json();
  return {
    token: token as string,
    deviceId: deviceId as string,
    endpoints: [...new Set<string>([base, ...(endpoints ?? [])])],
  };
}

/** Something recognisable in the devices list, so removing one is unambiguous. */
function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? 'iPhone'
    : /Android/.test(ua) ? 'Android'
    : /Mac/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux' : 'device';
  const browser = /CriOS|Chrome/.test(ua) ? 'Chrome'
    : /Firefox/.test(ua) ? 'Firefox'
    : /Safari/.test(ua) ? 'Safari' : 'browser';
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches;
  return standalone ? `${os} app` : `${os} ${browser}`;
}
