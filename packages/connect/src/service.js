import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { platform, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { delimiter } from 'node:path';
import { HOME } from './paths.js';

const exec = promisify(execFile);
const AGENT_UNIT = 'con-agent.service';
const SERVE_UNIT = 'con-serve.service';
const unitDir = join(HOME, '.config/systemd/user');
const binPath = fileURLToPath(new URL('../bin/con.js', import.meta.url));

/** Quote one systemd ExecStart/Environment value without involving a shell. */
export function systemdArg(value) {
  const text = String(value);
  if (/[\0\r\n]/.test(text)) throw new Error('service arguments cannot contain newlines');
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
}

/**
 * Install con as a user service so the machine reconnects on its own after a
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

  if (process.env.CON_NO_SERVICE === '1' || process.env.HELM_NO_SERVICE === '1') {
    console.log('(skipping service install: CON_NO_SERVICE=1)');
    return { installed: false };
  }
  if (platform() !== 'linux') {
    console.log(
      `\nautomatic service install is Linux-only for now. Run this to keep con up:\n` +
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
  try {
    const { stdout } = await exec('sh', ['-lc', 'command -v herdr']);
    if (stdout.trim()) herdrBin = `Environment=${systemdArg(`CON_HERDR_BIN=${stdout.trim()}`)}\n`;
  } catch { /* fall back to PATH lookup at run time */ }

  writeFileSync(
    join(unitDir, UNIT),
    `[Unit]
Description=con ${mode}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${[process.execPath, binPath, ...command].map(systemdArg).join(' ')}
Restart=always
RestartSec=3
Environment=NODE_ENV=production
Environment=${systemdArg(`PATH=${searchPath}`)}
${herdrBin}
[Install]
WantedBy=default.target
`
  );

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
  if (process.env.CON_NO_SERVICE === '1' || process.env.HELM_NO_SERVICE === '1') return { removed: false };
  if (platform() !== 'linux') return { removed: false };
  await exec('systemctl', ['--user', 'disable', '--now', UNIT]).catch(() => {});
  const file = join(unitDir, UNIT);
  if (existsSync(file)) rmSync(file);
  await exec('systemctl', ['--user', 'daemon-reload']).catch(() => {});
  return { removed: true };
}
