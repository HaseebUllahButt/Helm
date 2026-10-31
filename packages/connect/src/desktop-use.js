// A chat's hands on the desktop: Vercel's agent-desktop program reads any
// app's buttons and fields through the system's accessibility tree, and acts
// on them without the owner's mouse or keyboard. Helm pins one version of it
// (packages/connect/package.json) and adds what a chat needs on top: a
// private namespace per chat, apps started so that they show their controls,
// and closing the apps a chat opened when that chat goes.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, chmodSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { HELM_DIR } from './paths.js';
import { canOpenWindow, screenEnv } from './browser-window.js';

const require = createRequire(import.meta.url);

/** Helm runs the native program itself; their Node launcher adds a start-up delay to every call. Their own setting names another copy. */
export function desktopTool(env = process.env, platform = process.platform, arch = process.arch) {
  if (env.AGENT_DESKTOP_BINARY_PATH) return { path: env.AGENT_DESKTOP_BINARY_PATH, env: {} };
  let dir;
  try { dir = dirname(require.resolve('agent-desktop/package.json')); } catch { return null; }
  const entry = require(join(dir, 'lib/platform.js')).resolve(platform, arch);
  if (!entry?.released) return null;
  const path = join(dir, 'bin', entry.binaryName);
  if (!existsSync(path)) return null;
  // A Mac also needs its helper program, named in the environment.
  const helper = join(dir, 'bin', `agent-desktop-macos-helper-${platform}-${arch}`);
  return { path, env: platform === 'darwin' && existsSync(helper) ? { AGENT_DESKTOP_MACOS_HELPER_PATH: helper } : {} };
}

/** Desktop use needs the program and a screen. The VM has neither. A screen, once seen, stays. */
let screenSeen = false;
export const desktopReady = () => !!desktopTool() && (screenSeen ||= canOpenWindow());

export function desktopNote() {
  return '[Helm desktop: Use helm desktop for desktop apps here (helm desktop --help). Read helm desktop guide first. Start apps with helm desktop open. Ask the owner before you restart or close an app you did not open.]';
}

// What makes each kind of app show its controls. The environment is safe for
// every app; the switch goes only to Chromium-based browsers, because other
// apps can refuse an option they do not know.
const CHROMIUM = /chrom|brave|edge|vivaldi|helium|opera|thorium|yandex/i;
export function launchHints(app, platform = process.platform) {
  if (platform !== 'linux') return [];
  const env = ['QT_ACCESSIBILITY=1', 'QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1', 'GNOME_ACCESSIBILITY=1', 'ACCESSIBILITY_ENABLED=1'].flatMap(value => ['--env', value]);
  return [...env, ...(CHROMIUM.test(app) ? ['--arg=--force-renderer-accessibility'] : [])];
}

// Chat ids become the program's namespace name, which takes letters, digits, - and _.
const namespace = id => `helm-${id.replace(/[^\w-]/g, '_')}`.slice(0, 64);
const appName = value => { if (typeof value !== 'string' || !value.trim() || value.length > 400) throw new Error('name an app, for example from helm desktop apps'); return value.trim(); };
// Helm's own words own these: open starts apps so that they show their
// controls, close and restart guard the owner's apps, and Helm owns the
// namespaces.
const OWN = { launch: 'helm desktop open', 'close-app': 'helm desktop close', session: 'nothing: Helm keeps a namespace for each chat' };

/** Run the program once and return its JSON reply, also when the reply is an error. */
export function runTool(tool, args, { env = {}, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(tool.path, args, { env: { ...process.env, ...screenEnv(), ...tool.env, ...env }, timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const text = String(stdout).trim();
      try { return resolve(JSON.parse(text.slice(text.lastIndexOf('\n{') + 1))); } catch { /* not JSON */ }
      reject(new Error(error?.killed ? 'The desktop program took too long.' : `The desktop program failed. ${String(stderr || error?.message || '').trim().slice(0, 600)}`));
    });
  });
}

/** Facts about one process, so that Helm never stops a new process that took an old number. */
function processStamp(pid, platform = process.platform) {
  try {
    if (platform === 'linux') return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop().split(' ')[19] || null;
    if (platform === 'darwin') return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    if (platform === 'win32') return execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).StartTime.Ticks`], { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    return null;
  } catch { return null; }
}

// The Linux screen-reader switch, for apps that show controls only when it is on.
const A11Y = ['org.a11y.Bus', '/org/a11y/bus', 'org.a11y.Status', 'IsEnabled'];
export const linuxSwitch = {
  async get() {
    const out = await new Promise(resolve => execFile('busctl', ['--user', 'get-property', ...A11Y], { timeout: 5000 }, (error, stdout) => resolve(error ? null : String(stdout))));
    return out == null ? null : /true/.test(out);
  },
  async set(on) {
    await new Promise((resolve, reject) => execFile('busctl', ['--user', 'set-property', ...A11Y, 'b', on ? 'true' : 'false'], { timeout: 5000 }, error => error ? reject(new Error('Could not change the screen-reader switch.')) : resolve()));
  },
};

export class DesktopManager {
  constructor({ directory = join(HELM_DIR, 'desktop'), session = () => null, tool = desktopTool, run = runTool, a11y = linuxSwitch, stamp = processStamp, kill = (pid, signal) => process.kill(pid, signal), now = Date.now, switchIdleMs = 10 * 60000, platform = process.platform } = {}) {
    Object.assign(this, { directory, session, tool, runner: run, a11y, stamp, kill, now, switchIdleMs, platform });
    this.file = join(directory, 'apps.json');
    this.state = this.load();
  }
  load() {
    try { const state = JSON.parse(readFileSync(this.file, 'utf8')); return { chats: state.chats && typeof state.chats === 'object' ? state.chats : {}, switchOn: !!state.switchOn, usedAt: Number(state.usedAt) || 0 }; }
    catch { return { chats: {}, switchOn: false, usedAt: 0 }; }
  }
  save() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}`; writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 }); renameSync(temp, this.file);
  }
  owner(sessionId) {
    if (!/^[\w:-]{1,160}$/.test(sessionId || '')) throw new Error('desktop apps belong to a Helm chat');
    if (!this.session(sessionId)) throw new Error('chat not found');
  }
  async call(sessionId, args, opts) {
    const tool = this.tool();
    if (!tool) throw new Error('Desktop use is not installed on this machine. Update Helm.');
    // The program keeps its state in a private folder, which it checks.
    const home = join(this.directory, 'tool'); mkdirSync(home, { recursive: true, mode: 0o700 }); try { chmodSync(home, 0o700); } catch { /* checked by the program */ }
    this.state.usedAt = this.now();
    return this.runner(tool, [...args, '--session', namespace(sessionId)], { ...opts, env: { AGENT_DESKTOP_HOME: home } });
  }
  opened(sessionId) { return this.state.chats[sessionId] || []; }
  /** Apps on the desktop. The apps this chat opened are marked. */
  async apps(sessionId) {
    this.owner(sessionId);
    const reply = await this.call(sessionId, ['list-apps']);
    const mine = new Set(this.opened(sessionId).map(app => app.pid));
    if (Array.isArray(reply?.data?.apps)) reply.data.apps = reply.data.apps.map(app => mine.has(app.pid) ? { ...app, openedByThisChat: true } : app);
    return reply;
  }
  async open(sessionId, { app, args = [] } = {}) {
    this.owner(sessionId); app = appName(app);
    if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new Error('app arguments must be text');
    const reply = await this.call(sessionId, ['launch', app, ...launchHints(app, this.platform), ...args.map(value => `--arg=${value}`)], { timeout: 45000 });
    const pid = reply?.data?.pid;
    if (reply?.ok && Number.isInteger(pid)) {
      const rows = this.opened(sessionId).filter(row => row.pid !== pid);
      this.state.chats[sessionId] = [...rows, { app, name: reply.data.app || app, pid, stamp: this.stamp(pid, this.platform), openedAt: this.now() }];
      this.save();
    }
    if (reply?.ok && !reply.data?.window && this.platform === 'linux') {
      reply.helm = `No window showed its controls yet. If ${app} was open before, it ignores the new settings: ask the owner, then run helm desktop restart "${app}". If it was not open before, run helm desktop switch on, then try again.`;
    }
    return reply;
  }
  /** Close an app that this chat opened. The owner's own apps stay open. */
  async close(sessionId, { app } = {}) {
    this.owner(sessionId); app = appName(app);
    const rows = this.opened(sessionId), match = rows.filter(row => [row.app, row.name, String(row.pid)].includes(app));
    if (!match.length) throw new Error(`This chat did not open ${app}. Ask the owner to close it, or ask first and then use helm desktop restart.`);
    const closed = [];
    for (const row of match) if (this.end(row)) closed.push(row.pid);
    this.state.chats[sessionId] = rows.filter(row => !match.includes(row));
    if (!this.state.chats[sessionId].length) delete this.state.chats[sessionId];
    this.save();
    return { ok: true, closed };
  }
  end(row) {
    // A process number that now belongs to another process is left alone.
    if (row.stamp == null || this.stamp(row.pid, this.platform) !== row.stamp) return false;
    try { this.kill(row.pid, 'SIGTERM'); return true; } catch { return false; }
  }
  /** Close an open app and start it again so that it shows its controls. Agents ask the owner first. */
  async restart(sessionId, { app, args = [] } = {}) {
    this.owner(sessionId); app = appName(app);
    const closed = await this.call(sessionId, ['close-app', app], { timeout: 45000 });
    if (!closed?.ok && closed?.error?.code !== 'APP_NOT_FOUND') return { ...closed, helm: `Helm did not close ${app}. Ask the owner to close it, then run helm desktop open "${app}".` };
    return this.open(sessionId, { app, args });
  }
  async look(sessionId, { app, args = [] } = {}) {
    this.owner(sessionId); app = appName(app);
    return this.call(sessionId, ['snapshot', '--app', app, '-i', '--compact', ...args]);
  }
  async guide(sessionId, { topic = '' } = {}) {
    this.owner(sessionId);
    const [skill = 'desktop', reference] = String(topic).split(/\s+/).filter(Boolean);
    const reply = await this.call(sessionId, ['skills', 'get', skill, ...(reference ? [reference] : [])]);
    // Their guide names their program; in a chat the same commands go through Helm.
    const content = reply?.data?.content;
    return typeof content === 'string' ? { ok: true, guide: `In Helm, write helm desktop where this guide writes agent-desktop. Use helm desktop open in place of launch, and helm desktop close in place of close-app.\n\n${content}` } : reply;
  }
  /** Any other command of the program, in this chat's namespace. */
  async run(sessionId, { args } = {}) {
    this.owner(sessionId);
    if (!Array.isArray(args) || !args.length || args.some(value => typeof value !== 'string')) throw new Error('name a desktop command, for example helm desktop status');
    if (OWN[args[0]]) throw new Error(`Use ${OWN[args[0]]} in place of ${args[0]}.`);
    return this.call(sessionId, args, { timeout: 120000 });
  }
  /** The screen-reader switch, which Helm turns off again after some time without desktop use. */
  async switch(sessionId, { on } = {}) {
    this.owner(sessionId);
    if (this.platform !== 'linux') return { ok: true, note: 'Only Linux has this switch. Apps here show their controls without it.' };
    const was = await this.a11y.get();
    if (on === undefined) return { ok: true, on: was, helmTurnedOn: this.state.switchOn };
    const ours = this.state.switchOn;
    if (on && !was) { await this.a11y.set(true); this.state.switchOn = true; }
    if (!on && ours) { await this.a11y.set(false); this.state.switchOn = false; }
    this.state.usedAt = this.now(); this.save();
    if (!on) return { ok: true, on: await this.a11y.get(), ...(was && !ours ? { note: 'Helm did not turn this switch on, so it stays on.' } : {}) };
    return { ok: true, on: true, note: 'Apps started from now on show their controls. Restart an app that was open before. Helm turns the switch off after 10 minutes without desktop use.' };
  }
  /** Turn the switch off when no chat used the desktop for a while, if Helm turned it on. */
  async sweep() {
    if (!this.state.switchOn || this.now() - this.state.usedAt < this.switchIdleMs) return;
    await this.a11y.set(false).catch(() => {});
    this.state.switchOn = false; this.save();
  }
  start() {
    this.timer ||= setInterval(() => void this.sweep().catch(() => {}), 60000); this.timer.unref?.();
    void this.sweep().catch(() => {});
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  /** A deleted chat's apps close with it. */
  forget(sessionId) {
    const rows = this.state.chats[sessionId]; if (!rows) return;
    for (const row of rows) this.end(row);
    delete this.state.chats[sessionId]; this.save();
  }
}

export function createDesktopRoutes({ sessions, manager = new DesktopManager({ session: id => { try { return sessions.get(id); } catch { return null; } } }) } = {}) {
  return {
    manager,
    start: () => manager.start(),
    stop: () => manager.stop(),
    sessionChanged(session) {
      if (!session) return;
      if (!session.deleted) { if (session.status !== 'exited') return; try { if (sessions.get(session.id)) return; } catch { /* deleted */ } }
      manager.forget(session.id);
    },
    async dispatch(method, p) {
      const name = method.slice('desktop.'.length);
      if (!['apps', 'open', 'close', 'restart', 'look', 'guide', 'run', 'switch'].includes(name)) throw new Error(`unknown desktop method: ${method}`);
      return manager[name](p.id, p);
    },
  };
}
