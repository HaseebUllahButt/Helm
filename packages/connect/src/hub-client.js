import WebSocket from 'ws';
import { T, M } from '@helm/protocol';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { hubCredential, allEndpoints } from '@helm/protocol/network';

/**
 * The CLI talking to machines: one RPC through whichever hub answers.
 *
 * A machine's own hub on loopback is tried first - it is the fastest route
 * and the most likely to be up, and it picks the quickest way on from there
 * - then the target machine's own addresses, which reach it with no hub in
 * between, then every other address the roster knows.
 */
export function hubUrls(net, env) {
  const own = env && env !== net.self ? net.machines?.[env]?.endpoints ?? [] : [];
  return [...new Set([`http://127.0.0.1:${net.port ?? 8787}`, ...own, ...allEndpoints(net)])];
}

/** A controller connection, sharing the daemon's provider rather than spawning one. */
export async function connectHub(net, env, { timeout = 20_000 } = {}) {
  const failures = [];
  for (const hub of hubUrls(net, env)) {
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

/**
 * Only known reads and operations with durable duplicate protection may be
 * retried after uncertain delivery. Unknown methods default to one attempt,
 * so adding a new mutation cannot silently acquire replay semantics.
 */
export const REPEATABLE = new Set([
  M.ENV_INFO, M.PING, M.NET_ROUTES, M.SSH_INFO,
  M.FS_LIST, M.FS_ROOTS, M.FS_SEARCH, M.FS_INDEX, M.PROJECT_LIST,
  M.GIT_STATUS, M.GIT_GRAPH, M.GIT_DIFF, M.GIT_FILES, M.GIT_FILE, M.GIT_COMMIT, M.GIT_PR,
  M.GIT_MONITOR, M.GIT_JOBS, M.GIT_ACCOUNTS,
  M.PROFILE_LIST, M.AGENT_LIST, M.MODEL_LIST, M.INTEGRATIONS_LIST,
  M.SESSION_LIST, M.SESSION_MESSAGES, M.SESSION_EVENTS, M.SESSION_VISUAL,
  M.SESSION_COMMANDS, M.SESSION_INVENTORY, M.SESSION_NATIVE_AGENT,
  M.SESSION_WATCH, M.SESSION_UNWATCH, M.DIGEST_LIST,
  M.EXEC_READ, M.BRAIN_DIGEST, M.BRAIN_SNAPSHOT,
  M.SCHEDULE_LIST, M.USAGE_LIMITS, M.USAGE_REPORT, M.USAGE_BUCKETS,
  M.CODE_KEY, M.HANDOFF_STATUS, M.TASK_STATUS,
  M.SEND_PLAN, M.SEND_STATUS, M.SEND_LIST, M.SEND_RECEIPT,
  M.TRANSFER_PREVIEW, M.TRANSFER_VERIFY, M.DISPATCH_STATUS,
  M.SHARE_LIST, M.FORWARD_LIST, M.MEDIA_INFO, M.MEDIA_ROOTS, M.MEDIA_LIST, M.MEDIA_TICKET,
  // These accepts check their durable handoff/transfer identity themselves.
  M.HANDOFF_ACCEPT, M.TRANSFER_ACCEPT,
  // Keyed by the forward's id: a second add or remove changes nothing.
  M.FORWARD_ADD, M.FORWARD_REMOVE,
  M.SESSION_DELIVER,
]);
export const NON_REPEATABLE = new Set(Object.values(M).filter(method => !REPEATABLE.has(method)));

export async function hubRpc(net, env, method, params = {}, { timeout = 20_000, budget = Infinity, direct = false, onRoute } = {}) {
  const failures = [];
  const deadline = Date.now() + budget;
  const once = !REPEATABLE.has(method);
  const urls = hubUrls(net, env);
  for (const [index, hub] of urls.entries()) {
    if (Date.now() >= deadline) break;
    // A finite lookup budget belongs to all routes, including authentication
    // and the legacy path. Leave each remaining address a fair opportunity.
    const routeDeadline = once || !Number.isFinite(deadline) ? deadline
      : Date.now() + Math.max(1, Math.floor((deadline - Date.now()) / (urls.length - index)));
    try {
      return await rpcVia(hub, net, env, method, params, timeout, { direct, onRoute, deadline: routeDeadline, once });
    } catch (err) {
      // Sent and then lost: the machine may have it already. Asking another
      // hub could do it twice, so the person checks before trying again.
      if (once && err.uncertain) {
        throw Object.assign(new Error(`${err.message}; the request may already have been delivered - check before retrying`),
          { code: err.code, rpc: err.rpc, sent: true, uncertain: true });
      }
      failures.push(`${hub}: ${err.message}`);
      // "offline" is the hub telling us the machine is not attached there;
      // another hub may still see it.
      if (err.rpc && !['offline', 'timeout'].includes(err.code)) throw err;
      if (!['offline', 'timeout'].includes(err.code)
          && !['AbortError', 'TimeoutError'].includes(err.name)
          && !/offline|not connected|reach|ECONN|socket|timed out|fetch failed|401/i.test(err.message)) throw err;
    }
  }
  // Nothing went out: asking again later cannot do anything twice.
  throw Object.assign(new Error(`could not reach that machine through any hub\n  ${failures.join('\n  ')}`), { code: 'unreachable' });
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

function rpcVia(hub, net, env, method, params, timeout, { direct = false, onRoute, deadline = Infinity, once = false } = {}) {
  // helm's protocol lives at /helm/ws now; a hub from before the move still
  // answers at /ws, so a transport failure there is worth one retry - unless
  // a call that must not run twice already went out.
  const base = hub.replace(/^http/, 'ws');
  return attempt(`${base}/helm/ws?role=client`).catch((err) =>
    err.rpc || (once && err.uncertain) ? Promise.reject(err) : attempt(`${base}/ws?role=client`));

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
      const timer = setTimeout(() => { done(Object.assign(new Error('timed out'), { code: 'timeout' })); }, remaining);
      let settled = false;
      let sent = false;
      let peer;
      const done = (err, value, rpc = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        peer?.close();
        try { ws.close(); } catch { /* already gone */ }
        if (!err) { resolve(value); return; }
        // Once the frame is out, only a clear answer from the hub says
        // what happened; silence or a dropped link leaves it unknown.
        err.rpc = rpc;
        err.sent = sent;
        err.uncertain = sent && (!rpc || ['timeout', 'disconnected'].includes(err.code)
          || /delivery may be uncertain/i.test(err.message));
        reject(err);
      };
      ws.on('open', async () => {
        const frame = { t: T.RPC, id, env, method, params };
        if (directModule) {
          sent = true;
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
          sent = true;
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
