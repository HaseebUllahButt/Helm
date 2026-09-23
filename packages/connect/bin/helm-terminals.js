#!/usr/bin/env node
/**
 * The terminal host.
 *
 * helm's daemon restarts whenever it is upgraded, and a pty is a child of
 * whoever opened it - so terminals used to die with it, taking a running
 * build or a tailed log with them. This process owns them instead. It does
 * almost nothing: hold ptys, keep their scrollback, and pass bytes over a
 * unix socket. The daemon connects, drops away on restart, and reconnects to
 * find everything still running.
 *
 * It must live outside the daemon's cgroup, or systemd kills it along with
 * the service it was started from; `terminals.js` handles that when spawning.
 */
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync, mkdirSync, chmodSync } from 'node:fs';
import { HELM_DIR } from '../src/paths.js';
import { Terminals, loadPty, ptyUnavailable } from '../src/pty.js';
import { SOCKET_PATH } from '../src/terminals.js';

/** With nothing left to hold, there is no reason to stay resident. */
const IDLE_EXIT_MS = 60_000;
/** Per-proc output kept while nobody is attached - a restart's worth, not a history. */
const PROC_BACKLOG_MAX = 256 * 1024;

const terminals = new Terminals();
const clients = new Set();
let idleTimer = null;

/**
 * Headless agent processes - the ACP sessions - held here for the same
 * reason the ptys are: the daemon is restartable, a conversation is not.
 * `procs` maps a session id to { child, errTail, backlog }, where backlog
 * is stdout produced while no client was connected, flushed on the next
 * attach so a turn that finished mid-restart still reports its end.
 */
const procs = new Map();

const send = (sock, msg) => {
  if (sock.writable) sock.write(JSON.stringify(msg) + '\n');
};
const broadcast = (msg) => { for (const c of clients) send(c, msg); };

terminals.on('data', ({ id, text }) => broadcast({ t: 'data', id, text }));
terminals.on('exit', ({ id, code }) => { broadcast({ t: 'exit', id, code }); armIdleExit(); });

function procOut(id, data) {
  if (clients.size === 0) {
    const p = procs.get(id);
    if (p) p.backlog = (p.backlog + data).slice(-PROC_BACKLOG_MAX);
    return;
  }
  broadcast({ t: 'proc.data', id, data });
}

function procOpen(msg) {
  const existing = procs.get(msg.id);
  if (existing) return { ok: true, pid: existing.child.pid, existing: true };
  return new Promise((resolve, reject) => {
    const child = spawn(msg.cmd, msg.args ?? [], {
      cwd: msg.cwd || undefined,
      env: msg.env ? { ...process.env, ...msg.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const proc = { child, errTail: '', backlog: '' };
    let spawned = false;
    procs.set(msg.id, proc);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => procOut(msg.id, d));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { proc.errTail = (proc.errTail + d).slice(-4000); });

    const remove = () => {
      procs.delete(msg.id);
      armIdleExit();
    };
    const reportExit = (code, stderr = null) => {
      remove();
      broadcast({
        t: 'proc.exit', id: msg.id, code,
        stderr: stderr || proc.errTail.trim().split('\n').pop() || null,
      });
    };
    const failBeforeSpawn = (err) => {
      remove();
      reject(new Error(`could not start ${msg.cmd}: ${String(err?.message || err)}`));
    };

    // Do not acknowledge proc.open until Node has emitted `spawn`. An
    // `error` such as ENOENT used to arrive after the success response,
    // leaving the daemon with a pipe for a process that never existed.
    child.once('spawn', () => {
      spawned = true;
      resolve({ ok: true, pid: child.pid });
    });
    child.on('exit', (code) => {
      if (!spawned) return failBeforeSpawn(new Error(`exited before spawn (code ${code})`));
      reportExit(code);
    });
    child.on('error', (err) => {
      if (!spawned) return failBeforeSpawn(err);
      reportExit(-1, String(err?.message || err));
    });
  });
}

function procDrop() {
  for (const p of procs.values()) {
    try { p.child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  procs.clear();
}

/**
 * Leave once there is nothing to hold and nobody attached. A host that
 * outlived its terminals would just be a stray process on the machine.
 */
let idleSince = Date.now();
function armIdleExit() {
  idleSince = Date.now();
  if (idleTimer) return;
  // A repeating check rather than a one-shot timer: a host that missed its
  // arming - a client that vanished without a close, say - would otherwise
  // sit on the machine forever holding nothing.
  idleTimer = setInterval(() => {
    // Our socket is gone - removed with a temp directory, or cleared by
    // somebody starting a replacement. Nothing can ever connect to us again,
    // so holding terminals nobody can reach helps no one.
    if (!existsSync(SOCKET_PATH) && clients.size === 0) {
      terminals.closeAll();
      process.exit(0);
    }
    if (terminals.list().length || procs.size || clients.size) { idleSince = Date.now(); return; }
    if (Date.now() - idleSince < IDLE_EXIT_MS) return;
    try { unlinkSync(SOCKET_PATH); } catch { /* already gone */ }
    process.exit(0);
  }, 15_000);
  idleTimer.unref?.();
}

async function handle(msg) {
  switch (msg.t) {
    case 'open':
      await terminals.open(msg.id, msg);
      return { ok: true };
    case 'view':    return { text: terminals.view(msg.id, msg) };
    case 'renew':   return terminals.renew(msg.id);
    case 'unview':  terminals.unview(msg.id); return { ok: true };
    case 'write':   terminals.write(msg.id, msg.data); return { ok: true };
    case 'resize':  terminals.resize(msg.id, msg.cols, msg.rows); return { ok: true };
    case 'close':   terminals.close(msg.id); armIdleExit(); return { ok: true };
    case 'list':    return { ids: terminals.list() };

    // Pipe-stdio processes, held on the same terms as the ptys.
    case 'proc.open':  return procOpen(msg);
    case 'proc.write': procs.get(msg.id)?.child.stdin.write(msg.data); return { ok: true };
    case 'proc.end':   procs.get(msg.id)?.child.stdin.end(); return { ok: true };
    case 'proc.kill':  procs.get(msg.id)?.child.kill(msg.signal || 'SIGTERM'); return { ok: true };
    case 'proc.list':  return { ids: [...procs.keys()] };
    // Asked to go: close what we hold rather than orphan it. Used by tests
    // and by anything that wants the machine left tidy.
    case 'shutdown':
      setTimeout(() => {
        terminals.closeAll();
        procDrop();
        try { unlinkSync(SOCKET_PATH); } catch { /* already gone */ }
        process.exit(0);
      }, 20).unref?.();
      return { ok: true };
    default: throw new Error(`unknown request: ${msg.t}`);
  }
}

mkdirSync(HELM_DIR, { recursive: true, mode: 0o700 });
// A socket left behind by a host that was killed refuses connections; the
// client unlinks it before spawning us, and this is the second line of
// defence for the case where two hosts race to start.
if (existsSync(SOCKET_PATH)) {
  try { unlinkSync(SOCKET_PATH); } catch { /* not ours to remove */ }
}

const pty = await loadPty();

const server = createServer((sock) => {
  clients.add(sock);
  sock.setNoDelay?.(true);

  // Say what we are straight away, so a daemon that has just restarted knows
  // which terminals and agent processes survived without having to ask - then
  // hand it anything those processes said while nobody was listening.
  send(sock, { t: 'hello', pty: !!pty, reason: pty ? null : ptyUnavailable(), ids: terminals.list(), procs: [...procs.keys()] });
  for (const [id, p] of procs) {
    if (p.backlog) { send(sock, { t: 'proc.data', id, data: p.backlog }); p.backlog = ''; }
  }

  let buffer = '';
  sock.on('data', async (chunk) => {
    buffer += chunk;
    let cut;
    while ((cut = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      try {
        send(sock, { t: 'ok', rid: msg.rid, result: await handle(msg) });
      } catch (err) {
        send(sock, { t: 'err', rid: msg.rid, error: String(err?.message || err) });
      }
    }
  });

  const gone = () => { clients.delete(sock); armIdleExit(); };
  sock.on('close', gone);
  sock.on('error', gone);
});

// Saying why beats dying silently: a client only sees "no host appeared".
server.on('error', (err) => {
  console.error(`[helm-terminals] cannot listen on ${SOCKET_PATH}: ${err.message}`);
  process.exit(1);
});

server.listen(SOCKET_PATH, () => {
  chmodSync(SOCKET_PATH, 0o600);
  // The daemon waits for this line before connecting.
  console.log(JSON.stringify({ ready: true, socket: SOCKET_PATH, pty: !!pty }));
  armIdleExit();
});

// Terminals are the point of this process; going quietly on SIGTERM means
// closing them rather than orphaning ptys nobody can reach.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    terminals.closeAll();
    procDrop();
    try { unlinkSync(SOCKET_PATH); } catch { /* already gone */ }
    process.exit(0);
  });
}
