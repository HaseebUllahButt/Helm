import WebSocket from 'ws';
import { T } from '@con/protocol';
import { requireNetwork, machineToken, allEndpoints } from '@con/protocol/network';

/**
 * ssh ProxyCommand: bridge stdin/stdout to port 22 on another machine.
 *
 * ssh speaks a byte stream on our stdio; we carry those bytes to the target
 * daemon, which connects to its own loopback sshd. Neither end needs a
 * reachable address, so this works from a laptop on cellular to a box behind
 * NAT.
 *
 * Any hub can carry the stream, so we try them in turn - our own first, since
 * a machine on the same network as us is both the fastest route and the one
 * most likely to be up.
 */
export async function proxy(host, port = 22) {
  const net = requireNetwork();
  const token = machineToken(net);
  const hubs = [`http://127.0.0.1:${net.port ?? 8787}`, ...allEndpoints(net)];

  const failures = [];
  for (const hub of hubs) {
    try {
      return await bridge(hub, token, host, port);
    } catch (err) {
      // "offline" means we reached a hub and it told us the target is not
      // there; trying another hub is still worth it, since hubs only see the
      // machines currently attached to them.
      failures.push(`${hub}: ${err.message}`);
    }
  }
  throw new Error(`could not reach "${host}" through any hub\n  ${failures.join('\n  ')}`);
}

function bridge(hub, token, host, port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${hub.replace(/^http/, 'ws')}/ws?role=proxy`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    const sid = `p${Date.now().toString(36)}`;
    let open = false;

    const shutdown = (err) => {
      process.stdin.pause();
      try { ws.close(); } catch { /* already gone */ }
      err ? reject(err) : resolve();
    };

    ws.on('open', () =>
      ws.send(JSON.stringify({ t: T.TUNNEL_OPEN, sid, env: host, port }))
    );

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.t === T.TUNNEL_READY) {
        open = true;
        process.stdin.on('data', (chunk) =>
          ws.send(JSON.stringify({
            t: T.TUNNEL_DATA, sid, data: chunk.toString('base64'),
          }))
        );
        process.stdin.on('end', () => ws.send(JSON.stringify({ t: T.TUNNEL_CLOSE, sid })));
        process.stdin.resume();
        return;
      }

      if (msg.t === T.TUNNEL_DATA && msg.sid === sid) {
        process.stdout.write(Buffer.from(msg.data, 'base64'));
        return;
      }

      if (msg.t === T.TUNNEL_CLOSE) {
        shutdown(open ? null : new Error(msg.reason || 'tunnel refused'));
      }
    });

    ws.on('error', (err) => shutdown(err));
    ws.on('close', () => shutdown(open ? null : new Error('hub closed the tunnel')));
  });
}
