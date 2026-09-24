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

export async function hubRpc(net, env, method, params = {}, { timeout = 20_000 } = {}) {
  const failures = [];
  for (const hub of hubUrls(net)) {
    try {
      return await rpcVia(hub, net, env, method, params, timeout);
    } catch (err) {
      failures.push(`${hub}: ${err.message}`);
      // "offline" is the hub telling us the machine is not attached there;
      // another hub may still see it.
      if (!/offline|not connected|reach|ECONN|socket|timed out|401/i.test(err.message)) throw err;
    }
  }
  throw new Error(`could not reach that machine through any hub\n  ${failures.join('\n  ')}`);
}

function rpcVia(hub, net, env, method, params, timeout) {
  // helm's protocol lives at /helm/ws now; a hub from before the move still
  // answers at /ws, so a transport failure there is worth one retry.
  const base = hub.replace(/^http/, 'ws');
  return attempt(`${base}/helm/ws?role=client`).catch((err) =>
    err.rpc ? Promise.reject(err) : attempt(`${base}/ws?role=client`));

  // One handshake per socket: the credential it yields is spent on use.
  async function attempt(url) {
    const token = await hubCredential(net, hub);
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: { authorization: `Bearer ${token}` },
        handshakeTimeout: 5000,
      });
      const id = `c${Date.now().toString(36)}`;
      const timer = setTimeout(() => { done(new Error('timed out')); }, timeout);
      let settled = false;
      const done = (err, value, rpc = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch { /* already gone */ }
        if (err) { err.rpc = rpc; reject(err); } else resolve(value);
      };
      ws.on('open', () => ws.send(JSON.stringify({ t: T.RPC, id, env, method, params })));
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.t !== T.RPC_RESULT || msg.id !== id) return;
        msg.ok ? done(null, msg.result) : done(new Error(msg.error?.message || 'failed'), null, true);
      });
      ws.on('unexpected-response', (_req, res) => done(new Error(`hub answered ${res.statusCode}`)));
      ws.on('error', (err) => done(new Error(err.message || 'could not reach the hub')));
      ws.on('close', () => done(new Error('hub closed the connection')));
    });
  }
}
