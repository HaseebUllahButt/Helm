#!/usr/bin/env node
/**
 * The terminal host.
 *
 * con's daemon restarts whenever it is upgraded, and a pty is a child of
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
import { existsSync, unlinkSync, mkdirSync, chmodSync } from 'node:fs';
import { CON_DIR } from '../src/paths.js';
import { Terminals, loadPty, ptyUnavailable } from '../src/pty.js';
import { SOCKET_PATH } from '../src/terminals.js';

/** With nothing left to hold, there is no reason to stay resident. */
const IDLE_EXIT_MS = 60_000;

const terminals = new Terminals();
const clients = new Set();
let idleTimer = null;

const send = (sock, msg) => {
  if (sock.writable) sock.write(JSON.stringify(msg) + '\n');
};
const broadcast = (msg) => { for (const c of clients) send(c, msg); };

terminals.on('data', ({ id, text }) => broadcast({ t: 'data', id, text }));
terminals.on('exit', ({ id, code }) => { broadcast({ t: 'exit', id, code }); armIdleExit(); });

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
    if (terminals.list().length || clients.size) { idleSince = Date.now(); return; }
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
    // Asked to go: close what we hold rather than orphan it. Used by tests
    // and by anything that wants the machine left tidy.
    case 'shutdown':
      setTimeout(() => {
        terminals.closeAll();
        try { unlinkSync(SOCKET_PATH); } catch { /* already gone */ }
        process.exit(0);
      }, 20).unref?.();
      return { ok: true };
    default: throw new Error(`unknown request: ${msg.t}`);
  }
}

mkdirSync(CON_DIR, { recursive: true, mode: 0o700 });
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
  // which terminals survived without having to ask.
  send(sock, { t: 'hello', pty: !!pty, reason: pty ? null : ptyUnavailable(), ids: terminals.list() });

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
  console.error(`[con-terminals] cannot listen on ${SOCKET_PATH}: ${err.message}`);
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
    try { unlinkSync(SOCKET_PATH); } catch { /* already gone */ }
    process.exit(0);
  });
}
