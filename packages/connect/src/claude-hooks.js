import { createConnection, createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { chmodSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELM_DIR } from './paths.js';
import { NATIVE_SOCKET_PATH } from './terminals.js';

/**
 * A Claude started in a terminal, followed and answered through Claude
 * Code's own hooks.
 *
 * Helm already runs the terminal (native-cli.js), so it can type a message
 * into it like the person at the keyboard. What it could not see was what
 * Claude was doing, or answer what it asked. Hooks are Claude's supported
 * way to tell another program both: each one runs a small command with the
 * event on its stdin, and a PermissionRequest hook may print the decision.
 * They are added for this one process with `--settings`, merged with the
 * owner's own hooks rather than replacing them.
 *
 * The question stays on the terminal's screen while the hook waits, so
 * either side can answer it; whichever does first wins, and Claude ends the
 * other's wait.
 */

const hookScript = fileURLToPath(new URL('../bin/helm-claude-hook.js', import.meta.url));

/** Private to this user and this HELM_DIR; the hook is its only client. */
export function hookSocketPath() {
  const tag = createHash('sha256').update(HELM_DIR).digest('hex').slice(0, 10);
  return join(dirname(NATIVE_SOCKET_PATH), `helm-hooks-${tag}.sock`);
}

/** Long enough to answer from a phone after a walk; a timed-out wait just leaves the terminal's question. */
const ANSWER_WAIT_S = 6 * 3600;

/** The `--settings` value that adds Helm's hooks to one Claude process. */
export function hookSettings(node = process.execPath, script = hookScript) {
  const run = (timeout) => [{ type: 'command', command: `${quote(node)} ${quote(script)}`, ...(timeout ? { timeout } : {}) }];
  return JSON.stringify({ hooks: {
    SessionStart: [{ hooks: run() }],
    UserPromptSubmit: [{ hooks: run() }],
    PermissionRequest: [{ matcher: '*', hooks: run(ANSWER_WAIT_S) }],
    PostToolUse: [{ matcher: '*', hooks: run() }],
    Notification: [{ hooks: run() }],
    Stop: [{ hooks: run() }],
    SessionEnd: [{ hooks: run() }],
  } });
}

const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

/**
 * Listen for hooks. `onEvent(native, event, reply)` gets the Helm session id
 * the terminal was opened under, Claude's hook input, and `reply(output)`:
 * the JSON the hook prints, or null for nothing. `reply.onClose(fn)` fires if
 * the hook goes away first - Claude got its answer somewhere else.
 */
export async function startHookServer(onEvent, path = hookSocketPath()) {
  try { unlinkSync(path); } catch { /* none left over */ }
  const server = createServer((socket) => {
    let data = '', handled = false, replied = false;
    const closers = [];
    socket.on('error', () => {});
    socket.on('close', () => { if (!replied) for (const fn of closers) fn(); });
    socket.on('data', (chunk) => {
      if (handled) return;
      data += chunk;
      if (data.length > 2_000_000) { handled = true; socket.destroy(); return; }
      if (!data.includes('\n')) return;
      handled = true;
      let msg;
      try { msg = JSON.parse(data.slice(0, data.indexOf('\n'))); } catch { socket.destroy(); return; }
      const reply = (output) => {
        if (replied) return;
        replied = true;
        socket.end(JSON.stringify({ output: output ?? null }) + '\n');
      };
      reply.onClose = (fn) => closers.push(fn);
      try { onEvent(String(msg.native ?? ''), msg.event ?? {}, reply); }
      catch { reply(null); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  chmodSync(path, 0o600);
  return { server, close: () => { server.close(); try { unlinkSync(path); } catch { /* gone */ } } };
}

/** The hook's side: hand the event over and print whatever comes back. */
export function sendHook(native, event, { path = hookSocketPath(), timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    let input = '', done = false;
    const finish = (value) => { if (done) return; done = true; socket.destroy(); resolve(value); };
    // Only a question waits on a person; everything else is a notice.
    if (event.hook_event_name !== 'PermissionRequest') socket.setTimeout(timeoutMs, () => finish(null));
    socket.on('error', () => finish(null));
    socket.on('connect', () => socket.write(JSON.stringify({ native, event }) + '\n'));
    socket.on('data', (chunk) => {
      input += chunk;
      if (!input.includes('\n')) return;
      try { finish(JSON.parse(input.slice(0, input.indexOf('\n'))).output ?? null); } catch { finish(null); }
    });
    socket.on('close', () => finish(null));
  });
}
