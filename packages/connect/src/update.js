import { execFile } from 'node:child_process';
import { hasActiveTransfers } from '@helm/protocol/transfer-activity';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, openSync, closeSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { HOME, HELM_DIR } from './paths.js';
import { TerminalHost, PROC_SOCKET_PATH } from './terminals.js';
import { systemdArg } from './service.js';
import { getProfiles, materialize } from './profiles.js';
import { hostedProcId } from './hosted-process.js';

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
  const git = (args) => exec('git', ['-C', dir, ...args]).then((r) => r.stdout);
  try {
    // Two processes, not four: every link asks this at startup, and a
    // machine with five hubs to dial used to run twenty git commands at once.
    const [status, head] = await Promise.all([
      git(['status', '--porcelain=v2', '--branch']),
      git(['log', '-1', '--format=%h%x00%s']),
    ]);
    const lines = status.split('\n');
    const branch = lines.find((l) => l.startsWith('# branch.head '))?.slice(14).trim() ?? '';
    const dirty = lines.some((l) => l && !l.startsWith('#'));
    const [commit, subject] = head.trim().split('\0');
    // A detached checkout reads "(detached)"; callers have always seen "HEAD".
    return { commit, branch: branch === '(detached)' ? 'HEAD' : branch, subject, updatable: branch === BRANCH && !dirty };
  } catch {
    return null;
  }
}

const unitActive = (unit) =>
  exec('systemctl', ['--user', 'is-active', '--quiet', unit]).then(() => true).catch(() => false);

/** Hosted processes can survive replacement; other busy agents must finish first. */
export function unsafeRestartSessions(sessions, hasProc, profiles = []) {
  return sessions.filter((s) => {
    if (!s.driver || s.external || !['working', 'blocked'].includes(s.status)) return false;
    // Codex's outstanding approval RPCs are daemon-local. Keep the old
    // daemon until those are answered rather than lose an answerable prompt.
    if (s.driver === 'codex' && s.status === 'blocked') return true;
    const profile = s.driver === 'codex' && profiles.find((p) => p.id === s.profileId);
    const id = hostedProcId(s, profile ? materialize(profile) : null);
    return !id || !hasProc(id);
  });
}

async function restartBlockers(host) {
  await host.ensure({ spawn: false });
  const file = join(HELM_DIR, 'sessions.json');
  if (!existsSync(file)) return [];
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(stored.sessions)) throw new Error('cannot verify active sessions before update restart');
  return unsafeRestartSessions(stored.sessions, (id) => !!id && host.hasProc(id), await getProfiles());
}

/** Runs outside the daemon, so waiting never interrupts the thread requesting an update. */
export async function restartWhenSafe(units) {
  if (!units.length || units.some((unit) => !DAEMON_UNITS.includes(unit))) throw new Error('invalid Helm restart service');
  const host = new TerminalHost({ socketPath: PROC_SOCKET_PATH, unit: 'helm-procs' });
  try {
    let waiting = false;
    while ((await restartBlockers(host)).length || hasActiveTransfers()) {
      if (!waiting) say('waiting for active transfers or agents that cannot survive a restart');
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
export async function selfUpdate(dir = ROOT, opts = {}) {
  // One update at a time per machine: the timer, the daemon's own check and
  // a phone's Update button can all fire together, and two `git reset`s and
  // `npm install`s racing in one checkout is how a deploy gets corrupted.
  const lock = join(HELM_DIR, 'update.lock');
  try {
    mkdirSync(HELM_DIR, { recursive: true });
    if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
    closeSync(openSync(lock, 'wx'));
  } catch {
    return { updated: false, reason: 'an update is already running' };
  }
  try { return await updateLocked(dir, opts); } finally { rmSync(lock, { force: true }); }
}

/** An update that died mid-way must not block the next one forever. */
const LOCK_STALE_MS = 30 * 60_000;
const UPDATE_STATE_FILE = join(HELM_DIR, 'update-state.json');

/**
 * The checkout is deliberately moved only after this journal entry exists.
 * A SIGKILL between reset and the build therefore has a recovery path on the
 * next invocation instead of looking like a successfully installed release.
 */
function readUpdateState() {
  try {
    const state = JSON.parse(readFileSync(UPDATE_STATE_FILE, 'utf8'));
    return state?.version === 1 && typeof state.dir === 'string' && typeof state.phase === 'string'
      ? state : null;
  } catch { return null; }
}

function writeUpdateState(state) {
  mkdirSync(HELM_DIR, { recursive: true });
  const temp = `${UPDATE_STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ version: 1, ...state }), { mode: 0o600 });
  renameSync(temp, UPDATE_STATE_FILE);
}

function clearUpdateState() { rmSync(UPDATE_STATE_FILE, { force: true }); }

/** Long builds run at low priority, so a machine stays usable while it updates. */
const gentle = (cmd, args, opts) => platform() === 'win32'
  ? exec(cmd, args, opts)
  : exec('nice', ['-n', '10', cmd, ...args], opts);

/**
 * npm on newer releases skips packages' install scripts unless approved, and
 * node-pty's is what builds the terminal engine - so after an install the
 * terminals quietly fall back to the slow path. Check it loads; build it if not.
 */
async function ensurePty(dir) {
  const pkg = join(dir, 'node_modules/@homebridge/node-pty-prebuilt-multiarch');
  if (!existsSync(pkg)) return;
  const loads = () => exec(process.execPath, ['-e', "require('@homebridge/node-pty-prebuilt-multiarch')"], { cwd: dir, timeout: 30_000 })
    .then(() => true, () => false);
  if (await loads()) return;
  say('building the terminal engine');
  await gentle('npx', ['--yes', 'node-gyp', 'rebuild'], { cwd: pkg, timeout: 10 * 60_000 }).catch(() => {});
  if (!(await loads())) say('the terminal engine did not build - terminals use the slower fallback');
}

/** Finish the restart part of an update, including a retry after a crash. */
async function requestRestart() {
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
  return { restarting, failed };
}

/**
 * Reconcile a journal left by an interrupted update. A prepared transaction
 * is safe to roll back only while the checkout is still exactly the target
 * commit and clean; otherwise a person has changed the tree and the normal
 * dirty/unpushed guards must win without destroying their work.
 */
async function recoverUpdate(dir, git) {
  const state = readUpdateState();
  if (!state || state.dir !== dir) return null;
  const head = await git(['rev-parse', 'HEAD']).catch(() => '');
  const dirty = await git(['status', '--porcelain']).catch(() => null);
  if (state.phase === 'prepared') {
    if (head === state.targetHead && dirty === '') {
      await git(['reset', '--hard', '--quiet', state.previousHead]);
    }
    // The reset either restored the old commit, or the checkout was changed
    // by somebody else. In both cases do not replay an old transaction.
    if (head !== state.targetHead || dirty === '') clearUpdateState();
    return null;
  }
  if (state.phase === 'built' && head === state.targetHead && dirty === '') return state;
  // A different commit means the owner moved the checkout; leave it alone.
  if (state.phase === 'built' && dirty !== '') return state;
  clearUpdateState();
  return null;
}

async function updateLocked(dir, { rebuild = true, restart = true } = {}) {
  const git = (args) => exec('git', ['-C', dir, ...args]).then((r) => r.stdout.trim());
  if (!existsSync(join(dir, '.git'))) return { updated: false, reason: `${dir} is not a git checkout` };
  if (!(await git(['remote', 'get-url', 'origin']).catch(() => ''))) {
    return { updated: false, reason: 'no origin remote' };
  }
  const on = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (on !== BRANCH) return { updated: false, reason: `checkout is on ${on}, not ${BRANCH}` };
  const resumed = await recoverUpdate(dir, git);
  // Recovery can have restored a previous commit, so re-check the clean
  // branch before fetching and deciding what remains to do.
  if (await git(['status', '--porcelain'])) return { updated: false, reason: 'uncommitted changes' };

  await git(['fetch', '--quiet', 'origin', BRANCH]);
  const [head, tip] = await Promise.all([git(['rev-parse', 'HEAD']), git(['rev-parse', `origin/${BRANCH}`])]);
  if (head === tip) {
    if (!resumed || resumed.targetHead !== head) {
      return { updated: false, reason: `already at ${tip.slice(0, 7)}` };
    }
    if (!restart || resumed.restart === false) {
      clearUpdateState();
      return { updated: true, restarting: [] };
    }
    const result = await requestRestart();
    if (!result.failed.length) clearUpdateState();
    return { updated: true, ...result };
  }
  // Commits made here and not pushed would be thrown away by the reset below.
  // The VM's checkout is one you commit from, and an update asked for from a
  // phone must never be the thing that eats them.
  const ahead = Number(await git(['rev-list', '--count', `origin/${BRANCH}..HEAD`]).catch(() => '0'));
  if (ahead > 0) return { updated: false, reason: `${ahead} commit${ahead === 1 ? '' : 's'} not pushed yet` };

  say(`updating ${head.slice(0, 7)} -> ${tip.slice(0, 7)}`);
  writeUpdateState({ dir, previousHead: head, targetHead: tip, phase: 'prepared', restart });
  try {
    await git(['reset', '--hard', '--quiet', `origin/${BRANCH}`]);
    if (rebuild) {
      say('installing dependencies');
      // Install the committed dependency tree without rewriting its lockfile.
      // An install-induced dirty tree would disable rollback and every retry.
      await gentle('npm', ['ci', '--include=dev', '--silent', '--no-fund', '--no-audit'], { cwd: dir });
      await ensurePty(dir);
      say('building the app');
      await gentle('npm', ['--workspace', '@helm/web', 'run', 'build', '--silent'], { cwd: dir });
    }
    // Mark the source and build complete before touching systemd. If this
    // process dies while scheduling a restart, the next run can finish that
    // part without reinstalling or moving the checkout again.
    writeUpdateState({ dir, previousHead: head, targetHead: tip, phase: 'built', restart });
  } catch (error) {
    // A failed build must make the next attempt eligible again. The clean
    // deployment checkout is still at the journaled target, so restore HEAD;
    // unpushed/dirty trees were rejected before this transaction began and
    // are never reset here.
    const now = await git(['rev-parse', 'HEAD']).catch(() => '');
    const dirty = await git(['status', '--porcelain']).catch(() => null);
    if (now === tip && dirty === '') {
      await git(['reset', '--hard', '--quiet', head]).then(clearUpdateState);
    }
    throw error;
  }

  if (!restart) {
    clearUpdateState();
    return { updated: true, restarting: [] };
  }
  const result = await requestRestart();
  if (!result.failed.length) clearUpdateState();
  return { updated: true, ...result };
}

/**
 * The daemon's own check, for the moments the timer cannot see: just after
 * it starts (a machine that was off for days), and when it comes back online
 * after being away. Quiet, background, at most once per `minGapMs`; it never
 * delays startup and never touches a development or pinned checkout - the
 * same guards as `selfUpdate` apply. Only a daemon systemd started does
 * this, because only there can the update restart it afterwards.
 */
let autoRun = null;
let autoAt = 0;
export function autoUpdate({ minGapMs = 10 * 60_000, now = Date.now(), run = selfUpdate } = {}) {
  if (process.env.HELM_NO_UPDATE === '1' || process.env.HELM_NO_SERVICE === '1') return Promise.resolve(null);
  if (!process.env.INVOCATION_ID) return Promise.resolve(null);
  if (autoRun) return autoRun;
  if (now - autoAt < minGapMs) return Promise.resolve(null);
  autoAt = now;
  autoRun = (async () => {
    const v = await currentVersion();
    if (!v?.updatable) return { updated: false, reason: 'not an updatable checkout' };
    const r = await run();
    if (r.updated) console.log(`[helm] updated itself${r.restarting?.length ? ' - restarting' : ''}`);
    return r;
  })().catch((err) => ({ updated: false, reason: err?.message || String(err) }))
    .finally(() => { autoRun = null; });
  return autoRun;
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
