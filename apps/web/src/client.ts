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
  /** What the machine is for; absent on records from before kinds existed. */
  kind?: 'pc' | 'vm' | 'nas';
  online: boolean;
  lastSeen: number | null;
  /** Where this machine's own hub answers - the direct path to it. */
  endpoints?: string[];
  info: {
    host?: string;
    platform?: string;
    arch?: string;
    /** 'pty' when terminals are helm's own; 'panes' is the slow fallback. */
    terminals?: 'pty' | 'panes';
    /** This machine holds a Groq key, so it can transcribe what you say. */
    voice?: boolean;
    runtime?: { version: string };
    /** Which helm this machine runs; null where it is not a git checkout. */
    version?: { commit: string; full?: string; time?: number; dirty?: boolean; dir?: string; branch: string; subject: string; updatable: boolean } | null;
    /** This machine and another both have their own saved changes. */
    sync?: { diverged?: boolean; with?: string; reason?: string } | null;
    /** Whether normal `claude`/`codex` commands typed here show up in Helm. */
    cliLink?: { on: boolean; commands: string[] };
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
  /** Set when the account is launched through a wrapper script that picks its login. */
  wraps?: string;
  /** authenticated / unknown - signed-out profiles never reach the app. */
  auth?: string;
  /** Account key every alias of the same login shares, from the daemon. */
  account?: string;
  prefs?: ModelPrefs | null;
  /** Session-start defaults stored on the machine, shared by every device. */
  defaults?: { effort?: string; mode?: string; speed?: string } | null;
}

export interface Session {
  paneId?: string;
  id: string;
  title: string;
  cwd: string;
  /** The git branch the folder is on, read by the machine; null outside a repo. */
  branch?: string | null;
  engine: string;
  profileId: string;
  status: Status;
  alive?: boolean;
  createdAt?: number;
  updatedAt?: number;
  queueOrder?: string[];
  team?: { working: number; blocked: number; failed: number };
  recovery?: { kind: 'limited' | 'error' | 'interrupted' | 'restart'; message: string; at: number };
  lastUsage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; inputIncludesCache?: boolean; at: number; model?: string };
  /** Set on a headless agent session: which driver runs it. */
  driver?: string;
  /** A managed provider shared by the terminal client and paired apps. */
  shared?: boolean;
  /** Set on a terminal helm owns: a pty, not a herdr pane. */
  pty?: boolean;
  /** A normal local CLI launch; app and laptop share its native terminal. */
  nativeCli?: boolean;
  /** Native Claude connected to Helm's conversation UI through its channel. */
  nativeChat?: boolean;
  /** Joined through Codex's existing shared local daemon. */
  nativeCodex?: boolean;
  /** Moving a CLI open before Helm into a shared terminal. */
  takeover?: 'waiting' | null;
  takeoverError?: string | null;
  /** Where a taken-over conversation went. */
  movedTo?: Session;
  model?: string | null;
  /** What the CLI said it actually started with, when nothing was picked. */
  engineModel?: string | null;
  engineEffort?: string | null;
  mode?: string | null;
  speed?: string | null;
  effort?: string | null;
  /** Prompts waiting on a person, for the list view. */
  pending?: number;
  /** What the newest of those prompts is about - the question's first line. */
  ask?: { kind: 'question' | 'command' | 'edit' | 'plan' | 'tool'; text: string; more: number; requestId?: string } | null;
  adopted?: boolean;
  /** Archived threads stay on the machine but are hidden from active groups. */
  archived?: boolean;
  /** The network's single agent, hosted on its VM. */
  brain?: boolean;
  /** What the whole thread has cost and how many turns it took, so far. */
  costUsd?: number;
  turns?: number;
  /** Whether this thread announces each completed turn. */
  notifyDone?: boolean;
  /** The id the CLI itself gave this session; matches inventory rows. */
  engineSessionId?: string | null;
  /** On a row read from a CLI's history: the account it was recorded under. */
  account?: string;
  /** A CLI outside Helm currently owns this monitored thread. */
  externalActive?: boolean;
  /** This is a transcript monitor which can become driven after handoff. */
  external?: boolean;
  delegation?: { parentId: string | null; task: string; requestedModel: string | null; depth: number; status?: string; summary?: string; finishedAt?: number };
  taskTransfer?: TaskReturnState & { handoffId: string; role: 'source' | 'destination'; machineId: string; machineName: string };
  parent?: { machineId: string; sessionId: string };
  delegations?: string[];
  /** A helper with no thread to sit under (started from a shell, or orphaned), listed on its own. */
  unhomed?: boolean;
}

export interface CliAgent {
  id: string; label: string; engine: string; account: string;
  auth: 'authenticated' | 'unauthenticated' | 'unknown'; available: boolean;
  models?: string[]; labels?: Record<string, string>; defaultModel?: string | null;
  modes: Mode[];
  defaultMode?: string | null;
}

export interface DelegationResult {
  session: Session; status: string; complete: boolean; output: string;
  truncated?: boolean; error?: string | null;
  pending?: { requestId: string; title?: string; kind: string } | null;
}

/** A thread a CLI recorded on its own, whether or not helm started it. */
export interface InventorySession {
  status?: Session['status'];
  turns?: number;
  engine: string;
  account: string;
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
  model?: string;
  /** The CLI still has the thread's single writer lock. */
  active?: boolean;
  /** Filed away by the owner; the machine remembers, so every device agrees. */
  archived?: boolean;
}

/** A permission mode an engine offers, in words; the daemon knows the flags. */
export interface Mode { id: string; label: string; short?: string; hint?: string; danger?: boolean }
export interface ModelList {
  default: string | null;
  models: string[];
  /** Public catalog is still arriving; fetch again after showing this answer. */
  refreshing?: boolean;
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
  defaultMode?: string | null;
  /** Models starred for this engine on this machine, shared by every device. */
  favs?: string[];
  /** Favorite thinking levels, stored as JSON [model, effort] pairs per engine. */
  effortFavs?: string[];
  /** What a new chat on this account starts with, besides the model. */
  defaults?: { effort?: string; mode?: string; speed?: string } | null;
  /** The account key the machine files this account's defaults under. */
  account?: string;
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
  /**
   * The hub answered for a machine that is asleep, folding the rollup it
   * last pushed. A memory, not a reading - the same courtesy this device's
   * own cache gets, surfaced the same way.
   */
  stale?: boolean;
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

/** What a send will carry - and what it deliberately will not. */
export interface TransferSkipped { path: string; reason: string }
export interface TransferWarning { code: string; path?: string; message: string }
export interface TransferPreflight {
  files: number;
  bytes: number;
  envFiles: string[];
  skipped: number;
  skippedEntries: TransferSkipped[];
  omittedEntries: number;
  warnings: TransferWarning[];
  requiresAcknowledgement: boolean;
}
export interface TransferPreview {
  sourceMachineId: string;
  rootName: string;
  digest: string;
  git?: { commit?: string; branch?: string; remote?: string } | null;
  preflight: TransferPreflight;
  /** Over the sealed-send cap: only a task send can carry it, by resumable copy. */
  bulk?: { files: number | null; bytes: number; reason: string };
}
export interface ReadinessCheck {
  code: string;
  status: 'pass' | 'warning' | 'fail' | string;
  path?: string;
  message: string;
}
export interface TransferReadiness {
  status: 'needs-setup' | 'unverified' | string;
  verified: boolean;
  checks: ReadinessCheck[];
}
export interface TransferReceipt {
  folder: string;
  files: number;
  bytes: number;
  skipped: number;
  skippedEntries: TransferSkipped[];
  digest: string;
  readiness: TransferReadiness;
  repository?: { remote: string; configured: boolean; error?: string };
}
export interface TransferResult {
  sent: boolean;
  requiresAcknowledgement?: boolean;
  transferId?: string;
  targetMachineId?: string;
  targetName?: string;
  preflight: TransferPreflight;
  receipt?: TransferReceipt;
}
export interface TaskTransferResult {
  sent: boolean;
  requiresAcknowledgement?: boolean;
  status?: 'running' | 'queued' | 'copying';
  /** A big project copying ahead of its task: how far it got. */
  progress?: { phase: 'pausing' | 'copying' | 'starting'; folder: string; bytes: number; total: number; percent: number; rate?: string | null };
  handoffId?: string;
  targetMachineId?: string;
  targetName?: string;
  route?: 'direct' | 'relay';
  warning?: string;
  preflight: TransferPreflight;
  receipt?: { sessionId: string; folder: string; files: number; bytes: number };
}
export interface TaskReturnState {
  status: string;
  error?: string;
  folder?: string;
  sourceFolder?: string;
  conflicts?: string[];
  changed?: number;
}

/** A folder a machine designated 'nas' has agreed to serve. */
export interface MediaRoot { id: number; name: string; path: string }

/** One entry inside a shared folder. `media` means a browser can play it. */
export interface MediaEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number | null;
  mtime: number;
  mime: string | null;
  media: boolean;
}

/** `worktrees` are other checkouts of this repo that have threads in them. */
export interface Project { path: string; title: string; worktrees?: string[] }

export interface Tool { name: string; input: string }
export interface Message {
  role: 'user' | 'assistant';
  text: string;
  tools: Tool[];
  thinking?: boolean;
  at?: string | number;
  attachments?: { filename: string; mime: string; data?: string; missing?: boolean }[];
}

type RpcRoute = 'direct' | 'relay' | 'http';
type Pending = {
  resolve: (v: any) => void; reject: (e: Error) => void;
  direct?: Peer; env?: string; hedged?: boolean;
  routes?: Set<RpcRoute>;
  recover?: () => void;
};
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
  negotiation: string;
  remoteReady: boolean;
  candidates: RTCIceCandidateInit[];
  fragments: Map<string, { n: number; parts: string[]; got: number }>;
  deadline?: ReturnType<typeof setTimeout>;
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
// Kept deliberately narrow, matching the hub's authenticated /api/read route.
// Prompts, approvals and other mutations must never acquire replay semantics.
const HTTP_READ_METHODS = new Set([
  'session.events', 'session.messages', 'session.list', 'model.list',
  'session.commands', 'env.info', 'session.watch', 'session.unwatch',
  'project.list',
]);

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
const PROBE_PATIENCE_MS = 30_000;

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

/** A hub that answered: where it is, how much of the network it can see. */
interface Reached { base: string; reach: number; elapsed: number }

interface ProbeResult {
  best: string | null;
  unauthorized: boolean;
  answered: Set<string>;
  reached: Reached[];
}

/**
 * Most machines visible wins; nearest is only the tie-break. Reach can be
 * asymmetric - the laptop dials out to a VM that cannot dial back in, so the
 * laptop's hub sees only itself while the VM's sees both. Picking the nearest
 * hub would quietly cost you every machine it cannot reach.
 */
const byReach = (a: Reached, b: Reached) => b.reach - a.reach || a.elapsed - b.elapsed;

/**
 * Ask every hub at once, and report what has come back whenever asked.
 *
 * One request per endpoint, ever: the results accumulate as they arrive, so
 * "the best answer so far" and "the best answer there is" are two reads of
 * the same round rather than two rounds.
 */
function startProbes(endpoints: string[], token: string, timeout: number, onReach?: (reached: Reached[]) => void) {
  const statuses: number[] = [];
  // Answering at all is worth knowing separately from winning: a 401 is a
  // machine that is there and refusing us, which is not a dead address.
  // `learn()` uses this to tell a stale address from a sleeping one.
  const answered = new Set<string>();
  const up: Reached[] = [];
  let first!: () => void;
  const firstReached = new Promise<void>((resolve) => { first = resolve; });

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
      first();
      onReach?.(up.slice().sort(byReach));
    } catch { /* unreachable, or too slow even for our patience */ }
    finally { clearTimeout(timer); }
  });

  return {
    firstReached,
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
function probeInTwoPhases(endpoints: string[], token: string, settleAfter = PROBE_MS, onReach?: (reached: Reached[]) => void) {
  const round = startProbes(endpoints, token, PROBE_PATIENCE_MS, onReach);
  let deadlineTimer: ReturnType<typeof setTimeout>;
  let graceTimer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<void>((resolve) => { deadlineTimer = setTimeout(resolve, settleAfter); });
  // One sleeping address must not impose a 2.5s delay on a healthy local hub.
  // Give near-simultaneous replies a brief chance to offer greater reach.
  const first = round.firstReached.then(() => new Promise<void>((resolve) => { graceTimer = setTimeout(resolve, 150); }));
  return {
    soon: Promise.race([round.settled, deadline, first]).then(() => {
      clearTimeout(deadlineTimer); clearTimeout(graceTimer);
      return round.result();
    }),
    available: Promise.race([round.firstReached, round.settled]).then(() => round.result()),
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
  private connectStartedAt = 0;
  private recoveryTimer: ReturnType<typeof setInterval> | undefined;
  private backgrounded = false;
  private connectVersion = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private disconnectSocket: ((reason: string, retry?: boolean) => void) | null = null;
  private retireSocket: (() => void) | null = null;
  private socketCleanups = new Set<() => void>();
  private lastGoodHub: string | null = null;
  private probeSocket: ((reset?: boolean) => void) | null = null;
  private failedHubs = new Map<string, number>();
  private httpReads = new Set<() => void>();
  private peers = new Map<string, Peer>();
  private presencePoll: ReturnType<typeof setInterval> | null = null;
  private reachPoll: ReturnType<typeof setInterval> | null = null;
  private reachCheck: Promise<unknown> | null = null;
  private onVisible = (event?: Event) => {
    if (this.closed) return;
    if (document.visibilityState !== 'visible') { this.backgrounded = true; return; }
    const resumed = this.backgrounded || event?.type === 'pageshow' || event?.type === 'resume';
    this.backgrounded = false;
    // Picking the phone back up. It may well be on a different network than
    // it was when you put it down, so anything relaying is worth another go.
    this.retryDirectNow();
    this.probeSocket?.(resumed);
    this.refreshReachability();
    // Coming back to the foreground: the socket is almost certainly dead and
    // the backoff timer may be ten seconds out. Try now.
    this.recoverConnection(true);
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
    this.failedHubs.clear();
    // Moving between networks is exactly when a direct connection that was
    // impossible becomes possible - the phone that just joined the wifi the
    // machine is on. Do not make it wait out a backoff to find that out.
    for (const env of [...this.peers.keys()]) this.dropDirect(env);
    this.connectVersion++;
    for (const cleanup of this.socketCleanups) cleanup();
    this.disconnectSocket?.('network changed', false);
    this.connecting = false;
    this.connect().catch(() => {});
  };
  private onOffline = () => {
    if (this.closed) return;
    this.connectVersion++;
    for (const cleanup of this.socketCleanups) cleanup();
    for (const env of [...this.peers.keys()]) this.dropDirect(env);
    this.disconnectSocket?.('network offline', false);
    this.connecting = false;
    clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined;
    this.emit('', 'connection', { online: false, reachable: false, hub: this.relay });
    this.scheduleReconnect();
  };
  /** What the last connection attempt ran into, for the diagnostics line. */
  public lastError = '';

  /** The hub we are currently attached to. */
  public relay: string;

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
      document.addEventListener('resume', this.onVisible);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onNetworkChange);
      window.addEventListener('offline', this.onOffline);
      window.addEventListener('pageshow', this.onVisible);
      window.addEventListener('focus', this.onVisible);
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
      const version = this.connectVersion;
      this.environments()
        .then((r) => {
          // This snapshot may have been in flight while a new socket opened.
          if (this.closed || this.connected || version !== this.connectVersion) return;
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

  private upgradeHub(reached: Reached[], version: number, hub: string) {
    if (this.closed || !this.connected || version !== this.connectVersion || this.relay !== hub) return;
    const current = reached.find(candidate => candidate.base === hub);
    const best = reached[0];
    if (!current || !best || best.base === hub || best.reach <= current.reach) return;
    this.backoff = 500;
    void this.connect(best.base).catch(() => {});
  }

  private refreshReachability() {
    if (this.closed || !this.connected || this.reachCheck || document.hidden) return;
    const version = this.connectVersion;
    const hub = this.relay;
    const endpoints = this.endpoints.filter(base => reachableFromHere(base)
      && (base === hub || (this.failedHubs.get(base) ?? 0) <= Date.now()));
    const round = startProbes(endpoints, this.token, PROBE_PATIENCE_MS,
      reached => this.upgradeHub(reached, version, hub));
    this.reachCheck = round.settled.finally(() => { this.reachCheck = null; });
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
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect().catch(() => {});
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 15_000);
  }

  private recoverConnection(immediate = false) {
    if (this.closed || this.connected) return;
    if (this.connecting) {
      if (Date.now() - this.connectStartedAt < 60_000) return;
      this.connectVersion++;
      for (const cleanup of this.socketCleanups) cleanup();
      this.connecting = false;
    }
    if (this.ws) this.disconnectSocket?.('connection closed without notification', false);
    if (!immediate && this.reconnectTimer) return;
    if (immediate) this.backoff = 500;
    void this.connect().catch(() => {});
  }

  private prepareSocket(hub: string) {
    const ws = new WebSocket(`${hub.replace(/^http/, 'ws')}/ws`, ['helm', this.token]);
    let cancel!: () => void;
    const ready = new Promise<WebSocket>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('socket connection timed out')), 20_000);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.socketCleanups.delete(cancel);
        ws.onopen = ws.onerror = ws.onclose = null;
        if (error) { try { ws.close(); } catch {} reject(error); }
        else resolve(ws);
      };
      cancel = () => finish(new Error('connection superseded'));
      this.socketCleanups.add(cancel);
      ws.onopen = () => finish();
      ws.onerror = ws.onclose = () => finish(new Error('could not reach the hub'));
    });
    return { ws, ready, cancel };
  }

  async connect(hubHint: string | null = null): Promise<void> {
    if (this.closed || this.connecting || (this.connected && !hubHint)) return;
    if (!this.recoveryTimer) this.recoveryTimer = setInterval(() => this.recoverConnection(), 5000);
    const migrating = this.connected;
    clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined;
    const version = ++this.connectVersion;
    this.connecting = true;
    this.connectStartedAt = Date.now();

    let hub: string | null = null;
    let prepared: ReturnType<Client['prepareSocket']> | undefined;
    let reached: Reached[] = [];
    let unauthorized = false;
    try {
      // What was actually tried, and what actually answered. `learn()` needs
      // both: an address it skipped is not an address that failed.
      const candidates = this.endpoints.filter(reachableFromHere);
      const healthy = candidates.filter(base => (this.failedHubs.get(base) ?? 0) <= Date.now());
      // HTTP can work where WebSocket upgrades fail. Give another hub a
      // chance after a broken socket instead of selecting the same HTTP
      // winner forever. With only one option, continue trying that option.
      const tried = healthy.length ? healthy : candidates;
      this.tried = new Set(tried);

      if (hubHint && tried.includes(hubHint)) hub = hubHint;

      if (!hub) {
        const warmHub = this.lastGoodHub ?? here().find(base => candidates.includes(base));
        if (warmHub && candidates.includes(warmHub)) prepared = this.prepareSocket(warmHub);
        let offerAlternative!: (base: string) => void;
        const alternative = new Promise<string>(resolve => { offerAlternative = resolve; });
        const { soon, available, later } = probeInTwoPhases(tried, this.token, PROBE_MS,
          results => {
            reached = results;
            const other = results.find(candidate => candidate.base !== warmHub);
            if (other) offerAlternative(other.base);
            if (hub) this.upgradeHub(results, version, hub);
          });
        const selection = soon.then(probe => probe.best ? probe : available);
        const warm = prepared?.ready.then(() => {
          return { best: warmHub!, unauthorized: false, answered: new Set([warmHub!]) };
        })
          .catch(() => selection);
        let probe = await (warm ? Promise.race([selection, warm]) : selection);
        // A slow network is still a network. If no hub has answered yet,
        // consume the same round's eventual answer instead of discarding it
        // and repeating a 2.5s deadline that can never succeed.
        if (!probe.best) probe = await available;
        if (!probe.best && prepared) {
          try {
            await prepared.ready;
            probe = { ...probe, best: warmHub!, unauthorized: false };
          } catch {}
        }
        ({ best: hub, unauthorized } = probe);
        if (prepared && hub !== warmHub) { prepared.cancel(); prepared = undefined; }
        if (prepared && prepared.ws.readyState !== WebSocket.OPEN) {
          try {
            hub = await Promise.race([prepared.ready.then(() => hub), alternative]);
            if (hub !== warmHub) { prepared.cancel(); prepared = undefined; }
          }
          catch { prepared = undefined; }
        }
        this.answered = probe.answered;

        // A hub that was still thinking when we settled may see more of the
        // network than the one we took. Attaching to a hub that cannot see a
        // machine makes that machine look switched off - which is exactly
        // what a VPN'd laptop did, showing its own VM as offline while the
        // phone was talking to it happily. Worth one reconnect to move, but
        // only for strictly more reach, never for a few milliseconds.
        const settledOn = hub;
        later.then((full) => {
          if (settledOn) this.upgradeHub(full.reached, version, settledOn);
        }).catch(() => {});
      }
    } finally {
      if (!hub && version === this.connectVersion && !this.closed) {
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
    if (version !== this.connectVersion) { prepared?.cancel(); return; }
    if (!hub) throw new Error('no machine in this network is reachable right now');
    if (this.closed) { prepared?.cancel(); this.connecting = false; return; }
    if (!migrating) this.relay = hub;

    await new Promise<void>((resolve, reject) => {
      const url = `${hub.replace(/^http/, 'ws')}/ws`;
      // Keep credentials out of URLs and access logs.
      const ws = prepared?.ws ?? new WebSocket(url, ['helm', this.token]);
      if (!migrating) this.ws = ws;
      let settled = false, stopped = false;
      let drain: ReturnType<typeof setTimeout> | undefined;
      let lastReceived = Date.now(), awaiting = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        err ? reject(err) : resolve();
      };
      const stop = (reason: string, retry = true) => {
        if (stopped) return;
        stopped = true;
        clearTimeout(handshake); clearInterval(heartbeat); clearTimeout(drain);
        this.socketCleanups.delete(cleanup);
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        if (this.ws === ws) {
          this.ws = null;
          if (version === this.connectVersion) this.connecting = false;
          this.disconnectSocket = this.probeSocket = null;
          this.retireSocket = null;
          this.lastError = reason;
          if (retry) this.failedHubs.set(hub, Date.now() + 15_000);
          // A healthy direct route can still answer while the relay reconnects.
          for (const [id, pending] of this.pending) {
            pending.routes?.delete('relay');
            if (pending.direct?.ready || pending.routes?.has('http')) continue;
            if (!this.closed && pending.recover) { pending.recover(); continue; }
            this.pending.delete(id);
            pending.reject(new Error('disconnected'));
          }
          if (!this.closed) {
            this.emit('', 'connection', { online: false, reachable: true, hub, error: reason });
            this.startPresencePoll();
            if (retry && !this.connecting) this.scheduleReconnect();
          }
        } else if (!settled && version === this.connectVersion) {
          this.connecting = false;
          if (retry) this.failedHubs.set(hub, Date.now() + 15_000);
          if (!this.connected && !this.closed && retry) this.scheduleReconnect();
        }
        try { ws.close(); } catch { /* already closed */ }
        settle(new Error(reason));
      };
      // Browsers may leave an upgrade CONNECTING for minutes. HTTP having
      // worked does not prove WebSocket upgrades work on this network.
      const handshake = setTimeout(() => stop('socket connection timed out'), 20_000);
      const cleanup = () => stop('connection superseded', false);
      this.socketCleanups.add(cleanup);
      if (!migrating) this.disconnectSocket = stop;
      const beat = (force = false) => {
        if (stopped || !this.connected || (!force && document.hidden)) return;
        const idle = Date.now() - lastReceived;
        if (awaiting && idle >= 15_000) { stop('connection stopped responding'); return; }
        if (!awaiting && (force || idle >= 10_000)) {
          awaiting = true;
          // Measure the grace from the ping, not from the preceding idle gap.
          lastReceived = Date.now();
          try { ws.send(JSON.stringify({ t: 'ping' })); } catch { stop('connection stopped responding'); }
        }
      };
      const probeSocket = (reset = false) => {
        // Timers may have slept with the page. Give a fresh ping its full
        // grace period instead of declaring a healthy socket dead on wake.
        if (reset) { awaiting = false; lastReceived = Date.now(); }
        beat(true);
      };
      ws.onopen = () => {
        if (stopped || this.closed || version !== this.connectVersion) { stop('connection superseded', false); return; }
        clearTimeout(handshake);
        const retire = this.retireSocket;
        this.ws = ws;
        this.relay = hub;
        this.lastGoodHub = hub;
        this.disconnectSocket = stop;
        this.probeSocket = probeSocket;
        this.retireSocket = () => {
          clearInterval(heartbeat);
          if (!this.pending.size) cleanup();
          else drain = setTimeout(cleanup, 60_000);
        };
        retire?.();
        this.connecting = false;
        this.backoff = 500;
        this.lastError = '';
        this.failedHubs.delete(hub);
        lastReceived = Date.now();
        this.stopPresencePoll();
        if (!this.reachPoll) this.reachPoll = setInterval(() => this.refreshReachability(), 15_000);
        for (const env of this.subscribed) ws.send(JSON.stringify({ t: 'subscribe', env }));
        heartbeat = setInterval(beat, 5000);
        for (const [env, peer] of this.peers) if (!peer.ready) this.dropDirect(env, peer);
        this.retryDirectNow();
        this.emit('', 'connection', { online: true, hub });
        settle();
      };
      ws.onmessage = (ev) => {
        if (stopped) return;
        let msg: any;
        try { msg = JSON.parse(ev.data); } catch { return; }
        lastReceived = Date.now(); awaiting = false;
        if (msg.t === 'ping') { ws.send(JSON.stringify({ t: 'pong' })); return; }
        if (msg.t === 'rpcResult') {
          this.receiveRpc(msg, 'relay');
          if (this.ws !== ws && !this.pending.size) cleanup();
          return;
        }
        if (this.ws !== ws) return;
        if (msg.t === 'event') this.deliver(msg.env, msg.kind, msg.payload, msg.eid);
        if (msg.t === 'presence') this.emit(msg.env, 'presence', msg);
        if (msg.t === 'signal') this.onSignal(msg.env, msg.payload).catch(() => {});
      };
      ws.onerror = () => stop('could not reach any machine');
      ws.onclose = (ev) => stop(`socket closed (${ev.code}${ev.reason ? ` ${ev.reason}` : ''})`);
      if (ws.readyState === WebSocket.OPEN) ws.onopen({} as Event);
    });

    this.upgradeHub(reached, version, hub);

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
    this.refreshReachability();
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
    this.connectVersion++;
    for (const cleanup of this.socketCleanups) cleanup();
    clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined;
    clearInterval(this.recoveryTimer); this.recoveryTimer = undefined;
    this.disconnectSocket?.('client closed', false);
    for (const cancel of this.httpReads) cancel();
    for (const p of this.pending.values()) p.reject(new Error('client closed'));
    this.pending.clear();
    this.stopPresencePoll();
    if (this.reachPoll) clearInterval(this.reachPoll);
    this.reachPoll = null;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisible);
      document.removeEventListener('resume', this.onVisible);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onNetworkChange);
      window.removeEventListener('offline', this.onOffline);
      window.removeEventListener('pageshow', this.onVisible);
      window.removeEventListener('focus', this.onVisible);
    }
    this.wantDirect.clear();
    for (const timer of this.directRetry.values()) clearTimeout(timer);
    this.directRetry.clear();
    for (const timer of this.rttTimers.values()) clearInterval(timer);
    this.rttTimers.clear(); this.rttWatchers.clear();
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
  usage(env: string, opts: { model?: string; since?: string; until?: string; by?: string[]; rebuild?: boolean } = {}) {
    return this.rpc<UsageReport>(env, 'usage.report', opts, 120_000);
  }

  /** Pull a machine to the newest helm. It restarts a few seconds after answering. */
  updateEnv(env: string) {
    return this.rpc<{ updated: boolean; reason?: string; restarting?: string[]; failed?: string[] }>(
      env, 'env.update', {}, 140_000);
  }

  /** What a project send would carry, before any grant is minted. */
  transferPreview(env: string, folder: string, includeEnv = false) {
    return this.rpc<TransferPreview>(env, 'transfer.preview', { folder, includeEnv }, 120_000);
  }

  /** Ask the target for the one-time invitation this send will be bound to. */
  transferInvite(env: string, sourceMachineId: string) {
    return this.rpc<{ grant: string; expiresAt: number }>(
      env, 'transfer.invite', { sourceMachineId }, 30_000);
  }

  /** Source-side send: snapshot, sign, seal to the grant key and deliver. */
  transferSend(env: string, params: {
    folder: string; targetMachineId: string; targetFolder?: string;
    includeEnv?: boolean; grant: string; allowSkipped?: boolean;
  }) {
    return this.rpc<TransferResult>(env, 'transfer.send', params, 300_000);
  }

  /** Static setup inspection on the machine holding the folder. Never runs it. */
  transferVerify(env: string, folder: string) {
    return this.rpc<TransferReadiness>(env, 'transfer.verify', { folder }, 60_000);
  }

  rpc<T = any>(env: string, method: string, params: any = {}, timeout = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('client closed'));
    const peer = this.peers.get(env);
    // Tiny persistent settings writes should use the acknowledged hub route
    // when available. An apparently open peer can stop answering after a
    // phone changes networks, leaving a default save waiting until timeout.
    const settingsWrite = ['profile.defaults', 'model.prefs', 'picker.prefs',
      'session.model', 'session.effort', 'session.mode', 'session.speed'].includes(method);
    // Image uploads can fill the data channel's send buffer while its
    // synchronous chunk loop is still running. Use the hub for these writes
    // when connected, choosing the route before sending any prompt bytes.
    const imageUpload = ['session.input', 'session.queue-edit'].includes(method)
      && params.attachments?.some((image: { data?: string }) => (image.data?.length ?? 0) > DC_CHUNK_AT);
    const direct = peer?.ready && peer.channel.readyState === 'open'
      && !((settingsWrite || imageUpload) && this.connected);
    if (!direct && !this.connected) {
      return HTTP_READ_METHODS.has(method)
        ? this.readHttp<T>(env, method, params, timeout)
        : Promise.reject(new Error('not connected'));
    }

    const id = `w${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const started = Date.now();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let fallback: ReturnType<typeof setTimeout> | undefined;
      const clear = () => { clearTimeout(deadline); clearTimeout(fallback); };
      this.pending.set(id, {
        resolve: (value) => { clear(); resolve(value as T); },
        reject: (error) => { clear(); reject(error); },
        ...(direct ? { direct: peer, env } : {}),
        routes: new Set([direct ? 'direct' : 'relay']),
      });
      const frame = JSON.stringify({ t: 'rpc', id, env, method, params });
      // Prefer the direct channel: relaying costs two internet round trips
      // per call, which is what makes a remote session feel dead. A large
      // frame (image attachments, old-chat history) is fragmented; if the
      // direct send fails outright, fall back to the relay in the same call.
      let sent = false;
      if (direct) sent = sendDirect(peer!.channel, frame);
      if (!sent) {
        const pending = this.pending.get(id);
        if (pending) { pending.direct = undefined; pending.routes = new Set(['relay']); }
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
      if (!this.pending.has(id)) return;
      // A suspended laptop can leave a data channel looking open but silent.
      // These reads (and the idempotent view lease) are safe to race over the
      // hub too; never replay prompts, approvals, or other writes this way.
      if (HTTP_READ_METHODS.has(method)) {
        const hedgeAfter = Math.min(1500, timeout / 2);
        const httpFallback = (elapsed: number) => {
          const pending = this.pending.get(id);
          if (!pending || pending.routes?.has('http')) return;
          clearTimeout(fallback);
          pending.recover = undefined;
          pending.hedged = true;
          pending.routes?.add('http');
          this.readHttp<T>(env, method, params, timeout - elapsed).then(
            result => this.receiveRpc({ id, ok: true, result }, 'http'),
            error => this.receiveRpc({ id, ok: false, error }, 'http'),
          );
        };
        this.pending.get(id)!.recover = () => httpFallback(Date.now() - started);
        fallback = setTimeout(() => {
          const pending = this.pending.get(id);
          if (!pending) return;
          pending.hedged = true;
          if (sent && this.connected) {
            pending.routes?.add('relay');
            try {
              this.ws!.send(frame);
              if (this.pending.has(id)) {
                const httpAfter = Math.min(1500, (timeout - hedgeAfter) / 2);
                fallback = setTimeout(() => httpFallback(hedgeAfter + httpAfter), httpAfter);
              }
              return;
            } catch { pending.routes?.delete('relay'); }
          }
          // Some networks pass HTTPS but stall WebSocket traffic, and an
          // apparently open peer can also survive a network change silently.
          httpFallback(hedgeAfter);
        }, hedgeAfter);
      }
      deadline = setTimeout(() => {
        clear();
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
        if (sent && peer) this.dropDirect(env, peer);
      }, timeout);
    });
  }

  private async readHttp<T>(env: string, method: string, params: any, timeout: number): Promise<T> {
    if (this.closed) throw new Error('client closed');
    const bases = [...new Set([this.relay, ...this.endpoints])].filter(Boolean).filter(reachableFromHere);
    if (!bases.length) throw new Error('not connected');
    const body = JSON.stringify({ env, method, params });
    // A reconnect may find another hub while this read is already waiting on
    // an obsolete relay. Race known, eligible endpoints with a short head
    // start for the current one; authentication and the read-only body stay
    // identical. Errors from one hub cannot defeat another hub's success.
    return new Promise<T>((resolve, reject) => {
      let settled = false, next = 0, active = 0;
      let lastError: Error = new Error('not connected');
      let stagger: ReturnType<typeof setTimeout> | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const controllers = new Set<AbortController>();
      const done = (error?: Error, result?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(stagger); clearTimeout(deadline);
        this.httpReads.delete(cancel);
        for (const controller of controllers) controller.abort();
        error ? reject(error) : resolve(result as T);
      };
      const cancel = () => done(new Error('client closed'));
      this.httpReads.add(cancel);
      const launch = () => {
        clearTimeout(stagger); stagger = undefined;
        if (settled) return;
        if (this.closed) { cancel(); return; }
        if (next >= bases.length) { if (!active) done(lastError); return; }
        const base = bases[next++], controller = new AbortController();
        controllers.add(controller); active++;
        this.httpAt<{ result: T }>(base, '/api/read', {
          method: 'POST', body, signal: controller.signal,
        }).then(reply => done(undefined, reply.result)).catch(error => {
          if (settled) return;
          lastError = error; active--;
          controllers.delete(controller);
          if (next < bases.length) launch();
          else if (!active) done(lastError);
        });
        if (next < bases.length) stagger = setTimeout(launch, Math.min(400, Math.max(1, timeout / 2)));
      };
      deadline = setTimeout(() => done(new Error(`${method} timed out`)), timeout);
      launch();
    });
  }

  private receiveRpc(msg: any, route: RpcRoute) {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    pending.routes?.delete(route);
    if (!msg.ok && route === 'relay' && msg.error?.code === 'offline' && pending.recover) {
      pending.recover();
      this.refreshReachability();
      return;
    }
    // The relay may not see a machine that the direct route can reach. An
    // early hedge error must not beat the other route's successful answer.
    if (!msg.ok && pending.routes?.size) return;
    this.pending.delete(msg.id);
    msg.ok ? pending.resolve(msg.result) : pending.reject(new Error(msg.error?.message ?? 'failed'));
    // Retire the unresponsive peer after its fallback succeeds, so the next
    // chat does not pay the same hedge delay again.
    if (msg.ok && route !== 'direct' && pending.hedged && pending.env && pending.direct) {
      this.dropDirect(pending.env, pending.direct);
    }
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
    const negotiation = `${Date.now().toString(36)}-${++this.seq}`;
    const peer: Peer = { pc, channel, ready: false, fragments: new Map(), negotiation, remoteReady: false, candidates: [] };
    let offerSent = false;
    const localCandidates: RTCIceCandidateInit[] = [];
    this.peers.set(env, peer);
    // Failed signalling can leave the browser's peer in "new" forever,
    // which otherwise blocks every retry because peers.has(env) stays true.
    peer.deadline = setTimeout(() => this.dropDirect(env, peer), 15_000);

    pc.onicecandidate = ({ candidate }) => {
      if (!candidate || this.peers.get(env) !== peer) return;
      if (offerSent) this.signal(env, { type: 'candidate', candidate: candidate.toJSON(), negotiation });
      else localCandidates.push(candidate.toJSON());
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        this.dropDirect(env, peer);
      }
    };

    channel.onopen = () => {
      if (this.peers.get(env) !== peer || this.closed) return;
      clearTimeout(peer.deadline);
      peer.ready = true;
      // It worked, so the next failure starts its backoff from scratch.
      this.directWait.delete(env);
      this.emit(env, 'transport', { direct: true });
    };
    channel.onclose = () => this.dropDirect(env, peer);
    channel.onmessage = (ev) => {
      const raw = this.accumulate(peer, ev.data);
      if (raw == null) return;
      let msg: any;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.t === 'rpcResult') {
        this.receiveRpc(msg, 'direct');
        return;
      }
      if (msg.t === 'event') this.deliver(env, msg.kind, msg.payload, msg.eid);
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (this.peers.get(env) === peer) {
        this.signal(env, { type: 'offer', sdp: pc.localDescription!.sdp, negotiation });
        offerSent = true;
        for (const candidate of localCandidates) this.signal(env, { type: 'candidate', candidate, negotiation });
        localCandidates.length = 0;
      }
    } catch { this.dropDirect(env, peer); }
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
    if (payload?.negotiation && payload.negotiation !== peer.negotiation) return;
    if (payload?.type === 'answer') {
      try {
        await peer.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
        if (this.peers.get(env) !== peer) return;
        peer.remoteReady = true;
        for (const candidate of peer.candidates.splice(0)) await peer.pc.addIceCandidate(candidate).catch(() => {});
      } catch { this.dropDirect(env, peer); }
    } else if (payload?.type === 'candidate' && payload.candidate) {
      if (peer.remoteReady) await peer.pc.addIceCandidate(payload.candidate).catch(() => {});
      else if (peer.candidates.length < 128) peer.candidates.push(payload.candidate);
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

  dropDirect(env: string, expected?: Peer) {
    const peer = this.peers.get(env);
    if (!peer || (expected && peer !== expected)) return;
    this.peers.delete(env);
    peer.ready = false;
    clearTimeout(peer.deadline);
    try { peer.channel.close(); peer.pc.close(); } catch { /* already gone */ }
    this.emit(env, 'transport', { direct: false });
    // Losing it is not the end of trying for it.
    this.retryDirect(env);
  }

  // ------------------------------------------------------------- REST helpers

  private async http<T>(path: string, init: RequestInit = {}): Promise<T> {
    return this.httpAt<T>(this.relay, path, init);
  }

  private async httpAt<T>(base: string, path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(20_000),
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

  async environments(): Promise<{ environments: Environment[] }> {
    const hub = this.relay;
    try {
      const result = await this.httpAt<{ machines: Environment[] }>(hub, '/api/machines');
      if (!this.closed && hub !== this.relay) return this.environments();
      if (result.machines.some(machine => !machine.online)) this.refreshReachability();
      return { environments: result.machines };
    } catch (error) {
      if (!this.closed && hub !== this.relay) return this.environments();
      throw error;
    }
  }

  devices(base = this.relay) { return this.httpAt<{ devices: Device[] }>(base, '/api/devices'); }

  /** An invite for adding another machine. Carries the network key. */
  async invite(role: 'pc' | 'vm' | 'nas' = 'pc') {
    // Invites belong to the hub that minted them. A localhost link cannot
    // be redeemed on another computer; mint at a public home and carry that
    // same address, rather than replacing it with a different hub's address.
    const homes = [...new Set([this.relay, ...this.endpoints])].filter((base) => base.startsWith('https://'));
    if (!homes.length) throw new Error('This network needs a reachable HTTPS home. Run helm setup on its always-on VM first.');
    let last: unknown;
    for (const base of homes) {
      try {
        const invite = await this.httpAt<{ code: string; expiresAt: number; role: string; endpoints: string[] }>(
          base, '/api/invite', { method: 'POST', body: JSON.stringify({ role }) });
        return { ...invite, base };
      } catch (error) { last = error; }
    }
    throw last;
  }

  /** Close the pairing window now; devices already paired are untouched. */
  closePairing(base = this.relay) { return this.httpAt(base, '/api/auth/close', { method: 'POST' }); }

  /** A new short-lived password, for signing in another phone or browser. */
  async newPassword(ttlMs?: number) {
    const homes = [...new Set([this.relay, ...this.endpoints])]
      .filter((base) => { try { return !LOOPBACK_HOST.test(new URL(base).hostname); } catch { return false; } })
      .sort((a, b) => Number(!a.startsWith('https://')) - Number(!b.startsWith('https://')));
    let last: unknown;
    for (const base of homes) {
      try {
        const current = await this.devices(base);
        const invite = await this.httpAt<{ password: string; expiresAt: number }>(base, '/api/auth/rotate', {
          method: 'POST', body: JSON.stringify({ ttlMs }),
        });
        return { ...invite, base, knownDeviceIds: current.devices.map((device) => device.id) };
      } catch (error) { last = error; }
    }
    throw last ?? new Error('No address is reachable from another device. Run helm setup on your home first.');
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

  /**
   * What a machine is for, changed by asking the machine itself.
   *
   * Same authorship rule as the name: `kind` lives on the machine's own
   * roster record, which only it may write, so this is an RPC to it rather
   * than an edit at whatever hub answered. Becoming the vm can take a
   * moment - the machine claims an https address before it answers.
   */
  setMachineKind(env: string, kind: 'pc' | 'vm' | 'nas') {
    return this.rpc<{ id: string; kind: string; from?: string; changed: boolean; notes?: string[] }>(
      env, 'machine.set_kind', { kind }, 90_000
    );
  }

  removeMachine(id: string) { return this.http(`/api/machines/${id}`, { method: 'DELETE' }); }
  removeDevice(id: string) { return this.http(`/api/devices/${id}`, { method: 'DELETE' }); }

  // ------------------------------------------------------------- nas media
  //
  // Browsing is ordinary RPC - small JSON, fits the channel. The bytes are
  // not carried here at all: a media element speaks real HTTP, so playback
  // is a URL it fetches itself. What it cannot send is an Authorization
  // header, so the URL carries a ticket the nas minted for this device and
  // for itself, good for a few hours and nothing else.

  /** The folders a nas has agreed to serve. */
  mediaRoots(env: string) {
    return this.rpc<{ roots: MediaRoot[] }>(env, 'media.roots', {}, 15_000);
  }

  /** One directory inside a shared folder. */
  mediaList(env: string, root: number, path = '') {
    return this.rpc<{ root: number; path: string; entries: MediaEntry[] }>(
      env, 'media.list', { root, path }, 15_000
    );
  }

  /** Mint the URL credential a media element will send. */
  mediaTicket(env: string) {
    return this.rpc<{ ticket: string; expiresAt: number }>(env, 'media.ticket', {}, 15_000);
  }

  /**
   * The URL a media element plays from.
   *
   * Every hub in the network answers the same /media route, so which one the
   * file comes through is ours to choose: the machine's own hub when the
   * page can reach it - the direct LAN path - and the hub we are attached to
   * when it cannot, which proxies the stream through the network.
   */
  mediaStreamUrl(
    env: Environment,
    opts: { root: number; path: string; ticket: string },
    { direct = true }: { direct?: boolean } = {},
  ) {
    const base = (direct ? env.endpoints?.find(reachableFromHere) : null) ?? this.relay;
    const q = new URLSearchParams({ root: String(opts.root), path: opts.path, t: opts.ticket });
    return `${base}/media/${env.id}/stream?${q}`;
  }

  digests(limit = 50) { return this.http<{ digests: any[] }>(`/api/digests?limit=${limit}`); }

  /** The hub's VAPID public key: what a browser checks push signatures against. */
  pushKey() { return this.http<{ key: string }>('/api/push/key'); }

  /** Remember where to reach this browser when the app is closed. */
  /**
   * A Helm window on this computer, held open at its own hub: says what it
   * shows, and comes back with a chat to open when a desktop notification is
   * clicked. Only the page's own origin can answer for this computer.
   */
  desktopWait(body: { window: string; focused: boolean; envId: string | null; sessionId: string | null }, signal: AbortSignal) {
    return this.httpAt<{ open: { envId: string | null; sessionId: string | null } | null; desktop: boolean }>(
      location.origin, '/api/desktop/wait', { method: 'POST', body: JSON.stringify(body), signal });
  }

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
  /** Connected to the hub that answered, right now. Not a claim about other hubs. */
  online?: boolean;
  /** When that hub last had it connected; null if it never has since tracking began. */
  lastSeen?: number | null;
}

/**
 * A host that is this computer talking to itself: the whole of what "local"
 * means for a sign-in. Matched whole, never as a prefix - `localhost.evil.com`
 * and `127.evil.com` both start like it, and the hub refuses them for exactly
 * that reason (see `/api/auth/local`). Keep the two in step.
 */
export const LOOPBACK_HOST = /^(127(?:\.\d{1,3}){3}|localhost|\[::1\])$/;

/**
 * Would a secret sent to this address cross a network in the clear?
 *
 * A machine's hub is plain http on its LAN address by design - a phone on the
 * same wifi reaching a laptop directly is the fast path - so this is not an
 * error, and the app says so calmly. It is the one thing worth telling a
 * person before they pair or mint a link on a network they do not own.
 */
export function isCleartext(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && !LOOPBACK_HOST.test(u.hostname);
  } catch { return false; }
}

export const CLEARTEXT_NOTE =
  'This connection is not encrypted. Fine on your own wifi; on a network you do not trust, '
  + 'anyone on it could read what this device sends, including its key.';

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
