import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELM_DIR, HOME, expand } from './paths.js';
import { NativeHosts } from './terminals.js';
import { ENGINES } from './engines.js';
import { hookSettings } from './claude-hooks.js';

const marker = '# Helm native CLI integration';
const manifestFile = join(HELM_DIR, 'native-cli.json');
const launcher = fileURLToPath(new URL('../bin/helm-native-cli.js', import.meta.url));
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const nativeEngines = Object.values(ENGINES).filter((e) => e.bin && !e.plain && !e.managed).map((e) => e.id);

/** Keep scripts, auth commands and Helm's own drivers on the original path. */
export function interactiveLaunch(engine, args, env = process.env, tty = !!process.stdin.isTTY && !!process.stdout.isTTY) {
  if (!nativeEngines.includes(engine)) return false;
  if (!tty || env.HELM_NATIVE_BYPASS || env.HELM_SESSION_ID || env.HELM_NATIVE_SESSION) return false;
  if (args.some((a) => ['--help', '-h', '--version', '-v', '--print', '-p', '--output-format', '--input-format', '--background', '--bg', '--desktop', '--cloud'].includes(a))) return false;
  // Codex prints its version for -V; elsewhere -V may be an interactive option.
  if (engine === 'codex' && args.includes('-V')) return false;
  // Values following flags must not be mistaken for subcommands or prompts.
  const verbs = engine === 'claude'
    ? ['auth', 'mcp', 'install', 'update', 'doctor', 'remote-control', 'agents', 'attach', 'logs', 'stop', 'rm', 'plugin', 'sync']
    : engine === 'codex'
      ? ['app-server', 'exec', 'e', 'review', 'login', 'logout', 'mcp', 'mcp-server', 'sandbox', 'debug', 'completion', 'features', 'remote-control', 'agents', 'queue', 'archive', 'unarchive', 'delete', 'help', 'apply', 'a', 'cloud']
      : ['auth', 'login', 'logout', 'install', 'uninstall', 'update', 'upgrade', 'doctor', 'help', 'version', 'completion', 'mcp', 'plugin', 'plugins', 'models', 'config', 'acp', 'serve', 'run', 'exec', 'stats', ...(ENGINES[engine].proc?.nonInteractiveSub ?? [])];
  if (verbs.includes(args[0])) return false;
  const flags = ENGINES[engine].proc?.nonInteractiveFlags ?? [];
  return !args.some((arg, i) => flags.includes(arg.split('=')[0])
    && !(arg === '--mode' && (args[i + 1] === 'interactive' || args[i + 1] === 'tui')));
}

const readManifest = () => { try { return JSON.parse(readFileSync(manifestFile, 'utf8')); } catch { return {}; } };
/** Atomic, so a crash or a concurrent reader never sees half a manifest. */
function saveManifest(manifest) {
  mkdirSync(dirname(manifestFile), { recursive: true, mode: 0o700 });
  const tmp = `${manifestFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  renameSync(tmp, manifestFile);
}
const isShim = (path) => {
  try { const st = lstatSync(path); return st.isFile() && st.size < 16_384 && readFileSync(path, 'utf8').includes(marker); }
  catch { return false; }
};

/** Where Helm's own commands live: first on PATH, beside nothing of the CLIs'. */
export const LAUNCHER_DIR = join(HELM_DIR, 'bin');
const RC_START = '# >>> helm: normal CLI commands show up in Helm >>>';
const RC_END = '# <<< helm <<<';

/**
 * Earlier versions replaced the CLI's own command with a launcher and kept
 * the original beside it. A provider's self-update then replaced the
 * launcher, and the link quietly stopped. Put every original back.
 */
function restoreReplacedCommands(manifest = readManifest()) {
  const restored = [];
  for (const [key, spec] of Object.entries(manifest)) {
    if (!spec || typeof spec !== 'object' || !spec.path || !spec.saved) continue;
    try {
      if (existsSync(spec.saved) && (!existsSync(spec.path) || isShim(spec.path))) {
        renameSync(spec.saved, spec.path);
        restored.push(key);
      }
    } catch { continue; }
    delete manifest[key];
  }
  return restored;
}

/** The shell files that set PATH for a terminal, for whichever shells are in use. */
function rcFiles(home) {
  const shell = basename(process.env.SHELL || '');
  const files = [];
  const add = (path, always = false) => { if (always || existsSync(path)) files.push(path); };
  add(join(home, '.bashrc'), shell === 'bash');
  // Login shells read the first existing login file after /etc/profile.
  // Install at its end too: a PATH change after sourcing .bashrc otherwise
  // puts the original provider ahead of Helm and silently bypasses sharing.
  if (shell === 'bash' || existsSync(join(home, '.bashrc'))) {
    const login = ['.bash_profile', '.bash_login', '.profile']
      .map((name) => join(home, name)).find((path) => existsSync(path));
    add(login ?? join(home, '.bash_profile'), shell === 'bash');
  }
  add(join(home, '.zshrc'), shell === 'zsh');
  if (shell === 'fish' || existsSync(join(home, '.config', 'fish'))) files.push(join(home, '.config', 'fish', 'conf.d', 'helm.fish'));
  return files;
}

/** First on PATH, moved there if it is already somewhere further back. */
function rcBlock(file, dir) {
  if (file.endsWith('.fish')) return `${RC_START}\nset -gx PATH ${quote(dir)} (string match -v -- ${quote(dir)} $PATH)\n${RC_END}\n`;
  return `${RC_START}
_helm_bin=${quote(dir)}
case ":$PATH:" in ":$_helm_bin:"*) ;; *) PATH="$_helm_bin:$(printf '%s' "$PATH" | tr ':' '\\n' | grep -vxF "$_helm_bin" | paste -sd: -)"; export PATH ;; esac
unset _helm_bin
${RC_END}
`;
}

const withoutBlock = (text) => text.replace(new RegExp(`\\n?${RC_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${RC_END}\\n?`, 'g'), '\n');

/**
 * Last in the file, so it lands first on PATH whatever the file added before
 * it. Rewritten only when it is missing or not last, so an unchanged file is
 * never touched.
 */
function ensurePathLine(files, dir) {
  const changed = [];
  for (const file of files) {
    try {
      const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
      const block = rcBlock(file, dir);
      if (text.trimEnd().endsWith(block.trimEnd())) continue;
      mkdirSync(dirname(file), { recursive: true });
      const rest = withoutBlock(text).replace(/\s*$/, '');
      writeFileSync(file, `${rest}${rest ? '\n\n' : ''}${block}`);
      changed.push(file);
    } catch { /* read-only or managed elsewhere: the command still works without it */ }
  }
  return changed;
}

function removePathLine(files) {
  for (const file of files) {
    try {
      if (!existsSync(file)) continue;
      const text = readFileSync(file, 'utf8');
      const next = withoutBlock(text);
      if (next === text) continue;
      if (file.endsWith('helm.fish') && !next.trim()) rmSync(file, { force: true });
      else writeFileSync(file, next.replace(/\n{3,}$/, '\n'));
    } catch { /* leave it */ }
  }
}

/**
 * One small script per command in Helm's own folder. It looks the real
 * command up on PATH after itself every time it runs, so a provider update,
 * a reinstall or a version switch is simply picked up: nothing of the CLI's
 * is ever replaced, and nothing can go stale.
 */
function launcherScript(name, engine, dir) {
  return `#!/bin/sh
${marker}
here=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd -P)
real=
IFS=:
for d in $PATH; do
  [ -n "$d" ] || continue
  [ "$d" = ${quote(dir)} ] && continue
  [ "$(CDPATH= cd -- "$d" 2>/dev/null && pwd -P)" = "$here" ] && continue
  if [ -f "$d/${name}" ] && [ -x "$d/${name}" ]; then real="$d/${name}"; break; fi
done
unset IFS
if [ -z "$real" ]; then echo "${name}: command not found" >&2; exit 127; fi
if [ ! -t 0 ] || [ ! -t 1 ] || [ -n "$HELM_NATIVE_BYPASS$HELM_SESSION_ID$HELM_NATIVE_SESSION" ]; then
  exec "$real" "$@"
fi
if [ -f ${quote(launcher)} ] && [ -x ${quote(process.execPath)} ]; then
  exec ${quote(process.execPath)} ${quote(launcher)} ${quote(engine)} "$real" "$@"
fi
exec "$real" "$@"
`;
}

/** Write the launchers for these `{ command: engine }` and drop any others. */
export function installNativeLaunchers(commands, { dir = LAUNCHER_DIR } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const installed = [];
  for (const [name, engine] of Object.entries(commands)) {
    if (!nativeEngines.includes(engine) || !/^[A-Za-z0-9._-]+$/.test(name)) continue;
    const path = join(dir, name), text = launcherScript(name, engine, dir);
    try { if (readFileSync(path, 'utf8') === text) { installed.push(name); continue; } } catch { /* new */ }
    const tmp = join(dir, `.${name}.tmp`);
    writeFileSync(tmp, text, { mode: 0o755 });
    renameSync(tmp, path);
    installed.push(name);
  }
  try {
    for (const name of readdirSync(dir)) if (!commands[name] && isShim(join(dir, name))) rmSync(join(dir, name), { force: true });
  } catch { /* nothing there */ }
  return installed;
}

/** Codex versions with a shared app-server daemon keep their own command. */
function codexSharesDaemon(cmd) {
  try { return execFileSync(cmd, ['agents', '--help'], { encoding: 'utf8', timeout: 3000 }).includes('shared local app-server daemon'); }
  catch { return null; }
}

/** The real command a name runs, looking past Helm's own folder. */
function realCommand(name, dir) {
  for (const d of (process.env.PATH || '').split(':')) {
    if (!d || d === dir) continue;
    const path = join(d, name);
    try { if (statSync(path).isFile() && !isShim(path)) { accessSync(path, constants.X_OK); return path; } }
    catch { /* not here */ }
  }
  return null;
}

export function integrateNativeCommands({ enable = false, home = HOME, dir = LAUNCHER_DIR, shells } = {}) {
  const manifest = readManifest();
  if (manifest.disabled && !enable) return [];
  restoreReplacedCommands(manifest);
  delete manifest.disabled;
  const commands = {};
  for (const engine of nativeEngines) {
    for (const bin of [ENGINES[engine].bin, ...(ENGINES[engine].altBins ?? [])]) {
      if (commands[bin]) continue;
      const cmd = realCommand(bin, dir);
      if (!cmd) continue;
      // Codex's own shared daemon already lets the app and terminal share a
      // thread, with structured approvals; its command stays its own.
      if (engine === 'codex' && codexSharesDaemon(cmd) !== false) continue;
      commands[bin] = engine;
    }
  }
  const installed = installNativeLaunchers(commands, { dir });
  const files = shells ?? rcFiles(home);
  ensurePathLine(files, dir);
  saveManifest({ version: 2, dir, commands, shells: files });
  return installed;
}

/** What the app's checklist shows: on, and which commands. */
export function nativeIntegrationStatus() {
  const manifest = readManifest();
  const commands = Object.keys(manifest.commands ?? {});
  return { on: !manifest.disabled && manifest.version === 2, commands: commands.length ? commands : ['claude', 'codex'] };
}

/** `helm integrate --remove`: launchers and PATH line gone, originals back, and it stays off. */
export function removeNativeLaunchers({ home = HOME, dir } = {}) {
  const manifest = readManifest();
  const restored = restoreReplacedCommands(manifest);
  const where = dir ?? manifest.dir ?? LAUNCHER_DIR;
  const removed = Object.keys(manifest.commands ?? {});
  for (const name of removed) if (isShim(join(where, name))) rmSync(join(where, name), { force: true });
  removePathLine(manifest.shells ?? rcFiles(home));
  saveManifest({ disabled: true });
  return [...new Set([...restored, ...removed])];
}

function direct(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 128 : 0)));
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  });
}

/**
 * Which shared terminal `--resume <id>` or `-c` means, if one is open: the
 * same conversation, or for -c the one in this folder on this account.
 */
export function sharedConversation(open, engine, configHome, args, cwd = process.cwd()) {
  const at = args.findIndex((a) => a === '--resume' || a === '-r' || (engine === 'codex' && a === 'resume'));
  const wanted = at >= 0 ? args[at + 1] : null;
  const latest = args.includes('-c') || args.includes('--continue') || (engine === 'codex' && args.includes('--last'));
  const mine = open.filter((s) => s.engine === engine && s.configHome === configHome);
  if (wanted && !wanted.startsWith('-')) return mine.find((s) => s.conversation === wanted) ?? null;
  if (latest) return mine.filter((s) => s.cwd === cwd).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  return null;
}

/** The local terminal is a client of the same persistent PTY as the phone.
 * Unmodified provider executable, exact argv and invoking shell environment.
 * Closing the client does not send EOF or a signal to the provider.
 */
export async function runNativeCli(engine, cmd, args) {
  if (!interactiveLaunch(engine, args)) return direct(cmd, args);
  // Every CLI host on the machine: a conversation to join may be in an older one.
  const host = new NativeHosts();
  const configHome = expand(process.env[ENGINES[engine].homeEnv] || ENGINES[engine].defaultHome);
  const size = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
  // Fall back only before opening a process. Never spawn a second provider
  // after an uncertain write/open acknowledgement.
  if (!await host.ensure()) { host.detach(); return direct(cmd, args); }
  // Continuing a conversation that is already open in a shared terminal -
  // one Helm took over, say - joins it instead of starting a second copy.
  const joined = sharedConversation(host.nativeSessions(), engine, configHome, args);
  const id = joined?.id ?? `native-${randomBytes(8).toString('hex')}`;
  // A terminal Claude is a normal chat in Helm. Claude's own hooks tell Helm
  // what it is doing and carry answers back (claude-hooks.js); what Helm
  // sends is typed into this terminal. HELM_NATIVE_CHAT=0 keeps the terminal
  // screen in Helm instead.
  const nativeChat = engine === 'claude' && !joined && process.env.HELM_NATIVE_CHAT !== '0';
  if (nativeChat) args = [...args, '--settings', hookSettings()];
  return new Promise(async (resolve, reject) => {
    let finished = false;
    let started = false;
    const wasRaw = process.stdin.isRaw;
    const subscriptions = [];
    const on = (emitter, event, handler) => { emitter.on(event, handler); subscriptions.push(() => emitter.off(event, handler)); };
    let timer;
    const finish = (code, err) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      for (const off of subscriptions) off();
      if (started && process.stdin.isTTY) process.stdin.setRawMode(!!wasRaw);
      process.stdin.pause();
      host.detach();
      // The client may disappear while the alternate screen is active.
      process.stdout.write('\x1b[?1049l\x1b[?25h\x1b[0m');
      err ? reject(err) : resolve(code);
    };
    const refresh = () => host.renew(id).catch((err) => finish(1, err));
    let replaying = true;
    const backlog = [];
    on(host, 'data', (d) => {
      if (d.id !== id) return;
      if (replaying) backlog.push(d.text); else process.stdout.write(d.text);
    });
    on(host, 'exit', (e) => { if (e.id === id) finish(e.code ?? 0); });
    try {
      if (!joined) await host.open(id, { cmd, args, cwd: process.cwd(), ...size(), exactEnv: true,
        env: { ...process.env, HELM_NATIVE_SESSION: id }, native: { engine, configHome, nativeChat } });
      if (finished) return;
      process.stdin.setRawMode(true);
      started = true;
      on(process.stdin, 'data', (data) => { host.write(id, data.toString('utf8')).catch((err) => finish(1, err)); });
      on(process.stdin, 'end', () => finish(0));
      on(process.stdout, 'resize', () => { const s = size(); host.resize(id, s.cols, s.rows); });
      for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT']) on(process, signal, () => finish(0));
      process.stdin.resume();
      // Subscribe before the snapshot; data is not broadcast until view().
      // Persistent: a laptop that slept past the view lease keeps its output.
      process.stdout.write(await host.view(id, { ...size(), persistent: true }));
      replaying = false;
      for (const chunk of backlog) process.stdout.write(chunk);
      timer = setInterval(refresh, 20_000);
    } catch (err) { finish(1, err); }
  });
}
