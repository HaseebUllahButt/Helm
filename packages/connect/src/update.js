import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { HOME } from './paths.js';
import { systemdArg } from './service.js';

const exec = promisify(execFile);
const binPath = fileURLToPath(new URL('../bin/helm.js', import.meta.url));
// The checkout to update is wherever this helm.js was installed - install.sh
// clones the repo there, so three levels up from bin/ is the deploy root.
const ROOT = resolve(dirname(binPath), '../../..');
const BRANCH = process.env.HELM_BRANCH || 'main';
const unitDir = join(HOME, '.config/systemd/user');

const UPDATE_SERVICE = 'helm-update.service';
const UPDATE_TIMER = 'helm-update.timer';
/** Daemon units an update should restart once it has landed. */
const DAEMON_UNITS = ['helm-serve.service', 'helm-agent.service'];

const say = (m) => console.log(`  ${m}`);

const unitActive = (unit) =>
  exec('systemctl', ['--user', 'is-active', '--quiet', unit]).then(() => true).catch(() => false);

/**
 * Pull the deployed checkout to the newest origin/BRANCH, rebuild the app and
 * restart the daemon. Guarded so it can never eat a working tree: only a
 * clean checkout already on the update branch is touched - a feature branch
 * or a dirty tree is somebody's development checkout, not a deployment.
 *
 * `rebuild`/`restart` are skippable so the git half can run in a test without
 * an npm install or a live service to bounce.
 */
export async function selfUpdate(dir = ROOT, { rebuild = true, restart = true } = {}) {
  const git = (args) => exec('git', ['-C', dir, ...args]).then((r) => r.stdout.trim());
  if (!existsSync(join(dir, '.git'))) return { updated: false, reason: `${dir} is not a git checkout` };
  if (!(await git(['remote', 'get-url', 'origin']).catch(() => ''))) {
    return { updated: false, reason: 'no origin remote' };
  }
  const on = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (on !== BRANCH) return { updated: false, reason: `checkout is on ${on}, not ${BRANCH}` };
  if (await git(['status', '--porcelain'])) return { updated: false, reason: 'uncommitted changes' };

  await git(['fetch', '--quiet', 'origin', BRANCH]);
  const [head, tip] = await Promise.all([git(['rev-parse', 'HEAD']), git(['rev-parse', `origin/${BRANCH}`])]);
  if (head === tip) return { updated: false, reason: `already at ${tip.slice(0, 7)}` };

  say(`updating ${head.slice(0, 7)} -> ${tip.slice(0, 7)}`);
  await git(['reset', '--hard', '--quiet', `origin/${BRANCH}`]);
  if (rebuild) {
    say('installing dependencies');
    await exec('npm', ['install', '--include=dev', '--silent', '--no-fund', '--no-audit'], { cwd: dir });
    say('building the app');
    await exec('npm', ['--workspace', '@helm/web', 'run', 'build', '--silent'], { cwd: dir });
  }

  if (!restart) return { updated: true, restarting: [] };
  // Restart through a transient timer rather than inline: whoever asked for
  // this update - a shell, or the daemon itself - is inside the cgroup a
  // direct restart would kill before it finished asking. The timer belongs
  // to the user manager and outlives the stop it requests.
  const restarting = [];
  const failed = [];
  for (const unit of DAEMON_UNITS) {
    if (!(await unitActive(unit))) continue;
    try {
      await exec('systemd-run', ['--user', '--on-active=5', '--unit=helm-self-restart',
        'systemctl', '--user', 'restart', unit]);
      restarting.push(unit);
    } catch {
      failed.push(unit);
    }
  }
  return { updated: true, restarting, failed };
}

/**
 * The pair that lets a machine follow new releases on its own: a oneshot
 * that self-updates, on a timer. Idempotent - written again only when the
 * content drifts - so the daemon can ensure it every start and a machine
 * that lands this code by any means keeps itself current from then on.
 */
export async function ensureUpdateTimer({ searchPath } = {}) {
  if (platform() !== 'linux' || process.env.HELM_NO_SERVICE === '1') return false;
  if (process.env.HELM_NO_UPDATE === '1') return false;
  mkdirSync(unitDir, { recursive: true });

  const service = `[Unit]
Description=helm self-update
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
TimeoutStartSec=0
ExecStart=${[process.execPath, binPath, 'self-update'].map(systemdArg).join(' ')}
Environment=NODE_ENV=production
${searchPath ? `Environment=${systemdArg(`PATH=${searchPath}`)}\n` : ''}`;
  const timer = `[Unit]
Description=helm self-update

[Timer]
OnBootSec=5min
OnUnitActiveSec=30min
RandomizedDelaySec=2min
Persistent=true

[Install]
WantedBy=timers.target
`;
  let wrote = false;
  for (const [name, text] of [[UPDATE_SERVICE, service], [UPDATE_TIMER, timer]]) {
    const file = join(unitDir, name);
    const prev = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (prev !== text) { writeFileSync(file, text); wrote = true; }
  }
  if (wrote) await exec('systemctl', ['--user', 'daemon-reload']);
  await exec('systemctl', ['--user', 'enable', '--now', UPDATE_TIMER]);
  return true;
}

/** Remove the update pair - the daemon's own unit is service.js's business. */
export async function removeUpdateTimer() {
  if (platform() !== 'linux') return;
  await exec('systemctl', ['--user', 'disable', '--now', UPDATE_TIMER]).catch(() => {});
  for (const name of [UPDATE_SERVICE, UPDATE_TIMER]) {
    const file = join(unitDir, name);
    if (existsSync(file)) rmSync(file);
  }
}
