import { randomBytes } from 'node:crypto';
import { parseAgentArgs } from './agent-args.js';
import { AdminPassword, CUT_OFF, SUDO_DIR, saveAdminPassword } from './sudo.js';

export const SUDO_USAGE = 'helm sudo [--reason <text>] -- <command> | password | forget | status | stop [chat]';

/** Errors that mean "Helm is restarting or the link dropped": ask again. */
const LOST = /timed out|timeout|not connected|did not respond|ECONN|socket|closed|offline|unreachable|restarting|starting/i;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `helm sudo`. Agents run `helm sudo -- <command>`: the owner answers on a
 * card, and this prints the command's output and ends with its exit code.
 * The owner runs `password`, `forget`, `status` and `stop` on the machine.
 */
export async function runSudoCommand(args, {
  rpc, self, env = process.env, cwd = process.cwd(), out = process.stdout, err = process.stderr,
  readPassword = readHiddenLine, dir = SUDO_DIR, sudo = 'sudo', signals = process, retryMs = 1000,
} = {}) {
  const { words, options } = parseAgentArgs(args, { values: ['reason', 'machine'], switches: [] });
  const print = (line) => out.write(`${line}\n`);
  const say = (line) => err.write(`${line}\n`);
  const asCommand = args.includes('--');
  const [word] = words;
  if (options.machine) { say('helm sudo --machine is not supported yet. Run helm sudo in a chat on the machine that needs it.'); return 1; }

  if (!asCommand && word === 'password') {
    const typed = await readPassword('Admin password for this machine (it is not shown): ');
    if (!typed?.length) { say('No password typed. Nothing changed.'); return 1; }
    try { await saveAdminPassword(typed, { dir, sudo }); }
    catch (error) { say(error.message); return 1; }
    finally { typed.fill(0); }
    print('Saved. Agents can now ask to run admin commands here. You approve each one in the Helm app.');
    return 0;
  }
  if (!asCommand && word === 'forget') {
    const store = new AdminPassword(dir);
    const had = store.saved();
    store.forget();
    print(had ? 'Helm forgot the admin password on this machine.' : 'No admin password was saved on this machine.');
    return 0;
  }
  if (!asCommand && word === 'status') {
    const s = await rpc(self(), 'sudo.setup', { do: 'status' });
    if (s.supported === false) { print(s.error || 'Admin commands are not supported on this machine.'); return 0; }
    print(s.root ? 'Helm runs as root here: admin commands need no password.'
      : s.needsPassword === false ? 'sudo needs no password here.'
      : s.saved ? 'An admin password is saved on this machine.' : 'No admin password is saved on this machine. Save one with helm sudo password.');
    if (!s.allows?.length) print('No chat can run admin commands without a card.');
    for (const a of s.allows ?? []) print(`${a.id}${a.title ? ` (${a.title})` : ''}: runs admin commands with no card until ${new Date(a.until).toLocaleTimeString()}.`);
    return 0;
  }
  if (!asCommand && word === 'stop') {
    const chat = words[1] ?? null;
    const before = await rpc(self(), 'sudo.setup', { do: 'status' });
    const match = chat ? (before.allows ?? []).find((a) => a.id === chat || a.id.startsWith(chat)) : null;
    if (chat && !match) { print('That chat has no 15-minute allow.'); return 0; }
    await rpc(self(), 'sudo.setup', { do: 'stop', ...(match ? { sessionId: match.id } : {}) });
    print(match ? 'Ended the 15-minute allow for that chat.' : 'Ended all 15-minute allows on this machine.');
    return 0;
  }
  if (!asCommand) {
    say(words.length ? `Put -- before the command: helm sudo -- ${words.join(' ')}` : `Use: ${SUDO_USAGE}`);
    return 2;
  }

  const sessionId = env.HELM_SESSION_ID || env.HELM_NATIVE_SESSION;
  if (!sessionId) { say('Run helm sudo in a Helm chat. The owner approves each command there.'); return 1; }
  // One word is a full shell line (helm sudo -- "apt update && apt upgrade");
  // several words are quoted as they were given.
  const command = words.length === 1 ? words[0] : words.map(shellQuote).join(' ');
  if (!command.trim()) { say('Give the command to run: helm sudo -- <command>'); return 2; }
  const requestId = `sudo-${randomBytes(12).toString('hex')}`;
  const ask = { sessionId, requestId, command, cwd, ...(options.reason ? { reason: options.reason } : {}) };

  // Every call is asked again after a lost link; only the answers move on.
  let told = false;
  const call = async (method, params, ms) => {
    for (;;) {
      try { return await rpc(self(), method, params, ms); }
      catch (error) {
        if (!LOST.test(error.message ?? '')) throw error;
        if (!told) { say('Helm is not answering. It may be restarting. Waiting for it.'); told = true; }
        await pause(retryMs);
      }
    }
  };

  let stopping = 0, quit = null;
  const stop = (code) => {
    stopping += 1;
    if (stopping === 1) say('Stopping the admin command.');
    // A third Ctrl+C leaves at once; the card or command is told to stop.
    if (stopping >= 3) quit?.(code);
    void rpc(self(), 'sudo.cancel', { requestId }, 10_000).catch(() => {});
  };
  const onInt = () => stop(130);
  const onEnd = (signal) => () => { void rpc(self(), 'sudo.cancel', { requestId }, 5_000).catch(() => {}).finally(() => quit?.(signal === 'SIGHUP' ? 129 : 143)); };
  const onTerm = onEnd('SIGTERM'), onHup = onEnd('SIGHUP');
  signals.on?.('SIGINT', onInt); signals.on?.('SIGTERM', onTerm); signals.on?.('SIGHUP', onHup);
  try {
    return await new Promise((resolve, reject) => {
      quit = resolve;
      (async () => {
        let first = await call('sudo.ask', ask, 30_000);
        if (first.state === 'failed') { say(first.message); return 1; }
        if (first.state === 'lost') { say(first.message || CUT_OFF); return 1; }
        if (first.state === 'asking') say('Waiting for the owner to allow this in the Helm app.');
        let from = 0, ran = first.state === 'running';
        for (;;) {
          const w = await call('sudo.wait', { requestId, from, wait: 20_000 }, 60_000);
          for (const chunk of w.output ?? []) (chunk.s === 'err' ? err : out).write(Buffer.from(chunk.d, 'base64'));
          from = w.next ?? from;
          if (w.state === 'running') { ran = true; continue; }
          if (w.state === 'asking') continue;
          if (w.state === 'unknown') {
            // Helm restarted. A card is asked again with the same id; a
            // command that may have started is never run again.
            if (ran) { say(CUT_OFF); return 1; }
            first = await call('sudo.ask', ask, 30_000);
            if (first.state === 'failed') { say(first.message); return 1; }
            if (first.state === 'lost') { say(first.message || CUT_OFF); return 1; }
            continue;
          }
          if (w.state === 'lost') { say(w.message || CUT_OFF); return 1; }
          if (w.state === 'denied') { say(w.note ? `The owner said no: ${w.note}` : 'The owner said no.'); return 1; }
          if (w.state === 'cancelled') { say(w.message === 'The agent stopped asking.' || stopping ? 'Stopped. The command did not run.' : (w.message || 'Stopped.')); return 130; }
          if (w.state === 'failed') { say(w.message); return 1; }
          if (w.state === 'done') {
            if (w.note) say(`The owner said: ${w.note}`);
            if (w.outputLost) say('Helm restarted after the command ended. Its output is lost.');
            return w.exitCode ?? 1;
          }
          say(`Unexpected answer from Helm: ${w.state}`);
          return 1;
        }
      })().then(resolve, reject);
    });
  } finally {
    signals.off?.('SIGINT', onInt); signals.off?.('SIGTERM', onTerm); signals.off?.('SIGHUP', onHup);
  }
}

/** A word as the shell reads it back. */
export function shellQuote(word) {
  return /^[A-Za-z0-9_\-./:=@%+,]+$/.test(word) ? word : `'${String(word).replace(/'/g, `'\\''`)}'`;
}

/** Read one line without showing it. Not a terminal: read the first line of input. */
export function readHiddenLine(prompt, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve) => {
    const bytes = [];
    const done = (value) => {
      input.off('data', onData); input.off('end', onEnd);
      if (input.isTTY) input.setRawMode(false);
      input.pause();
      if (input.isTTY) output.write('\n');
      resolve(value);
    };
    const onEnd = () => done(Buffer.from(bytes));
    const onData = (chunk) => {
      for (const byte of chunk) {
        if (byte === 3) { bytes.fill(0); done(null); return; }
        if (byte === 13 || byte === 10) { const value = Buffer.from(bytes); bytes.fill(0); done(value); return; }
        if (byte === 127 || byte === 8) { bytes.pop(); continue; }
        bytes.push(byte);
      }
    };
    if (input.isTTY) { output.write(prompt); input.setRawMode(true); }
    input.on('data', onData); input.on('end', onEnd);
    input.resume();
  });
}
