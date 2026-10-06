import { openSync, writeSync, closeSync, readFileSync, watch } from 'node:fs';
import { processArgv, processCwd, processTty } from './procinfo.js';
import { execFileSync } from 'node:child_process';
import { ENGINES } from './engines.js';

/**
 * Moving a CLI that was started before Helm into a terminal both sides share.
 *
 * Nothing can be typed into another program's terminal after the fact, so
 * the conversation moves instead: the same command, account, settings and
 * folder, reopened on the saved conversation inside a terminal the laptop and
 * the app both reach. The rule the whole thing is built around is that the
 * owner's work is never cut off - it switches at the prompt, or right after
 * the step it is on, and picks up with "continue".
 */

/** Exactly how a running CLI was started: what it ran, with which settings, where, on which terminal. */
export function readProcess(pid) {
  const argv = processArgv(pid);
  if (!argv) throw new Error('that CLI is no longer running');
  return { argv, env: processEnv(pid), cwd: processCwd(pid), tty: processTty(pid) };
}

function processEnv(pid) {
  if (process.platform === 'linux') {
    return Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean)
      .map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  }
  // macOS: ps -E appends the environment to the command for the owner's own processes.
  const command = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  const withEnv = execFileSync('ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  const env = {};
  for (const m of withEnv.slice(command.length).matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=(\S*)/g)) env[m[1]] = m[2];
  // Whatever ps could not show comes from Helm's own environment, so the
  // CLI still finds its tools.
  return { ...process.env, ...env };
}

const VALUE_FLAGS = new Set(['--resume', '-r', '--session', '--session-id', '--restore', '--conversation']);

/**
 * The same command, pointed at this conversation. Settings stay; whatever
 * said which conversation to open goes, and so does the opening prompt -
 * reopening must not ask the same thing again.
 */
export function resumeCommand(engine, argv, conversation, openingPrompt = '') {
  const [cmd, ...rest] = argv;
  const args = [];
  const bareFlags = new Set(engine === 'codex' ? ['--last', '--fork'] : ['--continue', '-c', '--fork-session']);
  const said = openingPrompt.trim();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (VALUE_FLAGS.has(a)) { i++; continue; }
    if (bareFlags.has(a) || VALUE_FLAGS.has(a.split('=')[0])) continue;
    if (engine === 'codex' && a === 'resume') { if (rest[i + 1] && !rest[i + 1].startsWith('-')) i++; continue; }
    if (said && a.trim() === said) continue;
    args.push(a);
  }
  const resume = ENGINES[engine].resumeArgs(conversation);
  return { cmd, args: resume[0].startsWith('-') ? [...args, ...resume] : [...resume, ...args] };
}

export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };

/**
 * When it is safe to move: at once if the CLI is at its prompt or asking
 * something, otherwise just after its current step lands in the
 * conversation file - a finished command or edit - so the step it was on
 * is never thrown away. `status()` is the CLI's own word where it has one.
 */
export function safePoint({ status, transcript, signal, pid }) {
  return new Promise((resolve, reject) => {
    let watcher = null, timer = null, done = false;
    const finish = (value, err) => {
      if (done) return;
      done = true;
      watcher?.close(); clearInterval(timer);
      signal?.removeEventListener('abort', aborted);
      err ? reject(err) : resolve(value);
    };
    const aborted = () => finish(null, new Error('cancelled'));
    signal?.addEventListener('abort', aborted);
    const now = status();
    if (now !== 'working') return finish({ wasWorking: false });
    if (!alive(pid)) return finish({ wasWorking: false });
    // A step has landed when the newest record is a tool's result.
    const stepLanded = () => {
      try {
        const tail = readFileSync(transcript, 'utf8').slice(-65_536).trimEnd().split('\n').at(-1);
        const rec = JSON.parse(tail);
        const content = rec.message?.content ?? rec.payload?.content;
        return (rec.type === 'user' && Array.isArray(content) && content.some((b) => b?.type === 'tool_result'))
          || /_output$/.test(rec.payload?.type ?? '');
      } catch { return false; }
    };
    const check = () => {
      if (!alive(pid)) return finish({ wasWorking: false });
      const s = status();
      if (s !== 'working') return finish({ wasWorking: false });
      if (stepLanded()) finish({ wasWorking: true });
    };
    try { watcher = watch(transcript, { persistent: false }, check); } catch { /* polled below */ }
    timer = setInterval(check, 500);
    timer.unref?.();
  });
}

/** Ask it to finish; insist only if it will not. Resolves once it is gone. */
export async function stopProcess(pid, { graceMs = 8000 } = {}) {
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  const deadline = Date.now() + graceMs;
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  while (alive(pid)) await new Promise((r) => setTimeout(r, 50));
}

/** A line in the window the CLI was running in, so nobody wonders where it went. */
export function tellTerminal(tty, text) {
  if (!tty) return false;
  try {
    const fd = openSync(tty, 'w');
    try { writeSync(fd, `\r\n\x1b[2m${text}\x1b[0m\r\n`); } finally { closeSync(fd); }
    return true;
  } catch { return false; }
}
