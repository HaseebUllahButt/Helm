import WebSocket from 'ws';
import { T } from '@helm/protocol';
import { machineToken, allEndpoints } from '@helm/protocol/network';

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
  const token = machineToken(net);
  const failures = [];
  for (const hub of hubUrls(net)) {
    try {
      return await rpcVia(hub, token, env, method, params, timeout);
    } catch (err) {
      failures.push(`${hub}: ${err.message}`);
      // "offline" is the hub telling us the machine is not attached there;
      // another hub may still see it.
      if (!/offline|not connected|reach|ECONN|socket|timed out|401/i.test(err.message)) throw err;
    }
  }
  throw new Error(`could not reach that machine through any hub\n  ${failures.join('\n  ')}`);
}

function rpcVia(hub, token, env, method, params, timeout) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${hub.replace(/^http/, 'ws')}/helm/ws?role=client`, {
      headers: { authorization: `Bearer ${token}` },
      handshakeTimeout: 5000,
    });
    const id = `c${Date.now().toString(36)}`;
    const timer = setTimeout(() => { done(new Error('timed out')); }, timeout);
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already gone */ }
      err ? reject(err) : resolve(value);
    };
    ws.on('open', () => ws.send(JSON.stringify({ t: T.RPC, id, env, method, params })));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.t !== T.RPC_RESULT || msg.id !== id) return;
      msg.ok ? done(null, msg.result) : done(new Error(msg.error?.message || 'failed'));
    });
    ws.on('unexpected-response', (_req, res) => done(new Error(`hub answered ${res.statusCode}`)));
    ws.on('error', (err) => done(new Error(err.message || 'could not reach the hub')));
    ws.on('close', () => done(new Error('hub closed the connection')));
  });
}
