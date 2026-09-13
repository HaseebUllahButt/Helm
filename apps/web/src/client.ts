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
    usage?: boolean;
    runtime?: { version: string };
  };
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
}

export interface DirEntry { name: string; path: string; isRepo: boolean; skip: boolean }

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
}

/** How long to wait for a hub to answer before writing it off for this attempt. */
const PROBE_MS = 2500;

/** How many addresses to keep for a network. Newest win. */
const MAX_ENDPOINTS = 12;

/**
 * Can this page even try that address? A page served over https is forbidden
 * by the browser from fetching plain-http addresses (mixed content), so
 * probing a LAN hub like `http://192.168.x.x:8787` from the VM-hosted PWA
 * fails every time. Skip those rather than spending a probe timeout on them.
 */
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
  endpoints: string[], token: string
): Promise<{ best: string | null; unauthorized: boolean }> {
  const statuses: number[] = [];
  const probes = endpoints.map(async (base) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PROBE_MS);
    const started = performance.now();
    try {
      const res = await fetch(`${base}/api/network`, {
        signal: ctl.signal,
        headers: { authorization: `Bearer ${token}` },
      });
      statuses.push(res.status);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      return {
        base,
        reach: (body.machines ?? []).filter((m: Environment) => m.online).length,
        elapsed: performance.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  });

  const settled = await Promise.allSettled(probes);
  const up = settled
    .filter((r): r is PromiseFulfilledResult<{ base: string; reach: number; elapsed: number }> =>
      r.status === 'fulfilled')
    .map((r) => r.value);
  const unauthorized = !up.length && statuses.length > 0 && statuses.every((s) => s === 401);
  if (!up.length) return { best: null, unauthorized };

  up.sort((a, b) => b.reach - a.reach || a.elapsed - b.elapsed);
  return { best: up[0].base, unauthorized };
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
    // Coming back to the foreground: the socket is almost certainly dead and
    // the backoff timer may be ten seconds out. Try now.
    if (document.visibilityState === 'visible' && !this.connected && !this.connecting) {
      this.backoff = 500;
      this.connect().catch(() => {});
    }
  };
  /** What the last connection attempt ran into, for the diagnostics line. */
  public lastError = '';

  /** The hub we are currently attached to. */
  public relay: string;

  /** Which machines are currently reachable without going through a hub. */
  directTo(env: string) { return this.peers.get(env)?.ready ?? false; }

  constructor(public endpoints: string[], public token: string) {
    this.relay = endpoints[0];
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisible);
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
      if (this.connected || this.closed) return;
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
      ({ best: hub, unauthorized } =
        await probeEndpoints(this.endpoints.filter(reachableFromHere), this.token));
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
        if (msg.t === 'event') this.emit(msg.env, msg.kind, msg.payload);
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

  /**
   * Remember addresses we did not previously know about.
   *
   * Capped, and newest first. A laptop that travels advertises a different
   * private address on every network it joins, and an uncapped list means
   * every cafe it ever visited gets probed on every single connect - slower
   * every time, forever.
   */
  learn(endpoints: string[]) {
    const merged = [...new Set([...endpoints, ...this.endpoints])].slice(0, MAX_ENDPOINTS);
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
    for (const env of [...this.peers.keys()]) this.dropDirect(env);
    try { this.ws?.close(); } catch { /* already closing */ }
  }

  subscribe(env: string) {
    this.subscribed.add(env);
    if (this.connected) this.ws!.send(JSON.stringify({ t: 'subscribe', env }));
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
      // per call, which is what makes a remote session feel dead.
      direct ? peer!.channel.send(frame) : this.ws!.send(frame);
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
  async openDirect(env: string) {
    if (this.peers.has(env) || !this.connected) return;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const channel = pc.createDataChannel('helm', { ordered: true });
    const peer: Peer = { pc, channel, ready: false };
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
      this.emit(env, 'transport', { direct: true });
    };
    channel.onclose = () => this.dropDirect(env);
    channel.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'rpcResult') {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error?.message ?? 'failed'));
        return;
      }
      if (msg.t === 'event') this.emit(env, msg.kind, msg.payload);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signal(env, { type: 'offer', sdp: pc.localDescription!.sdp });
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

  dropDirect(env: string) {
    const peer = this.peers.get(env);
    if (!peer) return;
    this.peers.delete(env);
    try { peer.channel.close(); peer.pc.close(); } catch { /* already gone */ }
    this.emit(env, 'transport', { direct: false });
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

  removeMachine(id: string) { return this.http(`/api/machines/${id}`, { method: 'DELETE' }); }
  removeDevice(id: string) { return this.http(`/api/devices/${id}`, { method: 'DELETE' }); }

  digests(limit = 50) { return this.http<{ digests: any[] }>(`/api/digests?limit=${limit}`); }
}

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
export async function login(endpoint: string, password: string) {
  const base = endpoint.replace(/\/$/, '');
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password, label: deviceLabel() }),
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
