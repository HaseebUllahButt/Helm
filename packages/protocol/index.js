// Wire protocol shared by relay, daemon and web client.
//
// Every frame is JSON: { t: <type>, ... }.  The relay is a dumb pipe: it
// authenticates both ends, tracks which environments are online, and forwards
// `rpc` / `rpcResult` / `event` frames between a client and one environment.
// It only interprets the two payloads it owns: durable digests and push
// notifications for subscriptions stored on that hub.

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

  // daemon -> every connected hub. Each hub fans out only to browser
  // subscriptions stored there, so phones and sessions may live on
  // different machines without putting push endpoints in the roster.
  NOTIFY: 'notify',         // { payload: { title, body, tag, envId, sessionId } }

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
  // Renaming goes to the machine being renamed, never to the hub the phone
  // happened to reach: a machine's roster record has exactly one author.
  ENV_RENAME: 'env.rename',        // { name } -> { id, name }
  FS_LIST: 'fs.list',              // { path } -> { path, parent, entries[] }
  FS_ROOTS: 'fs.roots',            // {} -> { roots[] }  (home, recent project dirs)
  FS_MKDIR: 'fs.mkdir',            // { path, name } -> { path }
  PROFILE_LIST: 'profile.list',    // {} -> { profiles[] }
  MODEL_LIST: 'model.list',        // { profileId, id?, all? } -> { default, models[], more?[], prefs?, effort?, efforts? }
  MODEL_PREFS: 'model.prefs',      // { profileId, default, approved[] } -> { prefs }  per-account picker filter
  SESSION_LIST: 'session.list',    // {} -> { sessions[] }
  SESSION_START: 'session.start',  // { cwd, profileId, model?, auto?, effort?, title? } -> { session }
  SESSION_ATTACH: 'session.attach',// { id, cols, rows } -> { session, scrollback }
  SESSION_DETACH: 'session.detach',// { id }
  SESSION_INPUT: 'session.input',  // { id, data }
  SESSION_RESIZE: 'session.resize',// { id, cols, rows }
  SESSION_KILL: 'session.kill',    // { id }
  SESSION_TITLE:   'session.title',  // { id, title } -> { session }  the name the owner typed
  SESSION_ARCHIVE: 'session.archive', // { id, archived? } -> { session }
  DIGEST_LIST: 'digest.list',      // { limit? } -> { digests[] }
  SESSION_KEYS: 'session.keys',    // { id, keys[] }  e.g. ["Enter"], ["C-c"]
  SESSION_MESSAGES: 'session.messages', // { id, limit? } -> { messages[], source }
  // Headless agent sessions: the conversation as helm's own event stream.
  SESSION_EVENTS: 'session.events',   // { id, since?, tail?, before?, limit? } -> { events[], pending[], last, session, hasMore, earlier, firstSeq }
  SESSION_WATCH: 'session.watch',     // { id } -> { ok, last }   start/renew E.SESSION_EVENT pushes
  SESSION_UNWATCH: 'session.unwatch', // { id }
  SESSION_ANSWER: 'session.answer',   // { id, requestId, decision: { option, message?, answers? } }
  SESSION_INTERRUPT: 'session.interrupt', // { id }
  SESSION_MODE: 'session.mode',       // { id, mode } -> { session }
  SESSION_MODEL: 'session.model',
  SESSION_EFFORT: 'session.effort',    // { id, effort } -> { session }
  SESSION_SPEED: 'session.speed',      // { id, speed } -> { session }  codex service tier
  SESSION_INVENTORY: 'session.inventory', // {} -> { live[], recent[] }
  // The brain: one agent for the whole network rather than one per folder.
  BRAIN_DIGEST: 'brain.digest',    // {} -> { name, sessions[] }  this machine's line in the digest
  BRAIN_OPEN: 'brain.open',        // { profileId?, model?, mode? } -> { session }  start or resume it
  BRAIN_SNAPSHOT: 'brain.snapshot',// {} -> { text, snapshot }  the whole network as the brain reads it
  // Speech to text, on a machine that holds the key rather than on the device.
  VOICE_TRANSCRIBE: 'voice.transcribe', // { audio(base64), mime? } -> { text }
  SESSION_COMMANDS: 'session.commands',   // { id } -> { commands: [{name, description, source}] }
  SESSION_RESUME: 'session.resume',// { engine, account, id, cwd } -> { session }
  SESSION_ADOPT: 'session.adopt',  // { paneId } -> { session }  take over a pane
  // A round trip that does nothing, for measuring what one costs. The
  // terminal needs to know: how it draws depends on how far away you are.
  PING: 'ping',                    // {} -> { t }

  SSH_INFO: 'ssh.info',            // {} -> { pubkey, sshUser, sshPort }
};

// -------------------------------------------------------------- event kinds

export const E = {
  // Terminal output, pushed while a viewer is attached.
  //
  // From a pty helm owns this is the raw byte stream, appended as it arrives.
  // From a herdr pane it is the *rendered screen*, sampled: `reset` then means
  // the program redrew and `text` replaces everything rather than being
  // appended.
  SESSION_DATA: 'session.data',     // { id, text, reset? }
  SESSION_EXIT: 'session.exit',     // { id, code }
  SESSION_UPDATE: 'session.update', // { session }
  // The agent wrote to its transcript; a chat view should re-read it.
  SESSION_TRANSCRIPT: 'session.transcript', // { id }
  DIGEST: 'digest',                 // { digest }   pushed as sessions progress
  // A headless session did something; `events` are in sequence order and
  // only flow to clients that called session.watch recently.
  SESSION_EVENT: 'session.event',   // { id, events[] }
};

export const frame = (t, extra = {}) => JSON.stringify({ t, ...extra });
