import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HELM_DIR } from '../paths.js';
import { DEVICE_LIMITS as L } from '../../../protocol/devices.js';
import { inspectDeviceTools, runDeviceTool, launchEmulator } from './toolchain.js';
import { deviceQuickStart } from './instructions.js';

const text = (value) => Buffer.from(value).toString('utf8').trim();
const shellQuote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
const KEY_CODES = { home: 3, back: 4, enter: 66, backspace: 67, menu: 82, power: 26, 'volume-up': 24, 'volume-down': 25 };
const IOS_KEYS = { home: ['home'], enter: ['type', '\n'], backspace: ['type', '\b'] };
export function pngFrame(png, at = Date.now()) {
  if (!Buffer.isBuffer(png)) png = Buffer.from(png);
  if (png.length > L.frameBytes) throw new Error('Screenshot exceeds the 4 MiB frame limit. Reduce device resolution or display complexity.');
  if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || png.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Device did not return a PNG screenshot.');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  if (!width || !height || width > 16384 || height > 16384 || width * height > 64_000_000) throw new Error('Invalid screenshot dimensions.');
  return { data: png.toString('base64'), mimeType: 'image/png', width, height, at };
}

/** Pull streaming is deliberate: a slow watcher creates no producer backlog. */
export class DeviceService {
  constructor({ inspect = inspectDeviceTools, run = runDeviceTool, launch = launchEmulator, env = process.env,
    directory = join(HELM_DIR, 'devices'), now = Date.now, pause = (ms) => new Promise((r) => setTimeout(r, ms)), limits = {} } = {}) {
    this.inspect = inspect; this.run = run; this.launch = launch; this.env = env;
    this.directory = directory; this.now = now; this.pause = pause; this.limits = { ...L, ...limits };
    this.watchers = new Map(); this.streams = new Map(); this.sessions = new Map(); this.starting = new Map();
    this.cleanupError = null; this.agentUsed = false; this.agentActive = 0; this.lastAgent = 0; this.stopped = false;
    this.cleanup = null; this.operations = new Set(); this.captureActive = 0; this.actionQueues = new Map(); this.screens = new Map();
  }
  readiness() { return this.inspect({ env: this.env }); }
  async tool(command, args, options = {}) {
    if (this.stopped) throw new Error('Device service is stopped.');
    if (this.operations.size >= 16) throw new Error('Device tools are busy. Wait for the current operations to finish.');
    const controller = new AbortController(); this.operations.add(controller);
    try { return await this.run(command, args, { env: this.env, ...options, signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal }); }
    finally { this.operations.delete(controller); }
  }
  async list({ sessionId } = {}) {
    const readiness = this.readiness(), { tools } = readiness, errors = this.cleanupError ? [this.cleanupError] : [], devices = [];
    const results = await Promise.allSettled([
      tools.adb ? this.android(tools) : [],
      tools.xcrun ? this.ios(tools) : [],
    ]);
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') devices.push(...result.value);
      else { const reason = result.reason.message; errors.push(`${i ? 'iOS' : 'Android'}: ${reason}`); readiness[i ? 'ios' : 'android'] = { ...readiness[i ? 'ios' : 'android'], available: false, reason }; }
    });
    return { readiness, devices, errors, sessions: [...this.sessions.values()].filter((s) => !sessionId || s.sessionId === sessionId) };
  }
  async android(tools) {
    const rows = text(await this.tool(tools.adb, ['devices', '-l'])).split('\n').slice(1).filter(Boolean);
    const devices = [];
    for (const line of rows.slice(0, 64)) {
      const [serial, state] = line.trim().split(/\s+/);
      if (!serial || !state || serial.startsWith('*')) continue;
      const model = /\bmodel:(\S+)/.exec(line)?.[1]?.replaceAll('_', ' ');
      const emulator = serial.startsWith('emulator-');
      let avd;
      if (emulator && state === 'device') {
        try { avd = text(await this.tool(tools.adb, ['-s', serial, 'emu', 'avd', 'name'], { timeout: 5000 })).split('\n')[0]; } catch { /* ADB still gives a usable explicit serial. */ }
      }
      devices.push({ id: `android:${serial}`, target: serial, name: avd || model || serial, platform: 'android', kind: emulator ? 'emulator' : 'physical', state: state === 'device' ? 'running' : state === 'unauthorized' ? 'unauthorized' : 'offline', control: true, ...(avd ? { avd } : {}) });
    }
    if (tools.emulator) {
      for (const avd of text(await this.tool(tools.emulator, ['-list-avds'])).split('\n').filter(Boolean).slice(0, 64)) {
        if (!devices.some((d) => d.avd === avd)) devices.push({ id: `avd:${avd}`, target: avd, avd, name: avd, platform: 'android', kind: 'emulator', state: 'stopped', control: true });
      }
    }
    return devices;
  }
  async ios(tools) {
    const value = JSON.parse(text(await this.tool(tools.xcrun, ['simctl', 'list', 'devices', 'available', '--json'])));
    return Object.entries(value.devices || {}).flatMap(([runtime, rows]) => rows.filter((d) => d.isAvailable !== false).map((d) => ({
      id: `ios:${d.udid}`, target: d.udid, name: d.name, platform: 'ios', kind: 'simulator', state: d.state === 'Booted' ? 'running' : 'stopped', version: runtime.split('.').pop(), control: !!tools.agent,
    }))).slice(0, 128);
  }
  async device(deviceId) {
    if (typeof deviceId !== 'string' || deviceId.length > 256) throw new Error('A valid device ID is required. Run helm device list.');
    const { devices } = await this.list();
    const device = devices.find((d) => d.id === deviceId);
    if (!device) throw new Error(`Device ${deviceId} was not found. Refresh the device list.`);
    return device;
  }
  async start({ deviceId }) {
    if (this.starting.has(deviceId)) return this.starting.get(deviceId);
    if (this.starting.size >= 4) throw new Error('Too many devices are starting.');
    const promise = this.boot(deviceId).finally(() => this.starting.delete(deviceId));
    this.starting.set(deviceId, promise); return promise;
  }
  async boot(deviceId) {
    const device = await this.device(deviceId), { tools } = this.readiness();
    if (device.state === 'running') return { device };
    if (device.state === 'unauthorized') throw new Error('Accept the USB debugging RSA prompt on the Android device, then refresh.');
    if (device.kind === 'physical' || device.state === 'offline') throw new Error('Reconnect the device and verify adb devices -l shows device.');
    if (device.platform === 'ios') {
      await this.tool(tools.xcrun, ['simctl', 'boot', device.target]);
      await this.tool(tools.xcrun, ['simctl', 'bootstatus', device.target, '-b'], { timeout: 180_000 });
      return { device: { ...device, state: 'running' } };
    }
    if (!tools.emulator || !tools.adb) throw new Error('Starting Android emulators requires installed adb and Android Emulator.');
    await this.launch(tools.emulator, ['-avd', device.avd, '-no-snapshot-load', '-no-boot-anim', ...(!this.env.DISPLAY && !this.env.WAYLAND_DISPLAY && process.platform === 'linux' ? ['-no-window'] : [])], { env: this.env });
    const deadline = this.now() + 180_000;
    while (this.now() < deadline && !this.stopped) {
      await this.pause(1000);
      const current = (await this.android(tools)).find((d) => d.avd === device.avd && d.state === 'running');
      if (current && text(await this.tool(tools.adb, ['-s', current.target, 'shell', 'getprop', 'sys.boot_completed'])) === '1') return { device: current };
    }
    throw new Error('Emulator boot timed out. Check Android Emulator acceleration and the existing AVD in Android Studio; no SDKs were downloaded.');
  }
  async open({ deviceId, sessionId }) {
    const { device } = await this.start({ deviceId });
    if (sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length > 128) throw new Error('Invalid thread ID.');
      if (!this.sessions.has(sessionId) && this.sessions.size >= this.limits.sessions) throw new Error('Too many open thread devices. Close a thread device first.');
      this.sessions.set(sessionId, { sessionId, deviceId: device.id });
    }
    return { device, sessionId: sessionId || null, quickStart: deviceQuickStart(device) };
  }
  close({ sessionId }) { this.sessions.delete(sessionId); return { ok: true }; }
  ensureCleanup() {
    if (!this.cleanup) { this.cleanup = setInterval(() => { void this.sweep().catch((error) => { this.cleanupError = `Device dependency cleanup: ${error.message}`; this.lastAgent = this.now(); }); }, 1000); this.cleanup.unref?.(); }
  }
  async watch({ deviceId }, caller) {
    const device = await this.device(deviceId);
    if (device.state !== 'running') throw new Error('Start the device before watching.');
    await this.sweep();
    if (this.watchers.size >= this.limits.watchers) throw new Error('Too many device viewers.');
    if (!this.streams.has(device.id) && this.streams.size >= this.limits.streams) throw new Error('Too many devices are being watched.');
    const watchId = randomBytes(16).toString('hex');
    this.watchers.set(watchId, { caller, device, expires: this.now() + this.limits.leaseMs, pending: false });
    if (!this.streams.has(device.id)) this.streams.set(device.id, { last: 0, frame: null, pending: null, controller: new AbortController() });
    this.ensureCleanup();
    return { watchId, device, leaseMs: this.limits.leaseMs, intervalMs: this.limits.frameIntervalMs };
  }
  watcher(watchId, caller) {
    const watcher = this.watchers.get(watchId);
    if (!watcher || watcher.caller !== caller || watcher.expires <= this.now()) throw new Error('Device viewer expired or belongs to another client. Open the viewer again.');
    return watcher;
  }
  unwatch({ watchId }, caller) {
    this.watcher(watchId, caller); this.watchers.delete(watchId); this.prune(); return { ok: true };
  }
  prune() {
    for (const [id, stream] of this.streams) if (![...this.watchers.values()].some((w) => w.device.id === id)) { stream.controller.abort(); this.streams.delete(id); }
    if (!this.watchers.size && !this.agentUsed) { clearInterval(this.cleanup); this.cleanup = null; }
  }
  async sweep() {
    for (const [id, w] of this.watchers) if (w.expires <= this.now()) this.watchers.delete(id);
    this.prune();
    if (this.agentUsed && !this.agentActive && this.now() - this.lastAgent > 60_000 && !this.agentStopping) {
      this.agentStopping = this.stopAgent().finally(() => { this.agentStopping = null; });
      await this.agentStopping;
    }
  }
  async frame({ watchId }, caller) {
    const watcher = this.watcher(watchId, caller);
    if (watcher.pending) throw new Error('A frame request is already in flight for this viewer.');
    watcher.pending = true; watcher.expires = this.now() + this.limits.leaseMs;
    const stream = this.streams.get(watcher.device.id);
    try {
      if (!stream.pending) {
        stream.pending = (async () => {
          if (stream.frame && this.now() - stream.last < this.limits.frameIntervalMs) return stream.frame;
          const frame = await this.capture(watcher.device, stream.controller.signal);
          if (this.streams.get(watcher.device.id) === stream) { stream.frame = frame; stream.last = this.now(); }
          return frame;
        })().finally(() => { stream.pending = null; });
      }
      const frame = await stream.pending;
      this.watcher(watchId, caller); watcher.expires = this.now() + this.limits.leaseMs;
      return frame;
    } finally { watcher.pending = false; }
  }
  async capture(device, signal) {
    if (this.captureActive >= this.limits.streams) throw new Error('Device screenshots are busy. Retry after the current captures finish.');
    this.captureActive++;
    try { return await this.captureDevice(device, signal); } finally { this.captureActive--; }
  }
  async captureDevice(device, signal) {
    if (device.state !== 'running') throw new Error('Start the device before capturing a screenshot.');
    const { tools } = this.readiness();
    if (device.platform === 'android') return pngFrame(await this.tool(tools.adb, ['-s', device.target, 'exec-out', 'screencap', '-p'], { signal }), this.now());
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(this.directory, 'capture-'));
    try {
      const path = join(dir, 'screen.png');
      await this.tool(tools.xcrun, ['simctl', 'io', device.target, 'screenshot', '--type=png', path], { signal });
      const png = await readFile(path), frame = pngFrame(png, this.now());
      // simctl PNGs are pixels; agent-device's Apple runner takes logical points.
      if (!this.screens.has(device.id) && this.screens.size >= 128) this.screens.delete(this.screens.keys().next().value);
      this.screens.set(device.id, { width: frame.width, height: frame.height });
      return frame;
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  async screenshot({ deviceId }) { return this.capture(await this.device(deviceId)); }
  async iosPoints(device, values) {
    let screen = this.screens.get(device.id);
    if (!screen) { await this.capture(device); screen = this.screens.get(device.id); }
    const { tools } = this.readiness();
    const native = await Promise.all(['WIDTH', 'HEIGHT', 'SCALE'].map(async (field) => Number(text(await this.tool(tools.xcrun, ['simctl', 'getenv', device.target, `SIMULATOR_MAINSCREEN_${field}`], { timeout: 5000 })))));
    if (native.some((v) => !Number.isFinite(v) || v <= 0) || native[2] < 1 || native[2] > 4) throw new Error('Cannot calibrate iOS input: simctl did not report valid display dimensions and scale. Use agent-device snapshot refs or verify Xcode simulator setup.');
    let pointWidth = native[0] / native[2], pointHeight = native[1] / native[2];
    if ((screen.width > screen.height) !== (pointWidth > pointHeight)) [pointWidth, pointHeight] = [pointHeight, pointWidth];
    return values.map((v, i) => String(Math.round(v * (i % 2 ? pointHeight / screen.height : pointWidth / screen.width))));
  }
  async action(params) {
    const id = params.deviceId;
    if (typeof id !== 'string' || id.length > 256) throw new Error('A valid device ID is required.');
    let queue = this.actionQueues.get(id);
    if (!queue) {
      if (this.actionQueues.size >= 64) throw new Error('Too many devices are receiving input.');
      queue = { tail: Promise.resolve(), count: 0 }; this.actionQueues.set(id, queue);
    }
    if (queue.count >= 16) throw new Error('Device input is busy. Wait for current actions to finish.');
    queue.count++;
    const task = queue.tail.then(() => this.performAction(params));
    queue.tail = task.catch(() => {});
    try { return await task; } finally { if (--queue.count === 0) this.actionQueues.delete(id); }
  }
  async performAction({ deviceId, action, sessionId }) {
    if (!action || typeof action !== 'object') throw new Error('A device action is required.');
    const device = await this.device(deviceId), { tools } = this.readiness();
    if (device.state !== 'running') throw new Error('Start the device before sending input.');
    const coords = (...values) => values.map((v) => { if (!Number.isFinite(v) || v < 0 || v > 16384) throw new Error('Coordinates must be finite pixels between 0 and 16384.'); return String(Math.round(v)); });
    let args;
    if (action.type === 'tap') args = ['input', 'tap', ...coords(action.x, action.y)];
    else if (action.type === 'swipe') {
      const duration = action.duration ?? 300;
      if (!Number.isInteger(duration) || duration < 50 || duration > 5000) throw new Error('Swipe duration must be 50–5000 ms.');
      args = ['input', 'swipe', ...coords(action.x, action.y, action.x2, action.y2), String(duration)];
    } else if (action.type === 'type') {
      if (typeof action.text !== 'string' || !action.text.length || action.text.length > 4096 || /\0/.test(action.text)) throw new Error('Text must contain 1–4096 characters without NUL.');
      if (device.platform === 'android' && !tools.agent && (!/^[\x20-\x7e]*$/.test(action.text) || action.text.includes('%'))) throw new Error('Native ADB text entry supports printable ASCII without %. Install agent-device explicitly for richer text input.');
      args = ['input', 'text', shellQuote(action.text.replaceAll(' ', '%s'))];
    } else if (action.type === 'key') {
      if (!Object.hasOwn(KEY_CODES, action.key)) throw new Error('Unsupported device key.');
      args = ['input', 'keyevent', String(KEY_CODES[action.key])];
    } else if (action.type === 'open') {
      if ((!action.url && !action.app) || (action.url && (typeof action.url !== 'string' || action.url.length > 4096 || !/^[a-z][a-z0-9+.-]*:/i.test(action.url))) || (action.app && (typeof action.app !== 'string' || !/^[\w.]+$/.test(action.app)))) throw new Error('Provide an app package/bundle ID or a valid deep-link URL.');
      if (device.platform === 'ios') {
        if (tools.agent) await this.agent({ deviceId, sessionId, args: ['open', ...(action.app ? [action.app] : []), ...(action.url ? [action.url] : [])] });
        else await this.tool(tools.xcrun, ['simctl', action.url ? 'openurl' : 'launch', device.target, action.url || action.app]);
        return { ok: true };
      }
      args = action.url ? ['am', 'start', '-a', 'android.intent.action.VIEW', '-d', shellQuote(action.url), ...(action.app ? ['-p', action.app] : [])] : ['monkey', '-p', action.app, '-c', 'android.intent.category.LAUNCHER', '1'];
    } else throw new Error('Unsupported device action.');
    if (device.platform === 'ios' || (action.type === 'type' && tools.agent)) {
      if (!tools.agent) throw new Error('iOS interactive control requires installed agent-device. See setup instructions.');
      let command;
      if (action.type === 'tap') command = ['press', ...(device.platform === 'ios' ? await this.iosPoints(device, [action.x, action.y]) : coords(action.x, action.y))];
      else if (action.type === 'swipe') command = ['swipe', ...(device.platform === 'ios' ? await this.iosPoints(device, [action.x, action.y, action.x2, action.y2]) : coords(action.x, action.y, action.x2, action.y2))];
      else if (action.type === 'type') command = ['type', action.text];
      else { if (!IOS_KEYS[action.key]) throw new Error('This key is not available on iOS simulators.'); command = IOS_KEYS[action.key]; }
      await this.agent({ deviceId, args: command, sessionId });
    } else await this.tool(tools.adb, ['-s', device.target, 'shell', ...args]);
    const stream = this.streams.get(device.id); if (stream) stream.frame = null;
    return { ok: true };
  }
  async agent({ deviceId, args, sessionId }) {
    if (!Array.isArray(args) || !args.length || args.length > 32 || args.some((a) => typeof a !== 'string' || a.length > 4096) || args.reduce((n, a) => n + a.length, 0) > 16_384) throw new Error('Invalid agent-device arguments.');
    // Prevent target/config/daemon overrides and arbitrary daemon lifecycle actions.
    const allowed = new Set(['open','snapshot','click','press','fill','type','swipe','home','back','keyboard','wait','get','is','find','scroll']);
    const safeFlags = new Set(['-i','--json','--settle','--verify','--timeout','--depth','--filter','--delay-ms','--hold-ms','--count','--interval-ms']);
    if (!allowed.has(args[0]) || args.some((a) => a.startsWith('-') && !safeFlags.has(a.split('=')[0])) || args.some((a) => /^--(?:platform|device|serial|udid|session|config|state-dir|daemon|remote|provider|host|port|output)(?:[-=]|$)/.test(a))) throw new Error('Use a device interaction command without target or daemon overrides.');
    const device = await this.device(deviceId), { tools } = this.readiness();
    if (!tools.agent) throw new Error('agent-device is not installed on the selected machine. Install it explicitly; no automatic download was attempted.');
    if (device.state !== 'running') throw new Error('Start the device first.');
    if (this.agentStopping) await this.agentStopping;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stateDir = join(this.directory, 'agent-device');
    const configPath = join(this.directory, 'agent-device-config.json');
    await writeFile(configPath, '{}\n', { flag: 'wx', mode: 0o600 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    if ((await readFile(configPath, 'utf8')).trim() !== '{}') throw new Error('Helm device agent config must be empty; remove the modified private config before retrying.');
    const agentEnv = Object.fromEntries(Object.entries(this.env).filter(([key]) => !key.startsWith('AGENT_DEVICE_')));
    Object.assign(agentEnv, { AGENT_DEVICE_STATE_DIR: stateDir, AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1', AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH: join(stateDir, 'apple-runner', 'derived') });
    this.cleanupError = null; this.agentUsed = true; this.agentActive++; this.ensureCleanup();
    const session = 'helm-' + createHash('sha256').update(JSON.stringify([sessionId || 'manual', device.id])).digest('hex').slice(0, 24);
    try {
      const out = await this.tool(tools.agent, [...args, '--platform', device.platform, device.platform === 'ios' ? '--udid' : '--serial', device.target, '--config', configPath, '--session', session], {
        timeout: 180_000, maxBuffer: 1024 * 1024,
        env: agentEnv,
      });
      return { ok: true, output: text(out) };
    } finally { this.agentActive--; this.lastAgent = this.now(); }
  }
  async stopAgent() {
    const { tools } = this.readiness();
    if (!this.agentUsed || !tools.agent) return;
    const cleanEnv = Object.fromEntries(Object.entries(this.env).filter(([key]) => !key.startsWith('AGENT_DEVICE_')));
    await this.run(tools.agent, ['daemon', 'stop', '--state-dir', join(this.directory, 'agent-device')], { env: { ...cleanEnv, AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1' }, timeout: 10_000, maxBuffer: 64 * 1024 });
    this.agentUsed = false; this.prune();
  }
  async stop() {
    this.stopped = true; clearInterval(this.cleanup); this.cleanup = null;
    for (const controller of this.operations) controller.abort();
    this.watchers.clear(); for (const stream of this.streams.values()) stream.controller.abort(); this.streams.clear(); this.sessions.clear(); this.screens.clear();
    await this.stopAgent().catch(() => {});
  }
}
