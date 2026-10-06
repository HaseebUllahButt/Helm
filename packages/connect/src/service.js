import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { platform, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { delimiter } from 'node:path';
import { HOME } from './paths.js';

const exec = promisify(execFile);
const AGENT_UNIT = 'helm-agent.service';
const SERVE_UNIT = 'helm-serve.service';
const unitDir = join(HOME, '.config/systemd/user');
const binPath = fileURLToPath(new URL('../bin/helm.js', import.meta.url));
const LAUNCH_LABEL = 'dev.helm.serve';
const launchFile = join(HOME, 'Library/LaunchAgents', `${LAUNCH_LABEL}.plist`);
const launchDomain = () => `gui/${userInfo().uid}`;
const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

/** Quote one systemd ExecStart/Environment value without involving a shell. */
export function systemdArg(value) {
  const text = String(value);
  if (/[\0\r\n]/.test(text)) throw new Error('service arguments cannot contain newlines');
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
}

/**
 * Install helm as a user service so the machine reconnects on its own after a
 * reboot. A user unit rather than a system one: it runs as you, with your
 * agents' credentials, and needs no root.
 */
/**
 * @param {object} [opts]
 * @param {'agent'|'serve'} [opts.mode]  'agent' joins a relay; 'serve' hosts one here
 * @param {string[]} [opts.args]         extra arguments for the serve unit
 */
export async function installService({ mode = 'agent', args = [] } = {}) {
  const UNIT = mode === 'serve' ? SERVE_UNIT : AGENT_UNIT;
  // Both modes do the same thing now: every machine runs a hub and a daemon,
  // because any machine has to be able to answer a phone on its own.
  const command = ['up', ...args];

  if (process.env.HELM_NO_SERVICE === '1') {
    console.log('(skipping service install: HELM_NO_SERVICE=1)');
    return { installed: false };
  }
  if (platform() === 'darwin') {
    const searchPath = [join(HOME, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].filter(Boolean).join(':');
    const logs = join(HOME, 'Library/Logs/helm');
    mkdirSync(logs, { recursive: true });
    mkdirSync(join(HOME, 'Library/LaunchAgents'), { recursive: true });
    writeFileSync(launchFile, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LAUNCH_LABEL}</string>
<key>ProgramArguments</key><array>${[process.execPath, binPath, ...command].map((v) => `<string>${xml(v)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(searchPath)}</string><key>NODE_ENV</key><string>production</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(join(logs, 'serve.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(logs, 'serve.log'))}</string>
</dict></plist>\n`);
    await exec('launchctl', ['bootout', `${launchDomain()}/${LAUNCH_LABEL}`]).catch(() => {});
    await exec('launchctl', ['bootstrap', launchDomain(), launchFile]);
    return { installed: true, unit: LAUNCH_LABEL };
  }
  if (platform() !== 'linux') {
    console.log(
      `\nautomatic service install supports Linux and macOS. Run this to keep helm up:\n` +
      `  ${process.execPath} ${binPath} run\n`
    );
    return { installed: false };
  }

  mkdirSync(unitDir, { recursive: true });

  // systemd hands a unit a minimal PATH, which will not include the places a
  // single-binary tool installs itself. Carry the paths that matter, and pin
  // the runtime binary outright if we can find it now.
  const searchPath = [
    join(HOME, '.local/bin'), join(HOME, 'bin'),
    '/usr/local/bin', '/usr/bin', '/bin',
    ...(process.env.PATH ?? '').split(delimiter),
  ].filter((p, i, a) => p && a.indexOf(p) === i).join(':');

  let herdrBin = '';
  if (process.env.HELM_HERDR_BIN?.trim()) {
    herdrBin = `Environment=${systemdArg(`HELM_HERDR_BIN=${process.env.HELM_HERDR_BIN.trim()}`)}\n`;
  } else {
    try {
      // Resolve against the PATH we put in the unit. A login shell can rewrite
      // PATH and select a different Herdr install than helm's own launcher.
      const { stdout } = await exec('sh', ['-c', 'command -v herdr'], {
        env: { ...process.env, PATH: searchPath },
      });
      if (stdout.trim()) herdrBin = `Environment=${systemdArg(`HELM_HERDR_BIN=${stdout.trim()}`)}\n`;
    } catch { /* fall back to PATH lookup at run time */ }
  }

  writeFileSync(
    join(unitDir, UNIT),
    `[Unit]
Description=helm ${mode}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${[process.execPath, binPath, ...command].map(systemdArg).join(' ')}
# Session hosts normally run in their own transient unit. Keep a detached
# fallback host alive across a daemon restart too; the host owns the long-lived
# terminal and agent processes that the daemon reconnects to afterward.
KillMode=process
Restart=always
RestartSec=3
Environment=NODE_ENV=production
Environment=${systemdArg(`PATH=${searchPath}`)}
${herdrBin}
[Install]
WantedBy=default.target
`
  );

  // No GitHub timer: machines keep each other on the owner's own newest
  // saved version (agent.js), and GitHub is a button in Settings.
  await (await import('./update.js')).removeUpdateTimer().catch(() => {});

  await exec('systemctl', ['--user', 'daemon-reload']);
  // `enable --now` does not restart a unit that is already active, so a
  // re-install with different arguments (say, a new --advertise address after
  // the VM's IP changed) would leave the old process running with the old
  // ones. Restart starts an inactive unit and replaces an active one alike.
  await exec('systemctl', ['--user', 'enable', UNIT]);
  await exec('systemctl', ['--user', 'restart', UNIT]);

  // Without lingering the unit stops when the last login session ends, which
  // is exactly wrong for a machine you want to reach while logged out.
  let lingering = true;
  await exec('loginctl', ['enable-linger']).catch(() => { lingering = false; });
  if (!lingering) {
    console.warn(
      `  warning: this service may stop when you log out. Fix it with:\n` +
      `    sudo loginctl enable-linger ${userInfo().username}`
    );
  }
  return { installed: true, unit: UNIT, lingering };
}

export async function uninstallService({ mode = 'agent' } = {}) {
  const UNIT = mode === 'serve' ? SERVE_UNIT : AGENT_UNIT;
  if (process.env.HELM_NO_SERVICE === '1') return { removed: false };
  if (platform() === 'darwin') {
    await exec('launchctl', ['bootout', `${launchDomain()}/${LAUNCH_LABEL}`]).catch(() => {});
    const removed = existsSync(launchFile);
    rmSync(launchFile, { force: true });
    return { removed };
  }
  if (platform() !== 'linux') return { removed: false };
  await exec('systemctl', ['--user', 'disable', '--now', UNIT]).catch(() => {});
  await (await import('./update.js')).removeUpdateTimer().catch(() => {});
  const file = join(unitDir, UNIT);
  if (existsSync(file)) rmSync(file);
  await exec('systemctl', ['--user', 'daemon-reload']).catch(() => {});
  return { removed: true };
}

/** Pause running Helm units before changing this machine's network. */
export async function pauseServices() {
  if (process.env.HELM_NO_SERVICE === '1') return [];
  if (platform() === 'darwin') {
    const active = await exec('launchctl', ['print', `${launchDomain()}/${LAUNCH_LABEL}`]).then(() => true, () => false);
    if (!active) return [];
    await exec('launchctl', ['bootout', `${launchDomain()}/${LAUNCH_LABEL}`]);
    return [LAUNCH_LABEL];
  }
  if (platform() !== 'linux') return [];
  const active = [];
  try {
    for (const unit of [SERVE_UNIT, AGENT_UNIT]) {
      const running = await exec('systemctl', ['--user', 'is-active', unit])
        .then(({ stdout }) => stdout.trim() === 'active', () => false);
      if (running) {
        await exec('systemctl', ['--user', 'stop', unit]);
        active.push(unit);
      }
    }
  } catch (err) {
    await resumeServices(active);
    throw err;
  }
  return active;
}

export async function resumeServices(units) {
  if (platform() === 'darwin') {
    if (units.length) await exec('launchctl', ['bootstrap', launchDomain(), launchFile]);
    return;
  }
  for (const unit of units) await exec('systemctl', ['--user', 'start', unit]);
}

/** Reinstalling preserves an existing home's listen/advertise arguments. */
export async function startService({ port = 8787 } = {}) {
  if (platform() === 'darwin' && process.env.HELM_NO_SERVICE !== '1' && existsSync(launchFile)) {
    await exec('launchctl', ['bootout', `${launchDomain()}/${LAUNCH_LABEL}`]).catch(() => {});
    await exec('launchctl', ['bootstrap', launchDomain(), launchFile]);
    return { installed: true, unit: LAUNCH_LABEL };
  }
  if (platform() === 'linux' && process.env.HELM_NO_SERVICE !== '1') {
    for (const unit of [SERVE_UNIT, AGENT_UNIT]) {
      if (existsSync(join(unitDir, unit))) {
        await exec('systemctl', ['--user', 'daemon-reload']);
        await exec('systemctl', ['--user', 'enable', unit]);
        await exec('systemctl', ['--user', 'restart', unit]);
        return { installed: true, unit };
      }
    }
  }
  return installService({ mode: 'serve', args: ['--port', String(port)] });
}
