/**
 * T3 Code on this machine.
 *
 * T3 Code is the UI; helm is only the network. Each machine runs one stock
 * `t3 serve` bound to loopback, and helm's hub publishes it to the outside.
 * T3 is consumed as its published npm package at a pinned version and never
 * modified, so nothing upstream changes can break helm's side of the seam:
 * a loopback HTTP server, a pairing CLI, a settings file.
 *
 * Everything here is a thin wrapper around three of T3's own surfaces:
 *   - `t3 serve --host 127.0.0.1 --port N`        the server
 *   - `t3 auth pairing create --json --base-url`  a pairing link
 *   - `t3 auth session issue --json`              a scoped bearer for helm
 * plus the `/.well-known/t3/environment` descriptor over HTTP.
 */
import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { HOME, HELM_DIR } from './paths.js';

const exec = promisify(execFile);

/** The one place T3's version is pinned. Bump deliberately; `helm status` shows it. */
export const T3_VERSION = '0.0.40';

/** helm installs T3 into its own prefix rather than touching global npm. */
export const T3_PREFIX = process.env.HELM_T3_PREFIX || join(HELM_DIR, 't3');
export const T3_BIN = process.env.HELM_T3_BIN || join(T3_PREFIX, 'node_modules', '.bin', 't3');

/**
 * Where T3 keeps its state. By default T3's own `~/.t3`, so a T3 Desktop
 * install on the same machine shares projects and threads with what helm
 * runs. A sandboxed helm (HELM_DIR set) gets a sandboxed T3 home too, so a
 * test never writes into the real one.
 */
export const T3_HOME = process.env.HELM_T3_HOME
  || (process.env.HELM_DIR ? join(HELM_DIR, 't3-home') : join(HOME, '.t3'));

const LOCAL_FILE = join(HELM_DIR, 'local.json');
const PORT_MIN = 3800;
const PORT_MAX = 3899;

const t3Env = (extra = {}) => ({ ...process.env, T3CODE_HOME: T3_HOME, ...extra });

function readLocal() {
  try { return JSON.parse(readFileSync(LOCAL_FILE, 'utf8')); } catch { return {}; }
}
function writeLocal(patch) {
  const next = { ...readLocal(), ...patch };
  mkdirSync(HELM_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(LOCAL_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

const portFree = (port) => new Promise((resolve) => {
  const srv = createServer();
  srv.once('error', () => resolve(false));
  srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
});

/**
 * The loopback port this machine's T3 server uses. Chosen once and
 * remembered, so the hub's published port and every paired client keep
 * working across restarts.
 */
export async function t3Port() {
  const forced = Number(process.env.HELM_T3_PORT);
  if (Number.isFinite(forced) && forced > 0) return forced;
  const saved = Number(readLocal().t3Port);
  if (Number.isFinite(saved) && saved > 0) return saved;
  for (let port = PORT_MIN; port <= PORT_MAX; port++) {
    if (await portFree(port)) { writeLocal({ t3Port: port }); return port; }
  }
  throw new Error(`no free port between ${PORT_MIN} and ${PORT_MAX} for T3`);
}

// ---------------------------------------------------------------- install

async function installedVersion() {
  if (!existsSync(T3_BIN)) return null;
  try {
    const pkg = JSON.parse(readFileSync(join(T3_PREFIX, 'node_modules', 't3', 'package.json'), 'utf8'));
    return pkg.version || null;
  } catch { return null; }
}

/** node-pty ships no Linux prebuild; it has to be compiled once after install. */
async function nodePtyLoads() {
  const mod = join(T3_PREFIX, 'node_modules', 'node-pty');
  if (!existsSync(mod)) return true; // not a dependency of this build
  try {
    await exec(process.execPath, ['-e', `require(${JSON.stringify(mod)})`]);
    return true;
  } catch { return false; }
}

/**
 * Make sure the pinned T3 is installed and can actually start. Prints what
 * it is doing because an npm install can take a minute the first time.
 */
export async function ensureT3({ log = console.log } = {}) {
  // Tests and unusual installs: a T3 supplied from outside is taken as is.
  if (process.env.HELM_NO_T3 === '1') return { version: 'disabled', bin: null };
  if (process.env.HELM_T3_BIN) return { version: 'external', bin: T3_BIN };
  const have = await installedVersion();
  if (have !== T3_VERSION) {
    log(`installing T3 Code ${T3_VERSION}${have ? ` (had ${have})` : ''}...`);
    mkdirSync(T3_PREFIX, { recursive: true });
    await exec('npm', [
      'install', '--prefix', T3_PREFIX, `t3@${T3_VERSION}`,
      '--no-fund', '--no-audit', '--loglevel=error',
    ], { maxBuffer: 16 << 20, timeout: 10 * 60_000 });
  }
  if (!(await nodePtyLoads())) {
    log('building node-pty (T3 terminals need it)...');
    const mod = join(T3_PREFIX, 'node_modules', 'node-pty');
    try {
      await exec('npx', ['--yes', 'node-gyp', 'rebuild'], {
        cwd: mod, maxBuffer: 16 << 20, timeout: 10 * 60_000,
      });
    } catch (err) {
      throw new Error(
        'could not build node-pty for T3. It needs python3, make and a C++ compiler:\n' +
        '  debian/ubuntu:  sudo apt install -y python3 make g++\n' +
        `  then run this command again. (${err.message.split('\n')[0]})`
      );
    }
    if (!(await nodePtyLoads())) throw new Error('node-pty still does not load after building it');
  }
  return { version: T3_VERSION, bin: T3_BIN };
}

// ------------------------------------------------------------------ server

/**
 * Keep one `t3 serve` running on loopback for as long as helm runs. It is a
 * child of the helm daemon rather than its own service so there is exactly
 * one thing to install, start, stop and watch on a machine.
 */
export class T3Server {
  #child = null;
  #stopped = false;
  #backoff = 1000;

  /**
   * @param {object} opts
   * @param {number} opts.port
   * @param {boolean} [opts.managed]  false: someone else runs `t3 serve` on
   *   that port (tests, or an owner who prefers to); helm only publishes it.
   */
  constructor({ port, cwd = HOME, log = console.log, managed = true } = {}) {
    this.port = port;
    this.cwd = cwd;
    this.log = log;
    this.managed = managed;
    this.ready = false;
  }

  get origin() { return `http://127.0.0.1:${this.port}`; }

  start() {
    if (this.managed) this.#spawn();
    else this.describe().catch(() => {});
    return this;
  }

  #spawn() {
    if (this.#stopped) return;
    const child = spawn(T3_BIN, [
      'serve', '--host', '127.0.0.1', '--port', String(this.port), '--no-browser', this.cwd,
    ], { env: t3Env(), stdio: ['ignore', 'pipe', 'pipe'], cwd: this.cwd });
    this.#child = child;
    const startedAt = Date.now();

    // T3 logs a lot on boot; keep the lines a person needs and drop the rest.
    const relay = (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (/error|Listening on|T3 Code server is ready/i.test(line)) this.log(`[t3] ${line.trim()}`);
        if (/T3 Code server is ready|Listening on/.test(line)) this.ready = true;
      }
    };
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);
    child.on('error', (err) => this.log(`[t3] failed to start: ${err.message}`));
    child.on('exit', (code, signal) => {
      this.ready = false;
      this.#child = null;
      if (this.#stopped) return;
      // A server that ran for a while and died gets restarted at once; one
      // that dies straight away is probably misconfigured, so back off.
      const ranFor = Date.now() - startedAt;
      this.#backoff = ranFor > 30_000 ? 1000 : Math.min(this.#backoff * 2, 30_000);
      this.log(`[t3] exited (${signal || code}); restarting in ${this.#backoff / 1000}s`);
      setTimeout(() => this.#spawn(), this.#backoff).unref?.();
    });
  }

  /** Ask T3 to shut down; resolves once it has, or kills it after 5s. */
  stop() {
    this.#stopped = true;
    this.ready = false;
    const child = this.#child;
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      try { child.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
    });
  }

  /** The descriptor T3 publishes about itself, or null while it is starting. */
  async describe() {
    try {
      const res = await fetch(`${this.origin}/.well-known/t3/environment`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return null;
      const d = await res.json();
      this.ready = true;
      return { environmentId: d.environmentId, label: d.label, version: d.serverVersion };
    } catch { return null; }
  }
}

// ------------------------------------------------------------------ pairing

const runJson = async (args) => {
  const { stdout } = await exec(T3_BIN, args, { env: t3Env(), timeout: 30_000, maxBuffer: 1 << 20 });
  // T3 prints human lines around the JSON on some paths; take the object.
  const start = stdout.indexOf('{');
  return JSON.parse(stdout.slice(start));
};

/**
 * A one-time pairing link for this machine's T3 server, addressed at the
 * origin the outside world reaches it on (the hub's published origin, not
 * loopback). Whoever opens it is a paired T3 client of this machine until
 * revoked from T3's Connections settings or `helm devices`.
 */
export async function pairingLink({ baseUrl, label = 'helm', ttl = '10m' } = {}) {
  const r = await runJson([
    'auth', 'pairing', 'create', '--json', '--ttl', ttl, '--label', label,
    ...(baseUrl ? ['--base-url', baseUrl] : []),
  ]);
  return { credential: r.credential, url: r.pairUrl, expiresAt: r.expiresAt, id: r.id };
}

/** A short-lived bearer that lets helm read and revoke this server's clients. */
export async function adminToken({ ttl = '5m' } = {}) {
  const r = await runJson([
    'auth', 'session', 'issue', '--json', '--ttl', ttl, '--label', 'helm', '--subject', 'helm',
  ]);
  return r.token;
}

/** Paired clients of this machine's T3, as T3 reports them. */
export async function listClients(origin) {
  const token = await adminToken();
  const res = await fetch(`${origin}/api/auth/clients`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`T3 answered ${res.status} listing clients`);
  const rows = await res.json();
  // helm's own admin sessions are plumbing, not devices.
  return rows.filter((r) => r.subject !== 'helm' && r.client?.label !== 'helm');
}

export async function revokeClient(origin, sessionId) {
  const token = await adminToken();
  const res = await fetch(`${origin}/api/auth/clients/revoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`T3 answered ${res.status} revoking ${sessionId}`);
  return res.json();
}
