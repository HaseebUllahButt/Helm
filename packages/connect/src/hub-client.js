import WebSocket from 'ws';
import { T } from '@helm/protocol';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { hubCredential, allEndpoints } from '@helm/protocol/network';

/**
 * The CLI talking to machines: one RPC through whichever hub answers.
 *
 * A machine's own hub on loopback is tried first - it is the fastest route
 * and the most likely to be up - then every address the roster knows.
 */
export function hubUrls(net) {
  return [`http://127.0.0.1:${net.port ?? 8787}`, ...allEndpoints(net)];
}

/** A controller connection, sharing the daemon's provider rather than spawning one. */
export async function connectHub(net, env, { timeout = 20_000 } = {}) {
  const failures = [];
  for (const hub of [...new Set(hubUrls(net))]) {
    for (const path of ['/helm/ws', '/ws']) {
      let connection;
      try {
        const token = await hubCredential(net, hub);
        const ws = new WebSocket(`${hub.replace(/^http/, 'ws')}${path}?role=client`, {
          headers: { authorization: `Bearer ${token}` }, handshakeTimeout: timeout,
        });
        connection = new HubConnection(ws, env, timeout);
        await connection.ready;
        ws.send(JSON.stringify({ t: T.SUBSCRIBE, env }));
        // An open hub need not have a route to this machine. Check before
        // creating a session; mutations are never retried on another route.
        await connection.rpc('env.info');
        return connection;
      } catch (error) {
        connection?.close();
        failures.push(`${hub}${path}: ${error.message}`);
      }
    }
  }
  throw new Error(`could not connect to that machine\n  ${failures.join('\n  ')}`);
}

/** Persistent RPC plus subscribed events. Connection loss rejects pending calls. */
export class HubConnection extends EventEmitter {
  #calls = new Map();
  #closed = false;
  constructor(ws, env, timeout = 20_000) {
    super();
    Object.assign(this, { ws, env, timeout });
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('hub handshake timed out')); this.close(); }, timeout);
      const welcome = (frame) => {
        if (frame.t === T.WELCOME) { clearTimeout(timer); this.off('frame', welcome); resolve(); }
      };
      this.on('frame', welcome);
      this.once('disconnect', (error) => { clearTimeout(timer); this.off('frame', welcome); reject(error); });
    });
    ws.on('message', (raw) => {
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      this.emit('frame', frame);
      if (frame.t === T.EVENT && frame.env === env) this.emit('event', frame.kind, frame.payload);
      if (frame.t !== T.RPC_RESULT) return;
      const call = this.#calls.get(frame.id);
      if (!call) return;
      this.#calls.delete(frame.id);
      clearTimeout(call.timer);
      if (frame.ok) call.resolve(frame.result);
      else call.reject(Object.assign(new Error(frame.error?.message || 'RPC failed'), { code: frame.error?.code }));
    });
    ws.on('unexpected-response', (_req, res) => { res.resume(); this.#disconnect(new Error(`hub answered ${res.statusCode}`)); ws.terminate(); });
    ws.on('error', (error) => { this.#disconnect(error); ws.terminate(); });
    ws.on('close', () => this.#disconnect(new Error('hub connection closed')));
  }
  rpc(method, params = {}, timeout = this.timeout) {
    if (this.#closed) return Promise.reject(new Error('hub connection closed'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#calls.delete(id); reject(new Error(`${method} timed out; its result is unknown`)); }, timeout);
      this.#calls.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ t: T.RPC, id, env: this.env, method, params })); }
      catch (error) { clearTimeout(timer); this.#calls.delete(id); reject(error); }
    });
  }
  #disconnect(error) {
    if (this.#closed) return;
    this.#closed = true;
    for (const call of this.#calls.values()) { clearTimeout(call.timer); call.reject(error); }
    this.#calls.clear();
    this.emit('disconnect', error);
  }
  close() {
    this.#disconnect(new Error('hub connection closed'));
    this.ws.close();
  }
}

export async function hubRpc(net, env, method, params = {}, { timeout = 20_000, budget = Infinity, direct = false, onRoute } = {}) {
  const failures = [];
  const deadline = Date.now() + budget;
  for (const hub of hubUrls(net)) {
    if (Date.now() >= deadline) break;
    try {
      return await rpcVia(hub, net, env, method, params, timeout, { direct, onRoute, deadline });
    } catch (err) {
      failures.push(`${hub}: ${err.message}`);
      // "offline" is the hub telling us the machine is not attached there;
      // another hub may still see it.
      if (err.rpc && !['offline', 'timeout'].includes(err.code)) throw err;
      if (!['offline', 'timeout'].includes(err.code)
          && !['AbortError', 'TimeoutError'].includes(err.name)
          && !/offline|not connected|reach|ECONN|socket|timed out|fetch failed|401/i.test(err.message)) throw err;
    }
  }
  throw new Error(`could not reach that machine through any hub\n  ${failures.join('\n  ')}`);
}

/**
 * The same RPC to every home at once, for work that is durable on each hub
 * that takes it. A queued handoff only needs one home to have it; the rest
 * accepting too is free redundancy, and the target's idempotent accept is
 * what makes the resulting duplicate deliveries harmless. Throws only when
 * not a single hub answered.
 */
export async function hubBroadcastRpc(net, env, method, params = {}, { timeout = 20_000, remoteOnly = false } = {}) {
  const successes = [];
  const failures = [];
  const own = new Set(net.machines[net.self]?.endpoints ?? []);
  const urls = remoteOnly
    ? Object.values(net.machines).filter((machine) => machine.id !== net.self && !net.revoked?.[machine.id])
      .flatMap((machine) => machine.endpoints ?? []).filter((url) => !own.has(url))
    : hubUrls(net);
  if (!urls.length) throw new Error('no independent hub is available; keep the source online and retry');
  await Promise.all([...new Set(urls)].map(async (hub) => {
    try {
      successes.push({ hub, value: await rpcVia(hub, net, env, method, params, timeout) });
    } catch (err) {
      failures.push({ hub, error: err });
    }
  }));
  if (!successes.length) {
    throw new Error(
      `could not reach any hub\n  ${failures.map((f) => `${f.hub}: ${f.error.message}`).join('\n  ')}`
    );
  }
  return { successes, failures };
}

/**
 * The furthest-along copy of one queued handoff across the homes that
 * answered. 'failed' ranks lowest on purpose: a stale failure on one hub
 * must not drown a live copy on another - failure only means something
 * when every answering hub agrees on it.
 */
export function mergeQueueReceipts(rows) {
  const rank = { running: 3, delivered: 2, queued: 1, failed: 0 };
  return (rows ?? []).filter(Boolean)
    .sort((a, b) => (rank[b.status] ?? 0) - (rank[a.status] ?? 0))[0] ?? null;
}

function rpcVia(hub, net, env, method, params, timeout, { direct = false, onRoute, deadline = Infinity } = {}) {
  // helm's protocol lives at /helm/ws now; a hub from before the move still
  // answers at /ws, so a transport failure there is worth one retry.
  const base = hub.replace(/^http/, 'ws');
  return attempt(`${base}/helm/ws?role=client`).catch((err) =>
    err.rpc ? Promise.reject(err) : attempt(`${base}/ws?role=client`));

  // One handshake per socket: the credential it yields is spent on use.
  async function attempt(url) {
    if (Date.now() >= deadline) throw new Error('timed out');
    const token = await hubCredential(net, hub, { timeout: Math.min(15_000, deadline - Date.now()) });
    if (Date.now() >= deadline) throw new Error('timed out');
    const remaining = Math.min(timeout, deadline - Date.now());
    const useDirect = direct && ['transfer.accept', 'handoff.accept', 'task.collect'].includes(method);
    const directModule = useDirect ? await import('./direct-rpc.js').catch(() => null) : null;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { authorization: `Bearer ${token}` },
        handshakeTimeout: Math.min(15_000, remaining),
      });
      const id = `c${Date.now().toString(36)}`;
      const timer = setTimeout(() => { done(new Error('timed out')); }, remaining);
      let settled = false;
      let peer;
      const done = (err, value, rpc = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        peer?.close();
        try { ws.close(); } catch { /* already gone */ }
        if (err) { err.rpc = rpc; reject(err); } else resolve(value);
      };
      ws.on('open', async () => {
        const frame = { t: T.RPC, id, env, method, params };
        if (directModule) {
          try {
            peer = directModule.directRpc({
              signal: (payload) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: T.SIGNAL, env, payload })); },
              frame, timeout,
            });
            const result = await peer.result;
            onRoute?.('direct');
            done(null, result);
            return;
          } catch (error) {
            if (error.rpc) { done(error, null, true); return; }
          }
        }
        if (!settled && ws.readyState === WebSocket.OPEN) {
          onRoute?.('relay');
          ws.send(JSON.stringify(frame));
        }
      });
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.t === T.SIGNAL && msg.env === env) { peer?.receive(msg.payload); return; }
        if (msg.t !== T.RPC_RESULT || msg.id !== id) return;
        msg.ok ? done(null, msg.result) : done(Object.assign(new Error(msg.error?.message || 'failed'),
          { code: msg.error?.code }), null, true);
      });
      ws.on('unexpected-response', (_req, res) => done(new Error(`hub answered ${res.statusCode}`)));
      ws.on('error', (err) => done(new Error(err.message || 'could not reach the hub')));
      ws.on('close', () => done(new Error('hub closed the connection')));
    });
  }
}
