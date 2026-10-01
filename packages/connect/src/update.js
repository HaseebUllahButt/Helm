import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { HOME, HELM_DIR } from './paths.js';
import { TerminalHost, PROC_SOCKET_PATH } from './terminals.js';
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

/**
 * Which helm this is, for the machine list: the commit it runs and whether an
 * update from the app could touch it. `updatable` is the same guard
 * `selfUpdate` applies - a clean checkout on the update branch - so the button
 * is never offered for a development tree or a pinned release worktree.
 */
export async function currentVersion(dir = ROOT) {
  const git = (args) => exec('git', ['-C', dir, ...args]).then((r) => r.stdout.trim());
  try {
    const [commit, branch, subject, dirty] = await Promise.all([
      git(['rev-parse', '--short', 'HEAD']),
      git(['rev-parse', '--abbrev-ref', 'HEAD']),
      git(['log', '-1', '--format=%s']),
      git(['status', '--porcelain']),
    ]);
    return { commit, branch, subject, updatable: branch === BRANCH && !dirty };
  } catch {
    return null;
  }
}

const unitActive = (unit) =>
  exec('systemctl', ['--user', 'is-active', '--quiet', unit]).then(() => true).catch(() => false);

/** Hosted processes can survive replacement; other busy agents must finish first. */
export function unsafeRestartSessions(sessions, hasProc) {
  return sessions.filter((s) => s.driver && !s.external
    && ['working', 'blocked'].includes(s.status) && !hasProc(s.id));
}

async function restartBlockers(host) {
  await host.ensure({ spawn: false });
  const file = join(HELM_DIR, 'sessions.json');
  if (!existsSync(file)) return [];
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(stored.sessions)) throw new Error('cannot verify active sessions before update restart');
  return unsafeRestartSessions(stored.sessions, (id) => host.hasProc(id));
}

/** Runs outside the daemon, so waiting never interrupts the thread requesting an update. */
export async function restartWhenSafe(units) {
  if (!units.length || units.some((unit) => !DAEMON_UNITS.includes(unit))) throw new Error('invalid Helm restart service');
  const host = new TerminalHost({ socketPath: PROC_SOCKET_PATH, unit: 'helm-procs' });
  try {
    let waiting = false;
    while ((await restartBlockers(host)).length) {
      if (!waiting) say('waiting for active agents that cannot survive a restart');
      waiting = true;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    // A second socket client must not consume output during the handover:
    // with no clients the host keeps the backlog for the replacement daemon.
    host.detach();
    await exec('systemctl', ['--user', 'restart', ...units]);
  } finally { host.detach(); }
}

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
  // Commits made here and not pushed would be thrown away by the reset below.
  // The VM's checkout is one you commit from, and an update asked for from a
  // phone must never be the thing that eats them.
  const ahead = Number(await git(['rev-list', '--count', `origin/${BRANCH}..HEAD`]).catch(() => '0'));
  if (ahead > 0) return { updated: false, reason: `${ahead} commit${ahead === 1 ? '' : 's'} not pushed yet` };

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
  for (const unit of DAEMON_UNITS) if (await unitActive(unit)) restarting.push(unit);
  if (restarting.length) {
    try {
      // One worker handles both services and drains any unhosted active turn.
      // Hosted conversations continue in the process host while we reconnect.
      if (!(await unitActive('helm-self-restart.service')) && !(await unitActive('helm-self-restart.timer'))) {
        await exec('systemd-run', ['--user', '--collect', '--on-active=5', '--unit=helm-self-restart', `--setenv=HELM_DIR=${HELM_DIR}`,
          process.execPath, binPath, 'restart-services', ...restarting]);
      }
    } catch {
      failed.push(...restarting);
      restarting.length = 0;
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
