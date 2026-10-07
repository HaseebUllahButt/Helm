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
  HUB_WATCH: 'hubWatch',
  HUB_STATE: 'hubState',
  HUB_RPC: 'hubRpc',
  HUB_EVENT: 'hubEvent',
  HUB_SIGNAL: 'hubSignal',
  HUB_SIGNAL_CLOSE: 'hubSignalClose',

  // daemon -> relay -> subscribed clients
  EVENT: 'event',           // { env, kind, payload }

  // daemon -> every connected hub. Each hub fans out only to browser
  // subscriptions stored there, so phones and sessions may live on
  // different machines without putting push endpoints in the roster.
  NOTIFY: 'notify',         // { payload: { title, body, tag, envId, sessionId } }
                            //   or { payload: { tag, envId, sessionId, resolve: true } }  close the stale one

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
  TUNNEL_ACK: 'tunnel.ack',       // { sid, bytes } cumulative bytes written; negotiated flow=1
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

  // daemon -> every connected hub, like NOTIFY: the machine's whole usage
  // rollup, so a hub can keep answering for it after it goes to sleep. Small
  // by design - day-by-model rows, never transcript bytes.
  USAGE_SYNC: 'usage.sync',       // { buckets: {key: bucket}, accounts, scan, at }

  // --- durable handoff dispatch ----------------------------------------
  // A handoff stored on a hub is delivered to the target daemon the next
  // time it connects, and answered with the result of the idempotent
  // accept. The same job can arrive from several hubs; the target's
  // handoff record is what makes duplicates harmless.
  HANDOFF_JOB: 'handoff.job',     // hub -> target daemon { handoffId, sourceMachineId, params }
  HANDOFF_RESULT: 'handoff.result', // target daemon -> hub { handoffId, ok, receipt? | error? }
  HANDOFF_COMPLETE: 'handoff.complete', // hub -> source daemon { handoffId, targetMachineId, parentSessionId, receipt, title }
};

// ------------------------------------------------------------- daemon methods
// Methods a client may invoke on an environment's daemon.

// Words that mean "a controller" - a phone or browser driving the machines.
// A controller is not a fourth machine kind and can never become one, or be
// redesignated: it holds a device token rather than the network key, runs no
// daemon, and a machine without a daemon is unreachable by design. The
// refusal is worded as a guarantee, not an error code, because the person
// asking should be sure of it.
export const CONTROLLER_WORDS = ['controller', 'mobile', 'phone', 'browser', 'device'];
export const CONTROLLER_REFUSAL =
  'a controller can never be anything else - it runs nothing; ' +
  'remove it and add a machine instead';

export const M = {
  ENV_INFO: 'env.info',            // {} -> { host, os, arch, uptime, engines }
  // Renaming goes to the machine being renamed, never to the hub the phone
  // happened to reach: a machine's roster record has exactly one author.
  ENV_RENAME: 'env.rename',        // { name } -> { id, name }
  // Pull this machine to the newest helm and restart it. Asked of the machine
  // itself: an update is a git reset and a restart, and only it can do either.
  ENV_UPDATE: 'env.update',        // { replace? } -> { updated, reason?, backup?, restarting?, version }  from GitHub, only when asked
  ENV_BUNDLE: 'env.bundle',        // { have } -> { head, bundle }  this machine's saved version, for another to take
  // What a machine is for ('pc' | 'vm' | 'nas'), asked of the machine itself
  // for the same reason as a rename: `kind` lives on its own roster record.
  MACHINE_SET_KIND: 'machine.set_kind', // { kind, address? } -> { id, kind, from, changed, notes[] }
  // What a session did to its folder, as git sees it.
  GIT_STATUS: 'git.status',        // { cwd } -> { repo, branch?, ahead?, behind?, files[], worktree?, head? }
  GIT_GRAPH: 'git.graph',          // { cwd } -> bounded commit ancestry and live agents by checkout
  GIT_DIFF: 'git.diff',            // { cwd, path } -> { path, diff, truncated }
  GIT_COMMIT: 'git.commit',        // { cwd, hash } -> { hash, subject, body, author, date, parents[], files[] }
  GIT_WORKTREE: 'git.worktree',    // { cwd, name? } -> { path, branch, base }  a sibling checkout on a new branch
  GIT_PR: 'git.pr',                // { cwd } -> the branch's pull request, or null
  GIT_MONITOR: 'git.monitor',      // { cwd, force?, sessionId? } -> GitHub checks, PR, workflows, deployments
  GIT_JOBS: 'git.jobs',            // { cwd, runId } -> jobs and failed steps (read-only)
  GIT_WATCH: 'git.watch',          // { sessionId, on } -> { watching } persists background notifications
  GIT_ACCOUNTS: 'git.accounts',    // { cwd } -> safe gh account names, never tokens
  GIT_ACCOUNT: 'git.account',      // { cwd, login } -> select gh login for this repository, without gh auth switch
  FS_LIST: 'fs.list',              // { path } -> { path, parent, entries[] }
  FS_ROOTS: 'fs.roots',            // {} -> { roots[] }  (home, recent project dirs)
  FS_MKDIR: 'fs.mkdir',            // { path, name } -> { path }
  FS_SEARCH: 'fs.search',          // { query } -> { results[], indexed }  every dir under ~, indexed
  PROJECT_LIST: 'project.list',
  PROJECT_SAVE: 'project.save',
  PROJECT_REMOVE: 'project.remove',
  PROFILE_LIST: 'profile.list',    // {} -> { profiles[] }
  AGENT_LIST: 'agent.list',        // { refresh?, models? } -> { agents[] } credential-free CLI capabilities
  PROFILE_DEFAULTS: 'profile.defaults', // { profileId, effort?, mode?, speed? } -> { defaults }
  MODEL_LIST: 'model.list',        // { profileId, id?, all? } -> { default, models[], more?[], prefs?, effort?, efforts? }
  MODEL_PREFS: 'model.prefs',      // { profileId, default, approved[] } -> { prefs }  per-account picker filter
  PICKER_PREFS: 'picker.prefs',    // { hidden?, last?, favs? } -> { picker }  what the new-session picker shows, shared by every device
  SESSION_LIST: 'session.list',    // {} -> { sessions[] }
  SESSION_START: 'session.start',  // { cwd, profileId, model?, effort?, mode?, speed?, title?, parent? } -> { session }
  SESSION_LINK:  'session.link',   // { id, child } -> { session }  durable parent/child handoff link
  SESSION_DELEGATE: 'session.delegate', // { id?, cwd?, profileId, model?, mode?, effort?, task } -> { session }
  SESSION_DELEGATION_RESULT: 'session.delegation-result', // { id } -> { session, status, complete, output, pending }
  SESSION_DELEGATION_MESSAGE: 'session.delegation-message', // { parentId, id, data } -> { ok }
  SESSION_ATTACH: 'session.attach',// { id, cols, rows } -> { session, scrollback }
  SESSION_CONNECT: 'session.connect', // { id } -> { session }  share one managed provider with CLI and app
  SESSION_DETACH: 'session.detach',// { id }
  SESSION_INPUT: 'session.input',  // { id, data }
  SESSION_RESIZE: 'session.resize',// { id, cols, rows }
  SESSION_KILL: 'session.kill',    // { id }
  SESSION_DISCARD_EMPTY: 'session.discard-empty', // { id } -> { discarded }  safe navigation cleanup
  SESSION_TITLE:   'session.title',  // { id, title } -> { session }  the name the owner typed
  SESSION_ARCHIVE: 'session.archive', // { id, archived? } -> { session }
  SESSION_FORK: 'session.fork',       // { id, turnId } -> { session }  a new thread, as this one was before that message
  DIGEST_LIST: 'digest.list',      // { limit? } -> { digests[] }
  SESSION_KEYS: 'session.keys',    // { id, keys[] }  e.g. ["Enter"], ["C-c"]
  SESSION_MESSAGES: 'session.messages', // { id, limit? } -> { messages[], source }
  // Headless agent sessions: the conversation as helm's own event stream.
  SESSION_EVENTS: 'session.events',   // { id, since?, tail?, before?, limit? } -> { events[], pending[], last, session, hasMore, earlier, firstSeq }
  SESSION_WATCH: 'session.watch',     // { id } -> { ok, last }   start/renew E.SESSION_EVENT pushes
  SESSION_UNWATCH: 'session.unwatch', // { id }
  SESSION_ANSWER: 'session.answer',   // { id, requestId, decision: { option, message?, answers? } }
  SESSION_INTERRUPT: 'session.interrupt', // { id }
  SESSION_DEQUEUE: 'session.dequeue',   // { id, turnId } -> { found, text? }  pull a queued message back
  SESSION_SEND_NOW: 'session.send-now', // { id, turnId } -> { found, sent }  steer a queued message into the live turn
  SESSION_QUEUE_EDIT: 'session.queue-edit',
  SESSION_QUEUE_REORDER: 'session.queue-reorder',
  SESSION_RECOVER: 'session.recover',
  SCHEDULE_LIST: 'schedule.list',
  SCHEDULE_SAVE: 'schedule.save',
  SCHEDULE_DELETE: 'schedule.delete',
  SCHEDULE_RUN: 'schedule.run',
  SESSION_NOTIFY: 'session.notify',       // { id, on } -> { ok }  ping me when this thread finishes
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
  VOICE_KEY: 'voice.key',               // { key } -> { voice }  checked with Groq, then kept in ~/.helm/groq-api-key
  SESSION_COMMANDS: 'session.commands',   // { id } -> { commands: [{name, description, source}] }
  SESSION_RESUME: 'session.resume',// { engine, account, id, cwd } -> { session }
  SESSION_TAKEOVER: 'session.takeover', // { id, cancel? } -> { waiting }  move a CLI open before Helm into a shared terminal
  SESSION_ADOPT: 'session.adopt',  // { paneId } -> { session }  take over a pane
  // What this machine's agents have spent, read from what each CLI already
  // wrote. Pre-aggregated here: a phone over the hub gets day-by-model
  // buckets, never the gigabytes of transcript behind them.
  USAGE_LIMITS: 'usage.limits',    // latest provider-reported windows per account
  USAGE_REPORT: 'usage.report',    // { model?, since?, until?, by?[], rebuild? } -> { totals, daily[], groups[], accounts[], scan }
  // The same scan as a raw bucket map - what a hub stores so it can still
  // answer usage.report for this machine after it disconnects.
  USAGE_BUCKETS: 'usage.buckets',  // { rebuild? } -> { buckets, accounts, scan, at }

  // Code-only handoff. The envelope is end-to-end encrypted to the target's
  // machine key; no provider profile or environment is part of it. The key
  // is only ever *proved*, never sent: code.key is a challenge the target
  // answers with an HMAC over the caller's nonce, which takes holding the
  // private half. Acceptance is one idempotent operation, so a retry after
  // any failure picks the handoff up where it left off rather than
  // materializing the folder or starting the session a second time.
  CODE_KEY: 'code.key',            // { epk, nonce } -> { codePubkey, proof }
  HANDOFF_ACCEPT: 'handoff.accept',// { handoffId, sourceMachineId, targetMachineId, folder?, envelope, snapshotDigest, profileId, model?, mode?, title?, parent?, prompt, requestDigest, sourceSignature } -> receipt
  HANDOFF_STATUS: 'handoff.status',// { handoffId } -> receipt
  TASK_SEND: 'task.send',
  TASK_COLLECT: 'task.collect',
  TASK_RETURNED: 'task.returned',
  TASK_STATUS: 'task.status',
  TASK_RETRY_RETURN: 'task.retry-return',

  TRANSFER_RECEIVE: 'transfer.receive',
  // The controller-driven path: preview on the source, invite on the target,
  // then one signed send from source to target. The device sees choices and
  // receipts - never the snapshot or the grant's private key.
  TRANSFER_PREVIEW: 'transfer.preview',  // { folder, includeEnv? } -> { rootName, digest, preflight }
  TRANSFER_INVITE: 'transfer.invite',    // { sourceMachineId, ttlMs? } -> { grant, expiresAt }
  TRANSFER_SEND: 'transfer.send',        // { folder, targetMachineId, targetFolder?, includeEnv?, grant, allowSkipped? } -> { preflight, receipt }
  TRANSFER_VERIFY: 'transfer.verify',    // { folder } -> readiness
  TRANSFER_ACCEPT: 'transfer.accept',

  // Hub-owned queue operations: a hub intercepts these and answers from its
  // own durable store, so they are never dispatched to an environment. The
  // params the target will eventually run travel whole, unchanged - the hub
  // stores the opaque handoff.accept payload but does not perform it.
  DISPATCH_SUBMIT: 'dispatch.submit', // { targetMachineId, params } -> queue receipt
  DISPATCH_STATUS: 'dispatch.status', // { handoffId } -> queue receipt

  // A machine designated 'nas'. Browsing is RPC (small JSON, fits the
  // channel), but the bytes themselves are not: streaming is real HTTP at
  // /media/<machine>/stream on any hub, which a <video> element can speak
  // directly. `media.ticket` mints the short-lived credential that URL
  // carries, because a media element cannot set an Authorization header.
  // Public links: a name, a local port, maybe a password (protocol/share.js).
  // The hub asks every machine for its list when a link is opened.
  SHARE_LIST: 'share.list',        // {} -> { shares[] }  incl. the password hash, for the hub to check
  SHARE_ADD: 'share.add',          // { name?, port, password? } -> { share }
  SHARE_REMOVE: 'share.remove',    // { name } -> { removed }

  MEDIA_INFO: 'media.info',        // {} -> { kind, port, roots[] }   the media listener's loopback port
  MEDIA_ROOTS: 'media.roots',      // {} -> { roots[] }   the shared-folder allowlist
  MEDIA_ROOT_ADD: 'media.root_add',    // { path } -> { roots[] }
  MEDIA_ROOT_REMOVE: 'media.root_remove', // { path } -> { roots[] }
  MEDIA_LIST: 'media.list',        // { root, path? } -> { root, path, entries[] }
  MEDIA_TICKET: 'media.ticket',    // {} -> { ticket, expiresAt }  scoped to caller + this nas

  // A round trip that does nothing, for measuring what one costs. The
  // terminal needs to know: how it draws depends on how far away you are.
  PING: 'ping',                    // {} -> { t }

  SSH_INFO: 'ssh.info',            // {} -> { pubkey, sshUser, sshPort }
};

// -------------------------------------------------------------- event kinds

export const E = {
  GIT_MONITOR: 'git.monitor',      // { id, snapshot, watching } background GitHub watch update
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
