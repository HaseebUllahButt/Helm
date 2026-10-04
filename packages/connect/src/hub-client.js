import WebSocket from 'ws';
import { T } from '@helm/protocol';
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

export async function hubRpc(net, env, method, params = {}, { timeout = 20_000, direct = false, onRoute } = {}) {
  const failures = [];
  for (const hub of hubUrls(net)) {
    try {
      return await rpcVia(hub, net, env, method, params, timeout, { direct, onRoute });
    } catch (err) {
      failures.push(`${hub}: ${err.message}`);
      // "offline" is the hub telling us the machine is not attached there;
      // another hub may still see it.
      if (err.rpc && !['offline', 'timeout'].includes(err.code)) throw err;
      if (!['offline', 'timeout'].includes(err.code)
          && !/offline|not connected|reach|ECONN|socket|timed out|401/i.test(err.message)) throw err;
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

function rpcVia(hub, net, env, method, params, timeout, { direct = false, onRoute } = {}) {
  // helm's protocol lives at /helm/ws now; a hub from before the move still
  // answers at /ws, so a transport failure there is worth one retry.
  const base = hub.replace(/^http/, 'ws');
  return attempt(`${base}/helm/ws?role=client`).catch((err) =>
    err.rpc ? Promise.reject(err) : attempt(`${base}/ws?role=client`));

  // One handshake per socket: the credential it yields is spent on use.
  async function attempt(url) {
    const token = await hubCredential(net, hub);
    const useDirect = direct && ['transfer.accept', 'handoff.accept', 'task.collect'].includes(method);
    const directModule = useDirect ? await import('./direct-rpc.js').catch(() => null) : null;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { authorization: `Bearer ${token}` },
        handshakeTimeout: 5000,
      });
      const id = `c${Date.now().toString(36)}`;
      const timer = setTimeout(() => { done(new Error('timed out')); }, timeout);
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
