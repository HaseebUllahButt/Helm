// Wire protocol shared by relay, daemon and web client.
//
// Every frame is JSON: { t: <type>, ... }.  The relay is a dumb pipe: it
// authenticates both ends, tracks which environments are online, and forwards
// `rpc` / `rpcResult` / `event` frames between a client and one environment.
// It never interprets payloads.

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------- frame types

export const T = {
  // connection lifecycle
  HELLO: 'hello',           // both -> relay, first frame after connect
  WELCOME: 'welcome',       // relay -> both, auth accepted
  ERROR: 'error',
  PING: 'ping',
  PONG: 'pong',

  // client -> relay -> daemon
  RPC: 'rpc',               // { id, env, method, params }
  RPC_RESULT: 'rpcResult',  // { id, ok, result | error }

  // daemon -> relay -> subscribed clients
  EVENT: 'event',           // { env, kind, payload }

  // relay -> client, environment presence changed
  PRESENCE: 'presence',     // { env, online, info }

  // client -> relay
  SUBSCRIBE: 'subscribe',   // { env }
  UNSUBSCRIBE: 'unsubscribe',

  // --- SSH-over-relay tunnelling ---------------------------------------
  // A tunnel carries a raw TCP stream (in practice ssh(1)) from any peer to
  // 127.0.0.1:<port> on a target environment, riding the WebSocket that the
  // target daemon already holds open. Works through NAT because neither end
  // ever accepts an inbound connection.
  TUNNEL_OPEN: 'tunnel.open',     // initiator -> relay -> target { sid, env, port }
  TUNNEL_READY: 'tunnel.ready',   // target -> relay -> initiator { sid }
  TUNNEL_DATA: 'tunnel.data',     // both ways { sid, data:<base64> }
  TUNNEL_CLOSE: 'tunnel.close',   // both ways { sid, reason? }

  // --- WebRTC signalling --------------------------------------------------
  // The relay forwards these verbatim and never inspects them. Once a peer
  // connection is established the terminal stream leaves the relay entirely,
  // which is the difference between ~5ms and ~416ms on a bad route.
  SIGNAL: 'signal',               // client <-> relay <-> daemon { env, peer, payload }
  SIGNAL_READY: 'signal.ready',   // daemon -> relay -> client, P2P is up

  // --- SSH key distribution ---------------------------------------------
  PEERS: 'peers',                 // hub -> daemon { peers: [{ id, name, pubkey, sshUser }], roster }
  SSH_INFO_REPORT: 'ssh.report',  // daemon -> hub { pubkey, sshUser, sshPort, endpoints }

  // --- membership gossip --------------------------------------------------
  // Who is in the network, and what has been revoked. Every machine keeps a
  // full copy; this is how a change made on one of them reaches the rest.
  // Carried on its own frame rather than piggybacked on presence, because a
  // revocation has to propagate even when nothing else about the network has
  // changed.
  ROSTER: 'roster',               // daemon <-> hub { roster }
};

// ------------------------------------------------------------- daemon methods
// Methods a client may invoke on an environment's daemon.

export const M = {
  ENV_INFO: 'env.info',            // {} -> { host, os, arch, uptime, engines }
  FS_LIST: 'fs.list',              // { path } -> { path, parent, entries[] }
  FS_ROOTS: 'fs.roots',            // {} -> { roots[] }  (home, recent project dirs)
  FS_MKDIR: 'fs.mkdir',            // { path, name } -> { path }
  PROFILE_LIST: 'profile.list',    // {} -> { profiles[] }
  SESSION_LIST: 'session.list',    // {} -> { sessions[] }
  SESSION_START: 'session.start',  // { cwd, profileId, title? } -> { session }
  SESSION_ATTACH: 'session.attach',// { id, cols, rows } -> { session, scrollback }
  SESSION_DETACH: 'session.detach',// { id }
  SESSION_INPUT: 'session.input',  // { id, data }
  SESSION_RESIZE: 'session.resize',// { id, cols, rows }
  SESSION_KILL: 'session.kill',    // { id }
  DIGEST_LIST: 'digest.list',      // { limit? } -> { digests[] }
  SESSION_KEYS: 'session.keys',    // { id, keys[] }  e.g. ["Enter"], ["C-c"]
  SESSION_MESSAGES: 'session.messages', // { id, limit? } -> { messages[], source }
  SESSION_INVENTORY: 'session.inventory', // {} -> { live[], recent[] }
  SESSION_RESUME: 'session.resume',// { engine, account, id, cwd } -> { session }
  SESSION_ADOPT: 'session.adopt',  // { paneId } -> { session }  take over a pane
  SSH_INFO: 'ssh.info',            // {} -> { pubkey, sshUser, sshPort }
  USAGE: 'usage.get',              // {} -> { fetchedAt, accounts[] }
  USAGE_HISTORY: 'usage.history',  // { steps? } -> limit-economics analysis
};

// -------------------------------------------------------------- event kinds

export const E = {
  SESSION_DATA: 'session.data',     // { id, data }  raw terminal bytes (base64)
  SESSION_EXIT: 'session.exit',     // { id, code }
  SESSION_UPDATE: 'session.update', // { session }
  DIGEST: 'digest',                 // { digest }   pushed as sessions progress
};

export const frame = (t, extra = {}) => JSON.stringify({ t, ...extra });
