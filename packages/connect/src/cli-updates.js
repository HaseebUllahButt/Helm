import { execFile } from 'node:child_process';
import { accessSync, constants, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, relative, isAbsolute } from 'node:path';
import { ENGINES } from './engines.js';
import { HELM_DIR, HOME } from './paths.js';

/**
 * Keeps the coding tools on this machine (claude, codex, ...) current, and
 * says which version each one is.
 *
 * The one rule: only ever update something in the way it was installed, as
 * this user, with no sudo. A tool a system package, Homebrew or some other
 * installer put there is left alone and the reason is shown instead.
 * Nothing running is touched: a running tool keeps the program it already
 * loaded, and only chats started afterwards use the new one.
 */

const STATE_FILE = join(HELM_DIR, 'cli-updates.json');
/** Helm's own launcher scripts sit first on PATH; they are not the tool. */
const LAUNCHER_DIR = join(HELM_DIR, 'bin');
const SHIM_MARKER = '# Helm native CLI integration';

const VERSION_TIMEOUT_MS = 10_000;
const UPDATE_TIMEOUT_MS = 5 * 60_000;
const LATEST_TTL_MS = 6 * 60 * 60_000;
const SHOWN_TTL_MS = 30_000;
const FIRST_RUN_MS = 3 * 60_000;
const EVERY_MS = 6 * 60 * 60_000;
const RETRY_BUSY_MS = 10 * 60_000;

/**
 * How each tool can be brought up to date.
 *   self  the tool's own update command, checked with its --help
 *   npm   the npm packages it ships as; only trusted when the real file sits
 *         inside a folder of that exact package under `npm root -g`
 * A tool with neither (kimi, muse, ...) is only ever reported.
 * Pi's own `update` refreshes its add-ons, not pi, so pi goes through npm.
 */
export const UPDATERS = {
  claude: { self: ['update'], npm: ['@anthropic-ai/claude-code'] },
  codex: { self: ['update'], npm: ['@openai/codex'] },
  opencode: { self: ['upgrade'], npm: ['opencode-ai'] },
  opencode2: { self: ['upgrade'] },
  devin: { self: ['update'] },
  grok: { self: ['update'] },
  cursor: { self: ['update'] },
  agy: { self: ['update'] },
  gemini: { npm: ['@google/gemini-cli'] },
  pi: { npm: ['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent'] },
};

// ------------------------------------------------------------ small helpers

const slash = (p) => String(p).replaceAll('\\', '/');
const stripAnsi = (s) => String(s ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** First version-looking token of `tool --version` ("codex-cli 0.161.0", "2026.08.11-e8db854"). */
export function parseVersion(text) {
  const m = stripAnsi(text).match(/\d+\.\d+(?:\.\d+)*(?:-[0-9A-Za-z.]+)?/);
  return m ? m[0] : null;
}

/** Is `latest` ahead of `have`? Numbers only; anything unreadable says no. */
export function isNewer(latest, have) {
  if (!latest || !have) return false;
  const nums = (v) => String(v).split('-')[0].split('.').map((n) => Number.parseInt(n, 10));
  const a = nums(latest), b = nums(have);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x !== y) return x > y;
  }
  return false;
}

const inside = (child, parent) => {
  const rel = relative(parent, child);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
};

const writable = (p) => { try { accessSync(p, constants.W_OK); return true; } catch { return false; } };

const packageName = (dir) => {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name ?? null; } catch { return null; }
};

const isHelmShim = (path) => {
  try { const st = lstatSync(path); return st.isFile() && st.size < 16_384 && readFileSync(path, 'utf8').includes(SHIM_MARKER); }
  catch { return false; }
};

/**
 * The real program behind a command name. Helm's own launcher scripts are
 * skipped on purpose - they only forward to the tool, and the tool is what
 * gets its version read and its update run.
 */
export function findBinary(names, { PATH = process.env.PATH ?? '', platform = process.platform } = {}) {
  const exts = platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD').split(';').filter(Boolean)] : [''];
  for (const bin of names) {
    for (const dir of PATH.split(platform === 'win32' ? ';' : delimiter)) {
      if (!dir || dir === LAUNCHER_DIR) continue;
      for (const ext of exts) {
        const path = join(dir, bin + ext);
        try {
          if (!statSync(path).isFile()) continue;
          accessSync(path, constants.X_OK);
          if (isHelmShim(path)) continue;
          return { bin, path };
        } catch { /* not here */ }
      }
    }
  }
  return null;
}

// -------------------------------------------------------------- install kind

// Places a package manager or the system owns. Updating something there is
// not ours to do, whatever the tool's own updater might try.
const OTHER_OWNERS = [
  [/\/(Cellar|homebrew|\.linuxbrew|linuxbrew)(\/|$)/i, 'homebrew', 'installed by Homebrew - update it with brew'],
  [/^\/(usr|opt|bin|sbin|snap|nix|Applications|Library|var\/lib\/flatpak)(\/|$)/, 'system', 'installed by the system - update it with the system’s package manager'],
  [/\/(Program Files|Program Files \(x86\)|WindowsApps)(\/|$)/i, 'system', 'installed by the system - update it with the system’s package manager'],
  [/\/\.bun\//, 'other', 'installed with bun - update it with bun'],
  [/\/(pnpm|\.pnpm)(\/|$)|\/\.local\/share\/pnpm\//, 'other', 'installed with pnpm - update it with pnpm'],
  [/\/\.(yarn|config\/yarn)\//, 'other', 'installed with yarn - update it with yarn'],
  [/\/(\.local\/share\/uv|\.local\/pipx|pipx)\//, 'other', 'installed with Python tooling - update it there'],
  [/\/\.cargo\//, 'other', 'installed with cargo - update it with cargo'],
];

/**
 * How `realPath` (the file after following links) was installed, and the one
 * safe command that updates it - or why none exists. Pure, so every case can
 * be tried with made-up paths.
 */
export function classifyInstall(engine, realPath, {
  npmRoot = null, home = HOME, platform = process.platform,
  canWrite = writable, pkgNameOf = packageName,
} = {}) {
  const spec = UPDATERS[engine];
  const path = slash(realPath);
  const no = (method, reason) => ({ method, canUpdate: false, reason });
  if (!spec) return no('other', 'no automatic updater is known for this tool');

  // 1. A package inside npm's own global folder, and one we recognise.
  const root = npmRoot ? slash(npmRoot) : null;
  if (root && inside(path, root)) {
    const parts = path.slice(root.length).split('/').filter(Boolean);
    const pkg = parts[0]?.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const pkgDir = join(npmRoot, ...(pkg ?? '').split('/'));
    if (!pkg || !spec.npm?.includes(pkg) || pkgNameOf(pkgDir) !== pkg) {
      return no('npm', `installed with npm as ${pkg ?? 'an unknown package'}, which Helm does not recognise as this tool`);
    }
    if (!canWrite(npmRoot) || !canWrite(pkgDir)) return no('npm', 'installed with npm in a folder this user can not write to');
    return { method: 'npm', canUpdate: true, pkg, command: { cmd: 'npm', args: ['install', '-g', `${pkg}@latest`] } };
  }
  // 2. Somebody else's install: never ours to change. (Checked before the
  // generic npm case so bun's and pnpm's node_modules are named correctly.)
  for (const [pattern, method, reason] of OTHER_OWNERS) {
    if (pattern.test(path)) return no(method, reason);
  }

  if (path.includes('/node_modules/')) {
    return no('npm', root
      ? 'installed with npm somewhere other than the npm Helm uses (another Node version?)'
      : 'installed with npm, but Helm can not find npm');
  }

  // 3. The tool's own updater, only for a copy that lives in this user's home.
  if (spec.self) {
    const h = slash(home);
    const mine = platform === 'win32' ? path.toLowerCase().startsWith(h.toLowerCase() + '/') : path.startsWith(h + '/');
    if (!mine) return no('other', 'installed outside your home folder - update it where it was installed');
    if (!canWrite(dirname(realPath))) return no('self', 'its folder is not writable by this user');
    return { method: 'self', canUpdate: true, command: { cmd: null, args: spec.self } };
  }
  return no('other', 'no automatic updater is known for this install');
}

// ----------------------------------------------------------------- processes

/** Run a program with an argument list (never a shell string) and collect what it says. */
function run(cmd, args, { timeout, env = process.env, platform = process.platform } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    // npm is a .cmd script on Windows, which only starts through a shell.
    // Run npm's own script with node instead and no shell is involved.
    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const viaNode = platform === 'win32' && cmd === 'npm';
    const child = execFile(viaNode ? process.execPath : cmd, viaNode ? [npmCli, ...args] : args,
      { timeout, env, maxBuffer: 2 << 20, windowsHide: true },
      (error, stdout, stderr) => {
        const out = stripAnsi(`${stdout ?? ''}\n${stderr ?? ''}`).split('\n').map((l) => l.trim()).filter(Boolean);
        resolve({
          ok: !error, code: error?.code ?? 0, ms: Date.now() - started, out,
          timedOut: !!error && (error.killed === true || error.signal === 'SIGTERM'),
        });
      });
    // Updaters sometimes wait for a keypress; nobody is there to give one.
    child.stdin?.end();
  });
}

const tail = (lines, n = 3) => lines.slice(-n).join(' · ').slice(0, 300);

// -------------------------------------------------------------------- state

function loadState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return { engines: s.engines ?? {}, latest: s.latest ?? {} };
  } catch { return { engines: {}, latest: {} }; }
}

function saveState(state) {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, ...state }, null, 2), { mode: 0o600 });
    renameSync(tmp, STATE_FILE);
  } catch (err) { console.error('[helm] cli updates state:', err?.message || err); }
}

// ------------------------------------------------------------------- updater

export class CliUpdater {
  #timer = null;
  #retry = null;
  #stopped = false;
  #queue = [];
  #active = null;
  #job = null;
  #shown = null;
  #npmRoot;

  /**
   * auto        () => bool        is automatic updating on for this machine
   * busy        (engine) => bool  does a chat of this tool have work in flight (checked on Windows only)
   * env, platform, home, npmRoot, now   all replaceable so tests never touch the real machine
   */
  constructor({ auto = () => true, busy = async () => false, env = process.env, platform = process.platform,
    home = HOME, npmRoot, now = Date.now, firstRunMs = FIRST_RUN_MS, everyMs = EVERY_MS, retryMs = RETRY_BUSY_MS,
    log = (m) => console.error(`[helm] ${m}`) } = {}) {
    Object.assign(this, { auto, busy, env, platform, home, now, firstRunMs, everyMs, retryMs, log });
    this.#npmRoot = npmRoot;
  }

  // ---- finding what is installed

  async #root() {
    if (this.#npmRoot !== undefined) return typeof this.#npmRoot === 'function' ? this.#npmRoot() : this.#npmRoot;
    const r = await run('npm', ['root', '-g'], { timeout: 15_000, env: this.env, platform: this.platform });
    return r.ok && r.out[0] && isAbsolute(r.out[0]) ? r.out[0] : null;
  }

  async #version(path) {
    const r = await run(path, ['--version'], { timeout: VERSION_TIMEOUT_MS, env: this.env, platform: this.platform });
    return parseVersion(r.out.join('\n'));
  }

  /** Everything known about one installed tool, or null when it is not on this machine. */
  async inspect(id, npmRoot) {
    const e = ENGINES[id];
    if (!e?.bin || e.managed) return null;
    const found = findBinary([e.bin, ...(e.altBins ?? [])], { PATH: this.env.PATH ?? '', platform: this.platform });
    if (!found) return null;
    let real = found.path;
    try { real = realpathSync(found.path); } catch { /* keep the link path */ }
    const [version, root] = await Promise.all([this.#version(found.path), npmRoot ?? this.#root()]);
    const plan = classifyInstall(id, real, { npmRoot: root, home: this.home, platform: this.platform });
    return { engine: id, label: e.label, path: found.path, bin: found.bin, version, ...plan };
  }

  async #inspectAll() {
    const root = await this.#root();
    const ids = Object.values(ENGINES).filter((e) => e.bin && !e.managed).map((e) => e.id);
    return (await Promise.all(ids.map((id) => this.inspect(id, root)))).filter(Boolean);
  }

  async #latest(tool, state) {
    if (tool.method !== 'npm' || !tool.pkg) return null;
    const hit = state.latest[tool.pkg];
    if (hit && this.now() - hit.at < LATEST_TTL_MS) return hit.version;
    const r = await run('npm', ['view', tool.pkg, 'version'], { timeout: 20_000, env: this.env, platform: this.platform });
    const version = r.ok ? parseVersion(r.out[0]) : null;
    if (version) state.latest[tool.pkg] = { version, at: this.now() };
    return version ?? hit?.version ?? null;
  }

  // ---- what the app shows

  /** Every installed tool: version, how it can be updated, and the last attempt. */
  async versions({ refresh = false } = {}) {
    if (!refresh && this.#shown && this.now() - this.#shown.at < SHOWN_TTL_MS) return this.#view(this.#shown.tools);
    const state = loadState();
    const found = await this.#inspectAll();
    const tools = [];
    for (const t of found) {
      const latest = await this.#latest(t, state).catch(() => null);
      tools.push({
        engine: t.engine, label: t.label, version: t.version, ...(latest ? { latest, outdated: isNewer(latest, t.version) } : {}),
        method: t.method, canUpdate: t.canUpdate, ...(t.reason ? { reason: t.reason } : {}),
        lastChecked: this.now(),
        ...(state.engines[t.engine]?.lastResult ? { lastResult: state.engines[t.engine].lastResult } : {}),
      });
    }
    saveState(state);
    this.#shown = { at: this.now(), tools };
    return this.#view(tools);
  }

  #view(tools) {
    return { auto: !!this.auto(), running: [...(this.#active ? [this.#active] : []), ...this.#queue], tools };
  }

  // ---- updating

  /**
   * Begin updating in the background and answer straight away: an update can
   * take minutes, far longer than the app waits for a reply. The app asks
   * `versions` again to watch it finish.
   */
  begin({ engine } = {}) {
    if (engine && !(ENGINES[engine]?.bin && !ENGINES[engine].managed)) throw new Error(`unknown coding tool: ${engine}`);
    if (this.#job) return { started: false, busy: true };
    this.update({ engine }).catch((err) => this.log(`coding tool update: ${err?.message || err}`));
    return { started: true };
  }

  /** Update one tool or all of them, one at a time. Resolves with what happened to each. */
  update({ engine } = {}) {
    if (this.#job) return this.#job;
    this.#job = this.#runAll(engine).finally(() => { this.#job = null; this.#active = null; this.#queue = []; this.#shown = null; });
    return this.#job;
  }

  async #runAll(only) {
    const root = await this.#root();
    const ids = only ? [only] : Object.values(ENGINES).filter((e) => e.bin && !e.managed).map((e) => e.id);
    this.#queue = [...ids];
    const results = [];
    let deferred = false;
    for (const id of ids) {
      this.#queue = this.#queue.filter((x) => x !== id);
      this.#active = id;
      const r = await this.#updateOne(id, root);
      if (!r) continue;
      if (r.deferred) deferred = true;
      results.push(r);
    }
    this.#active = null;
    if (deferred && !this.#stopped) {
      clearTimeout(this.#retry);
      this.#retry = setTimeout(() => { this.#retry = null; if (!this.#stopped) void this.update().catch(() => {}); }, this.retryMs);
      this.#retry.unref?.();
    }
    return results;
  }

  async #updateOne(id, root) {
    const tool = await this.inspect(id, root);
    if (!tool) return null;
    const base = { engine: id, label: tool.label, from: tool.version };
    // Nothing is attempted unless the install was recognised as ours to update.
    if (!tool.canUpdate) return { ...base, ok: false, skipped: true, reason: tool.reason };
    // Replacing a program that is running fails on Windows, so wait for the
    // chat to finish. Elsewhere the running copy simply keeps its own file.
    if (this.platform === 'win32' && await this.busy(id).catch(() => true)) {
      return { ...base, ok: false, skipped: true, deferred: true, reason: 'a chat is using it right now - trying again later' };
    }

    const cmd = tool.command.cmd ?? tool.path;
    const r = await run(cmd, tool.command.args, { timeout: UPDATE_TIMEOUT_MS, env: this.env, platform: this.platform });
    const to = r.ok ? await this.#version(tool.path) : tool.version;
    const result = {
      at: this.now(), ok: r.ok, from: tool.version, to, changed: !!(r.ok && to && to !== tool.version), ms: r.ms,
      message: r.timedOut ? 'the update took too long and was stopped' : tail(r.out),
    };
    const state = loadState();
    state.engines[id] = { ...state.engines[id], lastResult: result };
    saveState(state);
    this.log(`${tool.label}: ${r.ok ? (result.changed ? `updated ${result.from} -> ${result.to}` : 'already up to date') : `update failed (${result.message})`}`);
    return { ...base, ...result };
  }

  // ---- schedule

  /** A few minutes after start, then every six hours, each time a little off so machines do not all act at once. */
  start() {
    if (this.#stopped || this.#timer) return;
    const jitter = (ms, spread) => ms + Math.floor(Math.random() * ms * spread);
    const arm = (ms) => {
      this.#timer = setTimeout(async () => {
        this.#timer = null;
        try { await this.tick(); } catch (err) { this.log(`coding tool update: ${err?.message || err}`); }
        if (!this.#stopped) arm(jitter(this.everyMs, 0.1));
      }, ms);
      this.#timer.unref?.();
    };
    arm(jitter(this.firstRunMs, 0.5));
  }

  /** One scheduled pass: does nothing at all while automatic updating is off. */
  async tick() {
    if (this.#stopped || !this.auto()) return null;
    return this.update();
  }

  stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    clearTimeout(this.#retry);
    this.#timer = this.#retry = null;
  }
}
