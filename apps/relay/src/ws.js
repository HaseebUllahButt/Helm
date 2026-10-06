import { WebSocketServer } from 'ws';
import { beginTransferActivity } from '@helm/protocol/transfer-activity';
import { Duplex } from 'node:stream';
import { T, E, M, PROTOCOL_VERSION } from '@helm/protocol';
import { foldBuckets } from '@helm/usage';
import { q, now, newId } from './db.js';
import {
  loadNetwork, saveNetwork, roster, mergeRoster, rosterHash, watchNetwork,
} from '@helm/protocol/network';
import { fanOut, isNew } from './notify.js';
import { desktop } from './desktop-notify.js';

const HEARTBEAT_MS = 30_000;
// Longer than the CLI's 120s call timeout: the relay must not report a
// failure while the target machine can still complete the operation.
const RPC_TIMEOUT_MS = 130_000;

const HANDOFF_ID = /^[a-f0-9]{24}$/;
const DIGEST = /^[a-f0-9]{64}$/;
// A whole serialized handoff.accept request - the encrypted snapshot is
// almost all of it, so this is sized for a workspace, not a chat line.
const MAX_DISPATCH_BYTES = 80 * 1024 * 1024;
// A target's own answer is bounded too: one receipt, not a dump.
const MAX_DISPATCH_RESULT = 1024 * 1024;
const MAX_DISPATCH_ERROR = 500;
const REDELIVER_MS = 30_000;
// Running means answered; a result that never landed is swept after a
// week, and any row is history after thirty days.
const HANDOFF_RUNNING_TTL = 7 * 24 * 60 * 60 * 1000;
const HANDOFF_TTL = 30 * 24 * 60 * 60 * 1000;

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
  let mesh;
  let meshIds = new Set();
  const reachable = {
    has: (id) => online.has(id) || !!mesh?.machines().has(id),
    get: (id) => online.get(id) ?? mesh?.machines().get(id),
  };

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

  function notifyPresence(envId) {
    const net = loadNetwork();
    const cached = q.stateGet.get(envId);
    const payload = {
      env: envId,
      online: reachable.has(envId),
      info: reachable.get(envId)?.info ?? JSON.parse(cached?.info || '{}'),
      name: net?.machines?.[envId]?.name,
    };
    for (const sock of clients.keys()) send(sock, T.PRESENCE, payload);
    publishHubState();
  }

  function publishHubState(recipient) {
    const net = loadNetwork();
    const machines = [...online].filter(([id]) => !net?.revoked?.[id])
      .map(([id, sock]) => ({ id, info: sock.info }));
    for (const sock of recipient ? [recipient] : online.values()) {
      if (sock.hubSubscriptions) send(sock, T.HUB_STATE, { machines });
    }
  }

  function watchMesh() {
    mesh?.watch(new Set([...clients.values()].flatMap(subs => [...subs])));
  }

  function meshChanged() {
    const next = new Set(mesh?.machines().keys());
    for (const id of new Set([...meshIds, ...next])) {
      if (meshIds.has(id) !== next.has(id)) notifyPresence(id);
    }
    meshIds = next;
  }

  function meshEvent(frame) {
    if (online.has(frame.env) || !mesh?.machines().has(frame.env)) return;
    for (const [sock, subs] of clients) {
      if (subs.has(frame.env)) send(sock, T.EVENT, { ...frame, t: T.EVENT });
    }
  }

  function attachMesh(bridge) {
    mesh = bridge;
    watchMesh();
    meshChanged();
  }

  function meshSignal(frame) {
    const target = signalPeers.get(frame.peer);
    if (target) send(target, frame.kind, { env: frame.env, payload: frame.payload });
  }

  /**
   * The report a machine would have sent, folded from the rollup it last
   * pushed. The buckets keep date, model, engine, account and folder per row,
   * so a stored copy still windows and facets exactly like a live answer -
   * `stale` is what tells the screen it is a memory, not a reading.
   */
  function cachedUsage(envId, params = {}) {
    const row = q.usageGet.get(envId);
    if (!row) return null;
    try {
      const report = foldBuckets(JSON.parse(row.buckets), {
        model: typeof params.model === 'string' ? params.model : null,
        since: params.since ?? null,
        until: params.until ?? null,
        by: Array.isArray(params.by) && params.by.length ? params.by : ['engine', 'model'],
        accounts: JSON.parse(row.accounts || '[]'),
        scan: JSON.parse(row.scan || '{}'),
        at: row.at,
      });
      report.stale = true;
      return report;
    } catch { return null; }
  }

  // -------------------------------------------------------- handoff queue
  //
  // dispatch.submit / dispatch.status are hub-owned methods: the store they
  // read and write is this hub's own. A task lands here from whichever home
  // the source could reach and is handed to the target daemon the next time
  // it connects. The same job may be stored on several hubs and delivered
  // more than once - the target's idempotent accept absorbs that.

  /** What a submit or status call answers with. */
  const queueReceipt = (row) => {
    if (!row) return null;
    const out = {
      handoffId: row.id,
      sourceMachineId: row.source_id,
      targetMachineId: row.target_id,
      snapshotDigest: row.snapshot_digest,
      status: row.status,
      attempts: row.attempts,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.result) {
      try { out.receipt = JSON.parse(row.result); } catch { /* unreadable result is just absent */ }
    }
    if (row.error) out.error = row.error;
    return out;
  };

  const sweepHandoffs = () => {
    const t = now();
    try {
      q.handoffSweep.run(t - HANDOFF_RUNNING_TTL, t - HANDOFF_TTL);
    } catch { /* a store that cannot sweep is no reason to refuse work */ }
  };

  /**
   * Hand a target's waiting tasks to it - on connect, and right after a
   * submit if it happens to be online now. Delivered rows stay queryable as
   * delivered until the daemon's HANDOFF_RESULT lands.
   */
  function deliverPending(targetId) {
    const sock = online.get(targetId);
    if (!sock) return;
    for (const row of q.handoffPending.all(targetId)) {
      let params;
      try { params = JSON.parse(row.payload); } catch { continue; }
      send(sock, T.HANDOFF_JOB, {
        handoffId: row.id, sourceMachineId: row.source_id, params,
      });
      q.handoffDelivered.run(now(), row.id);
    }
  }

  /**
   * The other half of a queued handoff: when the target reports a result,
   * the machine that asked for the work is told where its child session
   * landed. Delivered every time the source connects and each time one of
   * its tasks finishes - no ack exists, but the session link underneath
   * dedupes by handoffId, so repeats cost nothing.
   */
  function deliverCompletions(sourceId) {
    const sock = online.get(sourceId);
    if (!sock) return;
    for (const row of q.handoffCompletions.all(sourceId)) {
      let params; let receipt;
      try {
        params = JSON.parse(row.payload);
        receipt = JSON.parse(row.result);
      } catch { continue; }
      if (!params?.parent?.sessionId) continue;
      if (!receipt?.sessionId || !receipt?.folder || !receipt?.digest) continue;
      send(sock, T.HANDOFF_COMPLETE, {
        handoffId: row.id,
        targetMachineId: row.target_id,
        parentSessionId: params.parent.sessionId,
        title: params.title ?? null,
        receipt,
      });
    }
  }

  /**
   * `dispatch.submit` validation. The params inside the wrapper are opaque
   * to us - the target's own Handoffs validates them fully before acting;
   * here we check only what the queue itself promises: who may submit,
   * which machine the work is for, and that the id/digest/payload are sane.
   */
  function dispatchValidate(sock, wrap) {
    if (!sock.isMachine) {
      throw new Error('a handoff is submitted by a machine of this network only');
    }
    const params = wrap?.params;
    if (!wrap || typeof wrap !== 'object' || !params || typeof params !== 'object') {
      throw new Error('invalid dispatch request');
    }
    const net = loadNetwork();
    if (!net?.machines?.[wrap.targetMachineId] || net?.revoked?.[wrap.targetMachineId]) {
      throw new Error('the dispatch target is not a machine in this network');
    }
    if (params.targetMachineId !== wrap.targetMachineId
        || params.sourceMachineId !== sock.sub
        || !HANDOFF_ID.test(params.handoffId ?? '')) {
      throw new Error('the dispatch wrapper does not match the request inside it');
    }
    if (!DIGEST.test(params.snapshotDigest ?? '')) {
      throw new Error('invalid handoff snapshot digest');
    }
    if (!DIGEST.test(params.requestDigest ?? '')) {
      throw new Error('invalid handoff request digest');
    }
    const payload = JSON.stringify(params);
    if (payload.length > MAX_DISPATCH_BYTES) throw new Error('a handoff is too large to queue');
    return { params, payload, targetId: wrap.targetMachineId };
  }

  function dispatchSubmit(sock, msg) {
    sweepHandoffs();
    const { params, payload, targetId } = dispatchValidate(sock, msg.params);
    const id = params.handoffId;
    let row = q.handoffGet.get(id);
    if (!row) {
      q.handoffInsert.run(
        id, sock.sub, targetId, params.snapshotDigest, payload, now(), now()
      );
    } else {
      // An id belongs to the request that first presented it: a retry
      // repeats it, never replaces the stored payload. The hub cannot
      // recompute the request digest - the fields live inside the opaque
      // payload - so it binds the stored digest the first sender claimed.
      let stored = null;
      try { stored = JSON.parse(row.payload); } catch { /* an unparsable row cannot prove a match */ }
      if (row.source_id !== sock.sub || row.target_id !== targetId
          || row.snapshot_digest !== params.snapshotDigest
          || stored?.requestDigest !== params.requestDigest) {
        throw new Error('dispatch retry does not match its original request');
      }
      if (row.status === 'failed') q.handoffRequeue.run(now(), id);
    }
    deliverPending(targetId);
    return queueReceipt(q.handoffGet.get(id));
  }

  function dispatchStatus(sock, msg) {
    if (!sock.isMachine) {
      throw new Error('a handoff is queried by a machine of this network only');
    }
    const id = msg.params?.handoffId;
    if (!HANDOFF_ID.test(id ?? '')) throw new Error('invalid handoff id');
    const row = q.handoffGet.get(id);
    // The queue answers only the machine that sourced the task.
    if (!row || row.source_id !== sock.sub) throw new Error('unknown handoff');
    return queueReceipt(row);
  }

  // ------------------------------------------------------------- daemon side

  function handleDaemonFrame(sock, msg) {
    const envId = sock.envId;

    switch (msg.t) {
      case T.HUB_SIGNAL: {
        const net = loadNetwork();
        const target = online.get(msg.env);
        if (!target || !net || net.revoked?.[msg.env] || net.revoked?.[msg.device]
            || !(Object.hasOwn(net.devices ?? {}, msg.device) || Object.hasOwn(net.machines, msg.device))
            || typeof msg.peer !== 'string' || msg.peer.length > 128) return;
        sock.hubPeers ??= new Map();
        let proxy = sock.hubPeers.get(msg.peer);
        if (proxy && proxy.sub !== msg.device) return;
        if (!proxy) {
          if (sock.hubPeers.size >= 1024) return;
          proxy = {
            sub: msg.device, peerId: newId(8),
            get readyState() { return sock.readyState; },
            send(raw) {
              const frame = JSON.parse(raw);
              send(sock, T.HUB_SIGNAL, {
                peer: msg.peer, env: frame.env, kind: frame.t, payload: frame.payload,
              });
            },
          };
          sock.hubPeers.set(msg.peer, proxy);
          signalPeers.set(proxy.peerId, proxy);
        }
        send(target, T.SIGNAL, { peer: proxy.peerId, payload: msg.payload, device: msg.device });
        return;
      }

      case T.HUB_SIGNAL_CLOSE: {
        const proxy = sock.hubPeers?.get(msg.peer);
        if (proxy) signalPeers.delete(proxy.peerId);
        sock.hubPeers?.delete(msg.peer);
        return;
      }

      case T.HUB_WATCH: {
        const net = loadNetwork();
        if (!net || net.revoked?.[envId]) return;
        sock.hubSubscriptions = new Set(Array.isArray(msg.envs)
          ? msg.envs.filter(id => net.machines[id] && !net.revoked?.[id]) : []);
        publishHubState(sock);
        return;
      }

      case T.HUB_RPC: {
        const net = loadNetwork();
        if (!net || net.revoked?.[envId] || net.revoked?.[msg.sub]
            || !(Object.hasOwn(net.machines, msg.sub) || Object.hasOwn(net.devices ?? {}, msg.sub))
            || !Object.hasOwn(net.machines, msg.env) || net.revoked?.[msg.env]
            || msg.method === M.DISPATCH_SUBMIT || msg.method === M.DISPATCH_STATUS) {
          return send(sock, T.RPC_RESULT, {
            id: msg.id, ok: false, error: { code: 'forbidden', message: 'invalid forwarded request' },
          });
        }
        return handleClientFrame(sock, { ...msg, t: T.RPC }, { sub: msg.sub, directOnly: true });
      }

      case T.RPC_RESULT: {
        const route = pending.get(msg.id);
        if (!route || route.target !== sock) return;
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
        for (const watcher of online.values()) {
          if (watcher.hubSubscriptions?.has(envId)) send(watcher, T.HUB_EVENT, { ...msg, t: T.HUB_EVENT, env: envId });
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
        // This computer's own Helm app turned notifications on: show them
        // natively and leave its browser subscription out of the push.
        let rows = q.pushAll.all();
        const here = desktop();
        if (here.capable && rows.some((row) => row.local)) {
          rows = rows.filter((row) => !row.local);
          if (payload.resolve || !here.windows.watching(payload.envId, payload.sessionId)) here.notifier.show(payload);
        }
        fanOut(rows, payload, {
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

      case T.USAGE_SYNC: {
        // A machine's whole usage rollup, remembered. This is what keeps a
        // machine that went to sleep inside the total rather than silently
        // zeroing its line - digests have snapshot.json, usage has this.
        if (msg.buckets && typeof msg.buckets === 'object') {
          try {
            q.usageSet.run(
              envId, JSON.stringify(msg.buckets),
              JSON.stringify(msg.accounts ?? []), JSON.stringify(msg.scan ?? {}),
              Number(msg.at) || now(), now()
            );
          } catch { /* a malformed rollup must never kill the connection */ }
        }
        return;
      }

      case T.HANDOFF_RESULT: {
        // Only the machine a task was queued for may answer it, and a row
        // nobody queued is nobody's business.
        const row = q.handoffGet.get(msg.handoffId);
        if (!row || row.target_id !== envId) return;
        if (msg.ok) {
          // A connected target answers for itself, so bound what it may
          // leave in our database rather than trusting its politeness.
          const result = JSON.stringify(msg.receipt ?? null);
          if (result.length > MAX_DISPATCH_RESULT) {
            q.handoffFailed.run('the handoff receipt was too large to store', now(), msg.handoffId);
          } else {
            q.handoffRunning.run(result, now(), msg.handoffId);
            deliverCompletions(row.source_id);
          }
        } else {
          q.handoffFailed.run(
            String(msg.error ?? 'the target refused the handoff')
              .slice(0, MAX_DISPATCH_ERROR),
            now(), msg.handoffId
          );
        }
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
      case T.TUNNEL_ACK:
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

  function handleClientFrame(sock, msg, { sub = sock.sub, directOnly = false } = {}) {
    switch (msg.t) {
      case T.SUBSCRIBE:
        clients.get(sock)?.add(msg.env);
        watchMesh();
        return;

      case T.UNSUBSCRIBE:
        clients.get(sock)?.delete(msg.env);
        watchMesh();
        return;

      case T.RPC: {
        // Hub-owned methods are answered from this hub's own store and are
        // never dispatched to an environment.
        if (msg.method === M.DISPATCH_SUBMIT || msg.method === M.DISPATCH_STATUS) {
          try {
            const result = msg.method === M.DISPATCH_SUBMIT
              ? dispatchSubmit(sock, msg)
              : dispatchStatus(sock, msg);
            send(sock, T.RPC_RESULT, { id: msg.id, ok: true, result });
          } catch (err) {
            send(sock, T.RPC_RESULT, {
              id: msg.id, ok: false,
              error: { code: err.code || 'error', message: String(err?.message || err) },
            });
          }
          return;
        }
        const target = online.get(msg.env);
        if (!target) {
          if (!directOnly && mesh?.machines().has(msg.env)) {
            mesh.call(msg.env, msg.method, msg.params ?? {}, {
              sub, timeout: msg.method === M.TASK_SEND ? 420_000 : RPC_TIMEOUT_MS,
            }).then(result => send(sock, T.RPC_RESULT, { id: msg.id, ok: true, result }),
              error => send(sock, T.RPC_RESULT, {
                id: msg.id, ok: false, error: { code: error.code || 'error', message: error.message },
              }));
            return;
          }
          // A sleeping machine is not zero usage. If it left its rollup with
          // us while it was attached, fold it for the window asked and answer
          // as it would have - marked stale, because it is a memory.
          if (msg.method === M.USAGE_REPORT) {
            const remembered = cachedUsage(msg.env, msg.params);
            if (remembered) {
              return send(sock, T.RPC_RESULT, { id: msg.id, ok: true, result: remembered });
            }
          }
          return send(sock, T.RPC_RESULT, {
            id: msg.id, ok: false,
            error: { code: 'offline', message: 'environment is not connected' },
          });
        }
        const relayId = newId(8);
        pending.set(relayId, { socket: sock, originalId: msg.id, target });
        // Do not let a wedged daemon leak routing entries forever.
        setTimeout(() => {
          if (!pending.delete(relayId)) return;
          send(sock, T.RPC_RESULT, {
            id: msg.id, ok: false,
            error: { code: 'timeout', message: 'daemon did not respond' },
          });
        }, msg.method === M.TASK_SEND ? 420_000 : RPC_TIMEOUT_MS).unref?.();
        send(target, T.RPC, {
          id: relayId, method: msg.method, params: msg.params ?? {},
          // Who is asking travels with the call, so methods that answer
          // "for you" - a media ticket minted for the caller alone - work
          // over the hub exactly as they do over a direct channel.
          sub,
        });
        return;
      }

      case T.SIGNAL: {
        const target = online.get(msg.env);
        if (!target && !mesh?.machines().has(msg.env)) return;
        // Give the daemon a handle it can answer on; the client never needs
        // to know anything about the relay's internal bookkeeping.
        let peer = sock.peerId;
        if (!peer) {
          peer = newId(8);
          sock.peerId = peer;
          signalPeers.set(peer, sock);
        }
        if (!target) return mesh.signal(msg.env, peer, msg.payload, sock.sub);
        // Who is asking travels with the introduction, so the daemon can drop
        // the resulting direct connection if this device is later revoked.
        send(target, T.SIGNAL, { peer, payload: msg.payload, device: sock.sub });
        return;
      }

      case T.TUNNEL_OPEN:
      case T.TUNNEL_ACK:
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
      tunnels.set(sid, { initiator: from, target, initiatorSid: msg.sid, release: beginTransferActivity() });
      from.sidMap ??= new Map();
      from.sidMap.set(msg.sid, sid);
      from.tunnelSids ??= new Set();
      target.tunnelSids ??= new Set();
      from.tunnelSids.add(sid);
      target.tunnelSids.add(sid);
      return send(target, T.TUNNEL_OPEN, { sid, port: msg.port || 22, ...(msg.flow === 1 ? { flow: 1 } : {}) });
    }

    // Translate whichever direction this frame came from.
    const relaySid = from.sidMap?.get(msg.sid) ?? msg.sid;
    const tun = tunnels.get(relaySid);
    if (!tun || (from !== tun.initiator && from !== tun.target)) return;

    const fromTarget = from === tun.target;
    const dest = fromTarget ? tun.initiator : tun.target;
    const sid = fromTarget ? tun.initiatorSid : relaySid;
    send(dest, msg.t, { ...msg, sid });

    if (msg.t === T.TUNNEL_CLOSE) {
      tun.release();
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
      tun.release();
      tunnels.delete(sid);
    }
  }

  // ------------------------------------------------------------------ server

  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: {
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      concurrencyLimit: 4,
      threshold: 1024,
    },
    // The web app offers ("helm", <token>): answer "helm" so the browser
    // accepts the handshake, without ever echoing the token back.
    handleProtocols: (protocols) => (protocols.has('helm') ? 'helm' : false),
  });

  wss.on('connection', (sock, req, auth) => {
    // Protocol/transport errors occur before the JSON message handler. Keep
    // a malformed frame confined to its socket, including normal close cleanup.
    sock.on('error', () => sock.terminate());
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
      // A machine that just connected may have queued handoffs waiting for
      // it; handing them over is part of joining, not a separate command.
      sweepHandoffs();
      deliverPending(envId);
      // A machine that sourced queued work may also have finished children
      // waiting to be linked while it was away.
      deliverCompletions(envId);
    } else {
      sock.sub = auth.sub;
      sock.isMachine = !!auth.machine;
      clients.set(sock, new Set());
      markSeen(sock.sub);
      send(sock, T.WELCOME, { version: PROTOCOL_VERSION, role: 'client' });
    }

    sock.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      // Authenticated traffic is liveness evidence even when a pong is
      // waiting behind file data on a slow connection.
      sock.isAlive = true;
      try {
        if (loadNetwork()?.revoked?.[sock.envId ?? sock.sub]) return;
        if (sock.envId) handleDaemonFrame(sock, msg);
        else handleClientFrame(sock, msg);
      } catch (err) {
        send(sock, T.ERROR, { message: String(err?.message || err) });
      }
    });

    sock.on('close', () => {
      dropTunnelsFor(sock);
      for (const proxy of sock.hubPeers?.values() ?? []) signalPeers.delete(proxy.peerId);
      for (const [id, route] of pending) {
        if (route.socket === sock) pending.delete(id);
        else if (route.target === sock) {
          pending.delete(id);
          send(route.socket, T.RPC_RESULT, {
            id: route.originalId, ok: false,
            error: { code: 'disconnected', message: 'daemon disconnected; delivery may be uncertain' },
          });
        }
      }
      if (sock.envId) {
        if (online.get(sock.envId) === sock) {
          online.delete(sock.envId);
          q.stateSet.run(sock.envId, JSON.stringify(auth.info || {}), now());
          notifyPresence(sock.envId, false);
          broadcastPeers();
        }
      } else {
        clients.delete(sock);
        watchMesh();
        // Leaving is the last moment it was here. Skipped for a member that
        // has just been removed: its socket closing is the kick, and writing
        // a row for it would leave a trace of someone the owner cut.
        if (sock.sub && !loadNetwork()?.revoked?.[sock.sub]) markSeen(sock.sub);
        if (sock.peerId) {
          signalPeers.delete(sock.peerId);
          mesh?.forgetPeer?.(sock.peerId);
        }
      }
    });
  });

  /** Remember that this member was connected to this hub just now. */
  function markSeen(id) {
    try { q.seenSet.run(id, now()); } catch { /* presence is a courtesy */ }
  }

  /** Who holds an open client socket to this hub right now. */
  function connectedDevices() {
    const ids = new Set();
    for (const sock of clients.keys()) if (sock.sub) ids.add(sock.sub);
    return ids;
  }

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
      if (!sock.isAlive) {
        console.warn(`[helm] heartbeat timed out for ${sock.envId ?? sock.sub ?? 'connection'}`);
        sock.terminate(); continue;
      }
      sock.isAlive = false;
      sock.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  // A delivered row stays pending until its result lands, so resending the
  // pending set recovers a job frame lost while the socket stayed open -
  // the target's idempotent accept absorbs every duplicate.
  const redeliver = setInterval(() => {
    for (const id of online.keys()) deliverPending(id);
  }, REDELIVER_MS);
  redeliver.unref?.();

  // A roster that changed here - a login, a removal from the app or the CLI, a
  // merge from another hub - is news to every machine attached to us, and they
  // used to hear it only when their own 15s tick came round. Offer the
  // fingerprint now; a machine that disagrees answers with its roster, and the
  // usual reconcile does the rest. Anyone just revoked loses their sockets in
  // the same breath rather than at the next heartbeat.
  const stopWatch = watchNetwork((net, hash) => {
    for (const id of Object.keys(net.revoked ?? {})) {
      kick(id);
      // Removed from the CLI or by gossip rather than through this hub's own
      // DELETE: without this its presence row would outlive it for ever.
      try { q.seenDelete.run(id); } catch { /* presence is a courtesy */ }
    }
    for (const sock of online.values()) send(sock, T.ROSTER, { hash });
    meshChanged();
  });

  const stop = () => {
    for (const tunnel of tunnels.values()) tunnel.release();
    tunnels.clear();
    clearInterval(heartbeat);
    clearInterval(redeliver);
    stopWatch();
  };

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
  function callEnv(env, method, params = {}, { timeout = 15_000, sub } = {}) {
    const target = online.get(env);
    if (!target && mesh?.machines().has(env)) return mesh.call(env, method, params, { timeout, sub });
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
      pending.set(relayId, { socket: inner, originalId: id, target });
      send(target, T.RPC, { id: relayId, method, params, sub });
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

  return { wss, online, reachable, attachMesh, meshChanged, meshEvent, meshSignal, connectedDevices, broadcastPeers, kick, routeTunnel, callEnv, openTcp, stop };
}
