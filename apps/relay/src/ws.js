import { WebSocketServer } from 'ws';
import { Duplex } from 'node:stream';
import { T, E, PROTOCOL_VERSION } from '@helm/protocol';
import { q, now, newId } from './db.js';
import {
  loadNetwork, saveNetwork, roster, mergeRoster, rosterHash,
} from '@helm/protocol/network';
import { fanOut, isNew } from './notify.js';

const HEARTBEAT_MS = 30_000;

export function createWsLayer() {
  /** envId -> socket of the connected daemon */
  const online = new Map();
  /** client socket -> Set<envId> it is watching */
  const clients = new Map();
  /** relayRpcId -> { socket, originalId } so results find their way home */
  const pending = new Map();
  /** tunnel stream id -> { a, b } the two sockets bridged by that stream */
  const tunnels = new Map();
  /** signalling peer id -> client socket, so a daemon can answer an offer */
  const signalPeers = new Map();

  const send = (sock, t, extra) => {
    if (sock?.readyState === 1) sock.send(JSON.stringify({ t, ...extra }));
  };

  /**
   * Every machine needs every other machine's public key for the SSH mesh,
   * and every machine's roster, so a hub that has learned something new
   * passes it on. This is the gossip step: it runs whenever the membership
   * this hub can see changes.
   */
  function broadcastPeers() {
    const net = loadNetwork();
    if (!net) return;
    const peers = Object.values(net.machines)
      .filter((m) => m.pubkey)
      .map((m) => ({
        id: m.id, name: m.name, pubkey: m.pubkey,
        sshUser: m.sshUser, sshPort: m.sshPort ?? 22,
      }));
    const shared = roster(net);
    for (const [id, sock] of online) {
      // A machine does not need its own key in its authorized_keys.
      send(sock, T.PEERS, { peers: peers.filter((p) => p.id !== id), roster: shared });
    }
  }

  function notifyPresence(envId, isOnline) {
    const net = loadNetwork();
    const cached = q.stateGet.get(envId);
    const payload = {
      env: envId,
      online: isOnline,
      info: JSON.parse(cached?.info || '{}'),
      name: net?.machines?.[envId]?.name,
    };
    for (const sock of clients.keys()) send(sock, T.PRESENCE, payload);
  }

  // ------------------------------------------------------------- daemon side

  function handleDaemonFrame(sock, msg) {
    const envId = sock.envId;

    switch (msg.t) {
      case T.RPC_RESULT: {
        const route = pending.get(msg.id);
        if (!route) return;
        pending.delete(msg.id);
        send(route.socket, T.RPC_RESULT, { ...msg, id: route.originalId });
        return;
      }

      case T.EVENT: {
        // Digests are the one payload the relay looks inside: they are the
        // raw material the cross-environment brain reads later.
        if (msg.kind === E.DIGEST && msg.payload?.digest) {
          const d = msg.payload.digest;
          try {
            q.digestInsert.run(
              newId(8), envId, String(d.sessionId ?? ''), d.cwd ?? null,
              d.engine ?? null, d.summary ?? null,
              JSON.stringify(d.state ?? {}), now()
            );
          } catch { /* a malformed digest must never kill the connection */ }
        }
        for (const [sock2, subs] of clients) {
          if (subs.has(envId)) send(sock2, T.EVENT, { ...msg, env: envId });
        }
        return;
      }

      case T.NOTIFY: {
        const payload = msg.payload;
        // A `resolve` frame shares the original notification's tag - it is
        // the "that one is already answered" half of the pair, not a new
        // notification, so it needs no title and must not be deduped away
        // by the tag it is closing.
        if (!payload?.tag || (!payload.resolve && !payload?.title)) return;
        if (!payload.resolve && !isNew(payload.tag)) return;
        fanOut(q.pushAll.all(), payload, {
          drop: (endpoint) => q.pushDelete.run(endpoint),
          log: (line) => console.error(`[helm] ${line}`),
        }).then((sent) => {
          if (sent) console.log(`[helm] push: told ${sent} device${sent === 1 ? '' : 's'} that ${payload.title}`);
        }).catch(() => {});
        return;
      }

      case T.ROSTER: {
        const net = loadNetwork();
        if (!net) return;

        // A fingerprint. Agreeing is the overwhelmingly common case and costs
        // nothing to confirm; echoing the whole roster back every 15 seconds
        // regardless - which is what this used to do - is hundreds of
        // megabytes a year of saying "nothing changed".
        if (msg.hash && !msg.roster) {
          if (msg.hash !== rosterHash(net)) send(sock, T.ROSTER, { roster: roster(net) });
          return;
        }

        // The real thing. Merging may reveal a revocation we had not seen.
        const named = new Map(Object.entries(net.machines).map(([id, m]) => [id, m.name]));
        if (mergeRoster(net, msg.roster)) {
          // Anyone the merge just revoked loses their live sockets now, not
          // whenever the next heartbeat sweep happens to run.
          for (const id of Object.keys(loadNetwork()?.revoked ?? {})) kick(id);
          broadcastPeers();
          // A machine renamed from the app: every phone watching this hub is
          // showing the old name until it happens to reload the list, which
          // it does on presence and on reconnect and otherwise never. This is
          // the moment we learn, so it is the moment to say so.
          for (const [id, m] of Object.entries(loadNetwork()?.machines ?? {})) {
            if (named.has(id) && named.get(id) !== m.name) notifyPresence(id, online.has(id));
          }
        } else if (rosterHash(msg.roster) !== rosterHash(net)) {
          // Nothing to learn from theirs, yet we still disagree - so we know
          // something they do not. Send it, once.
          send(sock, T.ROSTER, { roster: roster(net) });
        }
        return;
      }

      case T.SSH_INFO_REPORT: {
        // A nudge, not a write. A machine's SSH identity and addresses live in
        // its own roster record, authored by that machine and carried here by
        // the ROSTER frame. Writing them from this side - with this hub's
        // clock - is how a machine ends up overwriting its own description
        // with our stale view of it.
        broadcastPeers();
        return;
      }

      case T.SIGNAL:
      case T.SIGNAL_READY: {
        // Opaque to us: hand it to whichever client is negotiating.
        const target = signalPeers.get(msg.peer);
        if (target) send(target, msg.t, { ...msg, env: envId });
        return;
      }

      case T.TUNNEL_READY:
      case T.TUNNEL_DATA:
      case T.TUNNEL_CLOSE:
        return routeTunnel(sock, msg);

      // Both directions run their own liveness check: a half-open socket
      // looks healthy from whichever end is not sending.
      case T.PING:
        return send(sock, T.PONG);

      case T.PONG:
        return;
    }
  }

  // ------------------------------------------------------------- client side

  function handleClientFrame(sock, msg) {
    switch (msg.t) {
      case T.SUBSCRIBE:
        clients.get(sock)?.add(msg.env);
        return;

      case T.UNSUBSCRIBE:
        clients.get(sock)?.delete(msg.env);
        return;

      case T.RPC: {
        const target = online.get(msg.env);
        if (!target) {
          return send(sock, T.RPC_RESULT, {
            id: msg.id, ok: false,
            error: { code: 'offline', message: 'environment is not connected' },
          });
        }
        const relayId = newId(8);
        pending.set(relayId, { socket: sock, originalId: msg.id });
        // Do not let a wedged daemon leak routing entries forever.
        setTimeout(() => {
          if (!pending.delete(relayId)) return;
          send(sock, T.RPC_RESULT, {
            id: msg.id, ok: false,
            error: { code: 'timeout', message: 'daemon did not respond' },
          });
        }, 60_000).unref?.();
        send(target, T.RPC, {
          id: relayId, method: msg.method, params: msg.params ?? {},
          // Who is asking travels with the call, so methods that answer
          // "for you" - a media ticket minted for the caller alone - work
          // over the hub exactly as they do over a direct channel.
          sub: sock.sub,
        });
        return;
      }

      case T.SIGNAL: {
        const target = online.get(msg.env);
        if (!target) return;
        // Give the daemon a handle it can answer on; the client never needs
        // to know anything about the relay's internal bookkeeping.
        let peer = sock.peerId;
        if (!peer) {
          peer = newId(8);
          sock.peerId = peer;
          signalPeers.set(peer, sock);
        }
        // Who is asking travels with the introduction, so the daemon can drop
        // the resulting direct connection if this device is later revoked.
        send(target, T.SIGNAL, { peer, payload: msg.payload, device: sock.sub });
        return;
      }

      case T.TUNNEL_OPEN:
      case T.TUNNEL_DATA:
      case T.TUNNEL_CLOSE:
        return routeTunnel(sock, msg);

      // Both directions run their own liveness check: a half-open socket
      // looks healthy from whichever end is not sending.
      case T.PING:
        return send(sock, T.PONG);

      case T.PONG:
        return;
    }
  }

  // ----------------------------------------------------------------- tunnels

  function routeTunnel(from, msg) {
    if (msg.t === T.TUNNEL_OPEN) {
      // ssh knows environments by the Host alias, which is the name; resolve
      // it to an id so `ssh laptop` works without the caller knowing ids.
      let envId = msg.env;
      if (!online.has(envId)) {
        const net = loadNetwork();
        const match = Object.values(net?.machines ?? {}).find((m) => m.name === msg.env);
        if (match) envId = match.id;
      }
      const target = online.get(envId);
      if (!target) {
        return send(from, T.TUNNEL_CLOSE, { sid: msg.sid, reason: 'offline' });
      }

      // The stream gets a relay-scoped id so two initiators cannot collide on
      // the target. The initiator keeps using its own id and we translate,
      // which means neither side has to learn the other's numbering.
      const sid = newId(8);
      tunnels.set(sid, { initiator: from, target, initiatorSid: msg.sid });
      from.sidMap ??= new Map();
      from.sidMap.set(msg.sid, sid);
      from.tunnelSids ??= new Set();
      target.tunnelSids ??= new Set();
      from.tunnelSids.add(sid);
      target.tunnelSids.add(sid);
      return send(target, T.TUNNEL_OPEN, { sid, port: msg.port || 22 });
    }

    // Translate whichever direction this frame came from.
    const relaySid = from.sidMap?.get(msg.sid) ?? msg.sid;
    const tun = tunnels.get(relaySid);
    if (!tun) return;

    const fromTarget = from === tun.target;
    const dest = fromTarget ? tun.initiator : tun.target;
    const sid = fromTarget ? tun.initiatorSid : relaySid;
    send(dest, msg.t, { ...msg, sid });

    if (msg.t === T.TUNNEL_CLOSE) {
      tunnels.delete(relaySid);
      tun.initiator.sidMap?.delete(tun.initiatorSid);
      tun.initiator.tunnelSids?.delete(relaySid);
      tun.target.tunnelSids?.delete(relaySid);
    }
  }

  function dropTunnelsFor(sock) {
    for (const sid of sock.tunnelSids ?? []) {
      const tun = tunnels.get(sid);
      if (!tun) continue;
      const other = tun.initiator === sock ? tun.target : tun.initiator;
      const otherSid = other === tun.initiator ? tun.initiatorSid : sid;
      send(other, T.TUNNEL_CLOSE, { sid: otherSid, reason: 'peer disconnected' });
      tun.initiator.sidMap?.delete(tun.initiatorSid);
      tunnels.delete(sid);
    }
  }

  // ------------------------------------------------------------------ server

  const wss = new WebSocketServer({
    noServer: true,
    // The web app offers ("helm", <token>): answer "helm" so the browser
    // accepts the handshake, without ever echoing the token back.
    handleProtocols: (protocols) => (protocols.has('helm') ? 'helm' : false),
  });

  wss.on('connection', (sock, req, auth) => {
    sock.isAlive = true;
    sock.on('pong', () => { sock.isAlive = true; });

    if (auth.role === 'env') {
      const envId = auth.env.id;
      // A machine reconnecting supersedes its own stale socket.
      online.get(envId)?.close(4009, 'superseded');
      sock.envId = envId;
      // What the daemon said about itself at attach - host, platform, which
      // terminal backend it has - kept on the socket so anything asking does
      // not need a db read per request.
      sock.info = auth.info || {};
      online.set(envId, sock);
      q.stateSet.run(envId, JSON.stringify(auth.info || {}), now());

      // First time we have seen this machine: write it into our roster so it
      // shows up as somewhere you can work, and so we pass it on to the rest
      // of the network.
      const net = loadNetwork();
      if (net && !net.machines[envId]) {
        net.machines[envId] = {
          id: envId, name: auth.env.name, endpoints: [],
          addedAt: now(),
          // Deliberately the oldest possible stamp: this is a placeholder so
          // the machine shows up immediately, and it must lose to the real
          // description arriving moments later on the ROSTER frame.
          updatedAt: 0,
        };
        saveNetwork(net);
      }
      send(sock, T.WELCOME, {
        version: PROTOCOL_VERSION, envId, name: auth.env.name,
      });
      broadcastPeers();
      notifyPresence(envId, true);
    } else {
      sock.sub = auth.sub;
      clients.set(sock, new Set());
      send(sock, T.WELCOME, { version: PROTOCOL_VERSION, role: 'client' });
    }

    sock.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      try {
        if (sock.envId) handleDaemonFrame(sock, msg);
        else handleClientFrame(sock, msg);
      } catch (err) {
        send(sock, T.ERROR, { message: String(err?.message || err) });
      }
    });

    sock.on('close', () => {
      dropTunnelsFor(sock);
      if (sock.envId) {
        if (online.get(sock.envId) === sock) {
          online.delete(sock.envId);
          q.stateSet.run(sock.envId, JSON.stringify(auth.info || {}), now());
          notifyPresence(sock.envId, false);
          broadcastPeers();
        }
      } else {
        clients.delete(sock);
        if (sock.peerId) signalPeers.delete(sock.peerId);
        for (const [id, route] of pending) {
          if (route.socket === sock) pending.delete(id);
        }
      }
    });
  });

  /**
   * Cut every live connection a member holds, immediately.
   *
   * Authentication happens once, at the upgrade - so without this, a removed
   * device's open socket keeps working until it happens to drop, which makes
   * "remove" a suggestion rather than a decision.
   */
  function kick(id) {
    online.get(id)?.close(4004, 'removed from the network');
    for (const sock of clients.keys()) {
      if (sock.sub === id) sock.close(4004, 'removed from the network');
    }
  }

  const heartbeat = setInterval(() => {
    // Revocations can arrive from anywhere - the CLI writing the roster file,
    // gossip from another hub - so sweep live sockets against the current
    // roster rather than trusting every code path to remember to kick.
    const net = loadNetwork();
    for (const sock of wss.clients) {
      const sub = sock.envId ?? sock.sub;
      if (net && sub && net.revoked[sub]) { kick(sub); continue; }
      if (!sock.isAlive) { sock.terminate(); continue; }
      sock.isAlive = false;
      sock.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  // --------------------------------------------------- the hub itself asking
  //
  // A hub is nobody's client, but it is allowed to originate traffic of its
  // own: answering an HTTP media request for a machine only this hub can see
  // means first asking that machine which port its media is on, then opening
  // a tunnel to it. `inner` is the in-process socket those go over - it
  // implements exactly the surface the RPC router and routeTunnel touch, so
  // the daemon cannot tell it apart from a ws client, and it answers to no
  // one else.
  const inner = {
    readyState: 1,
    sidMap: new Map(),
    tunnelSids: new Set(),
    rpcWaiters: new Map(),
    streamWaiters: new Map(),
    // What every other socket sees on the wire is a serialized frame; this
    // one parses it back, so `send(inner, ...)` routes exactly as it would
    // to a ws - it is a socket in every way that matters to the router.
    send(data) {
      const { t, ...extra } = JSON.parse(data);
      if (t === T.RPC_RESULT) {
        const waiter = inner.rpcWaiters.get(extra.id);
        if (waiter) { inner.rpcWaiters.delete(extra.id); waiter(extra); }
      } else {
        inner.streamWaiters.get(extra.sid)?.(t, extra);
      }
    },
  };

  /** An RPC to a machine's daemon, originated by the hub itself. */
  function callEnv(env, method, params = {}, { timeout = 15_000 } = {}) {
    const target = online.get(env);
    if (!target) return Promise.reject(new Error('environment is not connected'));
    return new Promise((resolve, reject) => {
      const id = newId(8);
      const relayId = newId(8);
      const timer = setTimeout(() => {
        if (!inner.rpcWaiters.delete(id)) return;
        pending.delete(relayId);
        reject(new Error('daemon did not respond'));
      }, timeout);
      timer.unref?.();
      inner.rpcWaiters.set(id, (msg) => {
        clearTimeout(timer);
        msg.ok ? resolve(msg.result)
               : reject(Object.assign(new Error(msg.error?.message || 'rpc failed'), { code: msg.error?.code }));
      });
      pending.set(relayId, { socket: inner, originalId: id });
      send(target, T.RPC, { id: relayId, method, params });
    });
  }

  /**
   * A duplex byte stream to 127.0.0.1:<port> on a machine, over the socket
   * its daemon already holds open - the initiator's half of the same tunnel
   * ssh uses. The daemon still decides which ports it will connect to; this
   * asks, it cannot compel.
   */
  function openTcp(env, port, { timeout = 10_000 } = {}) {
    return new Promise((resolve, reject) => {
      const sid = newId(8);
      let opened = false;
      const stream = new Duplex({
        write(chunk, _enc, cb) {
          routeTunnel(inner, { t: T.TUNNEL_DATA, sid, data: chunk.toString('base64') });
          cb();
        },
        read() {},
      });
      // http.ClientRequest drives these on its socket; over a tunnel they
      // are no-ops, but the calls have to land somewhere. setTimeout must
      // not arm anything: a media stream idles legitimately while paused.
      stream.setNoDelay = () => stream;
      stream.setKeepAlive = () => stream;
      stream.setTimeout = () => stream;
      stream.ref = () => stream;
      stream.unref = () => stream;

      const fail = (err) => {
        inner.streamWaiters.delete(sid);
        routeTunnel(inner, { t: T.TUNNEL_CLOSE, sid });
        if (opened) stream.destroy(err); else reject(err);
      };
      const timer = setTimeout(() => fail(new Error('tunnel timed out')), timeout);
      timer.unref?.();

      inner.streamWaiters.set(sid, (t, msg) => {
        if (t === T.TUNNEL_READY) {
          opened = true;
          clearTimeout(timer);
          resolve(stream);
        } else if (t === T.TUNNEL_DATA) {
          stream.push(Buffer.from(msg.data, 'base64'));
        } else if (t === T.TUNNEL_CLOSE) {
          inner.streamWaiters.delete(sid);
          clearTimeout(timer);
          if (opened) { stream.push(null); }
          else fail(new Error(msg.reason === 'offline' ? 'environment is not connected' : `tunnel closed: ${msg.reason ?? 'closed'}`));
        }
      });

      stream.once('close', () => {
        inner.streamWaiters.delete(sid);
        clearTimeout(timer);
        routeTunnel(inner, { t: T.TUNNEL_CLOSE, sid });
      });

      routeTunnel(inner, { t: T.TUNNEL_OPEN, env, sid, port });
    });
  }

  return { wss, online, broadcastPeers, kick, routeTunnel, callEnv, openTcp };
}
