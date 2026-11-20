import { execFile } from 'node:child_process';
import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { HOME } from './paths.js';
import { systemdArg } from './service.js';

const runCommand = promisify(execFile);
const UNIT = 'helm-ollama.service';
export const OLLAMA_CONTEXT = 4096;
export const MODEL_WORK_MS = 60 * 60_000;

function ollamaBinary() {
  for (const dir of [join(HOME, '.local/bin'), ...(process.env.PATH ?? '').split(delimiter)]) {
    if (!isAbsolute(dir)) continue;
    const file = join(dir, 'ollama');
    try { accessSync(file, constants.X_OK); return file; } catch { /* try the next folder */ }
  }
  return null;
}

export function ollamaUnit(binary, port) {
  return `[Unit]
Description=Ollama for Helm

[Service]
ExecStart=${systemdArg(binary)} serve
Environment=OLLAMA_HOST=127.0.0.1:${port}
Environment=OLLAMA_NO_CLOUD=1
Environment=OLLAMA_CONTEXT_LENGTH=${OLLAMA_CONTEXT}
Environment=OLLAMA_KEEP_ALIVE=-1
Restart=on-failure

[Install]
WantedBy=default.target
`;
}

/** Use an installed binary. Only the owner can authorize its installation. */
export async function ensureOllamaService(port, {
  run = runCommand, binary = ollamaBinary(), platform = process.platform,
  dir = join(process.env.XDG_CONFIG_HOME || join(HOME, '.config'), 'systemd/user'),
  allowService = process.env.HELM_NO_SERVICE !== '1', fetcher = fetch,
} = {}) {
  if (platform !== 'linux') throw new Error('Choose a Linux machine with a systemd user service to serve a model.');
  if (!allowService) throw new Error('This Helm copy has user services turned off.');
  if (!binary) throw new Error('Install Ollama on this machine after the owner approves. Use helm sudo for any admin commands. Then run helm models serve again.');
  const ctl = (...args) => run('systemctl', ['--user', ...args], { timeout: 20_000 });
  const file = join(dir, UNIT);
  const unit = ollamaUnit(binary, port);
  try {
    let before;
    try { before = readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (before !== unit) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(file, unit, { mode: 0o600 });
      await ctl('daemon-reload');
    }
    await ctl('enable', '--now', UNIT);
  } catch (error) {
    throw new Error(`Could not enable the Ollama user service. ${String(error.stderr || error.message).trim()}`);
  }
  const deadline = Date.now() + 15_000;
  do {
    try { await ollamaJson(port, '/api/version', undefined, { fetcher }); return; }
    catch { /* The service can take a moment to open its port. */ }
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error('The Ollama user service did not answer. Check systemctl --user status helm-ollama.');
}

export async function ollamaJson(port, path, body, { fetcher = fetch, timeout = 4000 } = {}) {
  let reply;
  try {
    reply = await fetcher(`http://127.0.0.1:${port}${path}`, {
      ...(body === undefined ? {} : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
    });
  } catch (cause) {
    throw new Error('The Ollama user service did not answer.', { cause });
  }
  const result = await reply.json();
  if (!reply.ok || result.error) {
    throw Object.assign(new Error(result.error || `Ollama returned HTTP ${reply.status}.`), { status: reply.status });
  }
  return result;
}
