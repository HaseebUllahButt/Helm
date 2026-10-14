import { accessSync, constants, existsSync, readdirSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { DEVICE_LIMITS } from '../../../protocol/devices.js';

const executable = (path) => { try { accessSync(path, constants.X_OK); return path; } catch { return null; } };
const find = (name, paths, env, platform) => {
  const names = platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const dir of paths) for (const filename of names) { const hit = executable(join(dir, filename)); if (hit) return hit; }
  return null;
};
const installedPackage = (name, entry, roots) => {
  for (const root of roots) {
    const direct = join(root, 'node_modules', name, ...entry);
    if (existsSync(direct)) return direct;
    try {
      for (const version of readdirSync(join(root, 'tools', name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
        const candidate = join(root, 'tools', name, version, 'node_modules', name, ...entry);
        if (existsSync(candidate)) {
          try { if (readFileSync(join(root, 'tools', name, version, '.install-complete'), 'utf8').trim() === version) return candidate; } catch { /* Ignore partial installs. */ }
        }
      }
    } catch { /* No T3 tool install on this host. */ }
  }
  return null;
};
/** Inspect only: no downloads, daemon launches, or SDK creation. */
export function inspectDeviceTools({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  const path = (env.PATH || '').split(delimiter).filter(Boolean);
  const sdk = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, join(home, 'Android', 'Sdk'), join(home, 'Android', 'sdk'), join(home, 'Library', 'Android', 'sdk'), env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Android', 'Sdk')].filter(Boolean);
  const roots = [env.T3CODE_HOME, join(home, '.t3'), join(home, '.t3code')].filter(Boolean);
  const override = (key) => env[key] && existsSync(env[key]) ? env[key] : null;
  const tools = {
    adb: override('HELM_DEVICE_ADB') || find('adb', [...path, ...sdk.map((d) => join(d, 'platform-tools'))], env, platform),
    emulator: override('HELM_DEVICE_EMULATOR') || find('emulator', [...path, ...sdk.map((d) => join(d, 'emulator'))], env, platform),
    xcrun: platform === 'darwin' ? find('xcrun', [...path, '/usr/bin'], env, platform) : null,
    agent: override('HELM_AGENT_DEVICE') || find('agent-device', path, env, platform) || installedPackage('agent-device', ['bin', 'agent-device.mjs'], roots),
    hub: override('HELM_DEVICE_HUB') || find('expo-device-hub', path, env, platform) || installedPackage('expo-device-hub', ['dist', 'server', 'cli.mjs'], roots),
  };
  if (platform === 'win32' && tools.agent?.endsWith('.cmd')) {
    const entry = join(tools.agent.replace(/[\\/][^\\/]+$/, ''), 'node_modules', 'agent-device', 'bin', 'agent-device.mjs');
    tools.agent = existsSync(entry) ? entry : null;
  }
  return {
    platform, tools,
    android: { available: !!tools.adb, reason: tools.adb ? 'ADB installed; connect an authorized Android device or start an existing AVD.' : 'Android platform-tools (adb) were not found on this machine.', setup: [
      'Use Android Studio SDK Manager to install Android SDK Platform-Tools. Set ANDROID_HOME or ANDROID_SDK_ROOT to the existing SDK if Helm cannot find it.',
      tools.emulator ? 'Android Emulator is installed. Helm lists existing AVDs; create an AVD in Android Studio Device Manager if none exist.' : 'To test an emulator, install Android Emulator and a system image in Android Studio, then create an AVD in Device Manager. Helm never downloads SDKs or images.',
      'For a physical device, enable Developer options and USB debugging, connect USB, and accept the device RSA prompt. adb devices -l must show device, not unauthorized.',
    ] },
    ios: { available: platform === 'darwin' && !!tools.xcrun, reason: platform !== 'darwin' ? 'iOS simulators require a Mac with Xcode. Choose a reachable Mac in Helm.' : tools.xcrun ? 'Check Xcode simulator runtimes with xcrun simctl list devices available. Interactive input also needs agent-device.' : 'Xcode command-line tools were not found.', setup: [
      'On a Mac, install and open full Xcode, select its developer directory (xcode-select), and install a simulator runtime in Xcode Settings → Components.',
      'xcrun simctl list devices available must succeed. Command Line Tools alone do not include iOS simulator runtimes.',
      tools.agent ? `Installed agent-device: ${tools.agent}. First input may build its XCTest runner; allow time for that.` : 'Install agent-device explicitly with npm install -g agent-device for iOS taps, swipes and typing. Run agent-device doctor to verify Xcode. Helm never installs it automatically.',
    ] },
  };
}

/** Every child has a timeout and bounded output; arguments never pass through a local shell. */
export function runDeviceTool(command, args, { env = process.env, timeout = 20_000, maxBuffer = DEVICE_LIMITS.commandBytes, signal } = {}) {
  const script = /\.(?:mjs|cjs|js)$/.test(command);
  return new Promise((resolve, reject) => {
    execFile(script ? process.execPath : command, script ? [command, ...args] : args,
      { env, timeout, maxBuffer, encoding: 'buffer', signal, windowsHide: true }, (error, stdout, stderr) => {
        if (error) { reject(new Error(`${command.split(/[\\/]/).pop()}: ${Buffer.from(stderr || '').toString().trim().slice(0, 1000) || error.message}`)); return; }
        resolve(Buffer.from(stdout));
      });
  });
}
export function launchEmulator(command, args, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(child.pid); });
  });
}
