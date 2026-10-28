import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, openSync, closeSync, statSync, watch, readdirSync, lstatSync, constants } from 'node:fs';
import { cp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { HOME, HELM_DIR } from './paths.js';
import { systemdArg } from './service.js';
import { webBuild } from './web-build.js';

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
      git(['log', '-1', '--format=%h%x00%s%x00%ct%x00%H']),
    ]);
    const lines = status.split('\n');
    const branch = lines.find((l) => l.startsWith('# branch.head '))?.slice(14).trim() ?? '';
    const dirty = lines.some((l) => l && !l.startsWith('#'));
    const [commit, subject, time, full] = head.trim().split('\0');
    // A detached checkout reads "(detached)"; callers have always seen "HEAD".
    // `updatable` now means "can take a saved version": any clean checkout.
    return { commit, full, time: Number(time) || 0, dirty, dir, subject,
      branch: branch === '(detached)' ? 'HEAD' : branch, updatable: !dirty };
  } catch {
    return null;
  }
}

const unitActive = (unit) =>
  exec('systemctl', ['--user', 'is-active', '--quiet', unit]).then(() => true).catch(() => false);

/** Queue replacement now. Agent and terminal hosts outlive the daemon. */
export async function restartServices(units) {
  if (!units.length || units.some((unit) => !DAEMON_UNITS.includes(unit))) throw new Error('invalid Helm restart service');
  // systemd owns the job: it continues even when this caller is the daemon
  // being replaced. No worker needs to wait for chats or open connections.
  await exec('systemctl', ['--user', '--no-block', 'restart', ...units]);
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
  return locked(() => updateLocked(dir, opts));
}

/**
 * One update at a time per machine: a sync from another machine, a local
 * rebuild and a phone's GitHub button can all fire together, and two
 * `git reset`s and `npm install`s racing in one checkout is how a deploy
 * gets corrupted.
 */
export async function locked(work) {
  const lock = join(HELM_DIR, 'update.lock');
  try {
    mkdirSync(HELM_DIR, { recursive: true });
    if (existsSync(lock) && abandonedLock(lock)) rmSync(lock, { force: true });
    const fd = openSync(lock, 'wx');
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, start: processStart(process.pid) })); }
    finally { closeSync(fd); }
  } catch {
    return { updated: false, reason: 'an update is already running' };
  }
  try { return await work(); } finally { rmSync(lock, { force: true }); }
}

function processStart(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  } catch { return null; }
}

function abandonedLock(file) {
  try {
    const owner = JSON.parse(readFileSync(file, 'utf8'));
    if (Number.isInteger(owner.pid) && owner.pid > 0) {
      // EPERM: after a reboot another user's process (containerd, say) took
      // the number. The lock is always this user's, so its owner is gone.
      try { process.kill(owner.pid, 0); }
      catch (error) { return error.code === 'ESRCH' || error.code === 'EPERM'; }
      const start = processStart(owner.pid);
      // A restarted daemon must not wait 30 minutes on its dead predecessor,
      // and a recycled PID must not count as that predecessor still running.
      return !!owner.start && !!start && owner.start !== start;
    }
  } catch { /* older versions wrote an empty lock, so retain their timeout */ }
  return Date.now() - statSync(file).mtimeMs > LOCK_STALE_MS;
}

const gitIn = (dir) => (args, opts) => exec('git', ['-C', dir, ...args], opts).then((r) => r.stdout.trim());

/**
 * This machine's saved version, packed for another machine to take: only
 * the commits it does not have yet when it says which it has.
 */
export async function makeBundle({ have = [] } = {}, dir = ROOT) {
  const git = gitIn(dir);
  const known = [];
  for (const commit of have) {
    if (/^[0-9a-f]{7,40}$/.test(commit) && await git(['cat-file', '-e', `${commit}^{commit}`]).then(() => true, () => false)) known.push(`^${commit}`);
  }
  const tmp = join(HELM_DIR, `bundle-${process.pid}-${randomUUID()}.git`);
  try {
    // Nothing new to send is not an error: say so instead of an empty bundle.
    const head = await git(['rev-parse', 'HEAD']);
    if (known.includes(`^${head}`)) return { head, bundle: null };
    await git(['bundle', 'create', tmp, 'HEAD', ...known]);
    return { head, bundle: readFileSync(tmp).toString('base64') };
  } finally { rmSync(tmp, { force: true }); }
}

/**
 * Take another machine's newer saved version. Only ever moves forward from
 * what is here: if both machines have their own changes, neither is
 * overwritten - the owner (or their agent) combines them.
 */
export async function syncFromBundle(bundle, dir = ROOT, { rebuild = true, restart = true } = {}) {
  return locked(async () => {
    const git = gitIn(dir);
    if (!existsSync(join(dir, '.git'))) return { updated: false, reason: `${dir} is not a git checkout` };
    const resumed = await recoverUpdate(dir, git);
    if (await git(['status', '--porcelain'])) return { updated: false, reason: 'unsaved changes here' };
    const tmp = join(HELM_DIR, `incoming-${process.pid}-${Date.now()}.git`);
    let tip;
    try {
      writeFileSync(tmp, Buffer.from(bundle, 'base64'));
      await git(['fetch', '--quiet', tmp, 'HEAD']);
      tip = await git(['rev-parse', 'FETCH_HEAD']);
    } finally { rmSync(tmp, { force: true }); }
    const head = await git(['rev-parse', 'HEAD']);
    if (head === tip) {
      if (resumed?.phase === 'prepared') return applyCommit(dir, git, { head, tip, rebuild, restart, rollback: resumed.rollback });
      if (resumed?.phase === 'built') return finishUpdate(resumed, restart);
      return { updated: false, reason: `already at ${tip.slice(0, 7)}` };
    }
    if (!(await git(['merge-base', '--is-ancestor', head, tip]).then(() => true, () => false))) {
      return { updated: false, reason: 'both machines have their own changes', diverged: true };
    }
    return applyCommit(dir, git, { head, tip, rebuild, restart });
  });
}

/**
 * The owner's agent saved a change to Helm on this machine: build it and
 * restart into it. Unsaved edits are left alone until they are saved.
 */
export async function rebuildIfCommitted(running, dir = ROOT, { rebuild = true, restart = true } = {}) {
  return locked(async () => {
    const git = gitIn(dir);
    const resumed = await recoverUpdate(dir, git);
    if (await git(['status', '--porcelain'])) return { updated: false, reason: 'unsaved changes here' };
    const head = await git(['rev-parse', 'HEAD']);
    if (resumed?.phase === 'built') return finishUpdate(resumed, restart);
    if ((!running || head === running) && resumed?.phase !== 'prepared') return { updated: false, reason: 'nothing new' };
    return applyCommit(dir, git, { head: running || head, tip: head, rebuild, restart, rollback: false });
  });
}

/**
 * The app this machine serves was built from another commit than the one it
 * runs: an update moved the checkout again while it was building, or after
 * it asked for its restart. The relay serves files from disk, so a build is
 * all it needs - no restart.
 */
export async function rebuildStaleApp(running, dir = ROOT, { build = () => gentle('npm', ['--workspace', '@helm/web', 'run', 'build', '--silent'], { cwd: dir }) } = {}) {
  return locked(async () => {
    const git = gitIn(dir);
    await recoverUpdate(dir, git);
    if (await git(['status', '--porcelain'])) return { rebuilt: false };
    const head = await git(['rev-parse', 'HEAD']);
    const stamp = webBuild(join(dir, 'apps', 'web', 'dist'));
    // No stamp: a build from before stamps existed, or a development tree.
    if (!running || head !== running || !stamp || stamp.commit === head) return { rebuilt: false };
    say(`the app was built from ${stamp.commit.slice(0, 7)}; building it from ${head.slice(0, 7)}`);
    const state = { dir, previousHead: head, targetHead: head, phase: 'prepared', restart: false, rollback: false };
    state.artifacts = await saveArtifacts(dir, ['apps/web/dist']);
    try {
      writeUpdateState(state);
      await build();
    } catch (error) {
      await restoreArtifacts(state);
      await clearUpdateState(state);
      throw error;
    }
    await clearUpdateState(state);
    return { rebuilt: true };
  });
}

/**
 * Calls `onMove` soon after this checkout's commit changes - a new version
 * checked out or committed here - instead of on the next two-minute check.
 * Other machines only copy a version once this one runs it, so that wait
 * used to hold up every machine. Git rewrites HEAD and index for a checkout
 * or a commit; reading the commit back filters out index refreshes that
 * change nothing (git status writes the index too).
 */
export function watchCheckout(onMove, dir = ROOT) {
  let timer = null, last = null, watcher = null, stopped = false;
  const head = () => exec('git', ['-C', dir, 'rev-parse', 'HEAD']).then((r) => r.stdout.trim(), () => null);
  const check = async () => {
    const now = await head();
    if (stopped || !now) return;
    if (last && now !== last) onMove(now);
    last = now;
  };
  exec('git', ['-C', dir, 'rev-parse', '--absolute-git-dir']).then(({ stdout }) => {
    if (stopped) return;
    void check();
    watcher = watch(stdout.trim(), (_event, name) => {
      if (name && !['HEAD', 'index', 'ORIG_HEAD'].includes(String(name))) return;
      clearTimeout(timer);
      timer = setTimeout(check, 1500);
      timer.unref?.();
    });
    watcher.on('error', () => {});
    watcher.unref?.();
  }).catch(() => {});
  return () => { stopped = true; clearTimeout(timer); watcher?.close(); };
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

async function clearUpdateState(state = readUpdateState()) {
  rmSync(UPDATE_STATE_FILE, { force: true });
  if (state?.artifacts) await rm(artifactBackup(state.artifacts), { recursive: true, force: true });
}

// Copy installed files before npm or a build can replace them. Leave the
// originals available while saving the copies. Copy links as links; relative
// targets must stay unchanged when restored to the checkout.
const copyArtifact = (from, to) => cp(from, to, {
  recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE,
});
const present = (path) => { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
function artifactBackup(artifacts) {
  if (!/^update-backup-[0-9a-f-]+$/.test(artifacts.id)) throw new Error('Cannot read the saved update files.');
  return join(HELM_DIR, artifacts.id);
}
async function saveArtifacts(dir, paths) {
  const artifacts = { id: `update-backup-${randomUUID()}`, paths: [] };
  const backup = artifactBackup(artifacts);
  mkdirSync(backup, { mode: 0o700 });
  try {
    for (const path of paths) {
      const existed = present(join(dir, path));
      const index = artifacts.paths.length;
      artifacts.paths.push({ path, existed });
      if (existed) await copyArtifact(join(dir, path), join(backup, String(index)));
    }
    return artifacts;
  } catch (error) {
    await rm(backup, { recursive: true, force: true });
    throw error;
  }
}
async function restoreArtifacts(state) {
  if (!state.artifacts) return; // Journals from older Helm versions have no copy.
  const backup = artifactBackup(state.artifacts);
  for (const [index, { path, existed }] of state.artifacts.paths.entries()) {
    if (path !== 'apps/web/dist' && path !== 'node_modules' && !/^(apps|packages)\/[^/.][^/]*\/node_modules$/.test(path)) {
      throw new Error('Cannot read the saved update files.');
    }
    const saved = join(backup, String(index));
    // Check before removing anything. Retain the journal if restoration fails,
    // so another invocation can retry rather than accepting a broken release.
    if (existed && !present(saved)) throw new Error('Cannot find the saved update files.');
    const installed = join(state.dir, path);
    await rm(installed, { recursive: true, force: true });
    if (existed) await copyArtifact(saved, installed);
  }
}
async function dependencyPaths(dir, git, tip) {
  const paths = new Set(['node_modules']);
  for (const parent of ['apps', 'packages']) {
    if (!existsSync(join(dir, parent))) continue;
    for (const entry of readdirSync(join(dir, parent), { withFileTypes: true })) {
      // restoreArtifacts rejects hidden folders, so never save one.
      if (entry.isDirectory() && !entry.name.startsWith('.')) paths.add(`${parent}/${entry.name}/node_modules`);
    }
  }
  // npm can also create nested dependencies in a newly added workspace.
  for (const file of (await git(['ls-tree', '-r', '--name-only', tip, '--', 'apps', 'packages'])).split('\n')) {
    if (/^(apps|packages)\/[^/]+\/package.json$/.test(file)) paths.add(file.replace(/package.json$/, 'node_modules'));
  }
  return [...paths];
}

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
  // macOS: the LaunchAgent restarts it. Asked from a separate process group
  // so replacement continues when the calling daemon exits.
  if (platform() === 'darwin') {
    const label = `gui/${process.getuid?.()}/dev.helm.serve`;
    if (!(await exec('launchctl', ['print', label]).then(() => true, () => false))) return { restarting, failed };
    const { spawn } = await import('node:child_process');
    spawn('/bin/sh', ['-c', `exec launchctl kickstart -k ${label}`], { detached: true, stdio: 'ignore' }).unref();
    return { restarting: ['dev.helm.serve'], failed };
  }
  for (const unit of DAEMON_UNITS) if (await unitActive(unit)) restarting.push(unit);
  if (restarting.length) {
    try {
      // Retire waiters created by older versions. They must neither block
      // this update nor restart it a second time after an old chat finishes.
      for (const unit of ['helm-self-restart.timer', 'helm-self-restart.service']) {
        if (await unitActive(unit)) await exec('systemctl', ['--user', 'stop', unit]);
      }
      await restartServices(restarting);
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
  if (state.phase === 'prepared') await restoreArtifacts(state);
  const head = await git(['rev-parse', 'HEAD']).catch(() => '');
  const dirty = await git(['status', '--porcelain']).catch(() => null);
  if (state.phase === 'prepared') {
    if (head === state.targetHead && dirty === '' && state.rollback !== false) {
      await git(['reset', '--hard', '--quiet', state.previousHead]);
    }
    await clearUpdateState(state);
    // A rolled-back update has nothing left to do. An owner commit keeps its
    // source, so its restored old build must be built again.
    return head === state.targetHead && dirty === '' && state.rollback === false ? state : null;
  }
  if (state.phase === 'built' && head === state.targetHead && dirty === '') return state;
  // A different commit means the owner moved the checkout; leave it alone.
  if (state.phase === 'built' && dirty !== '') return state;
  await clearUpdateState();
  return null;
}

async function updateLocked(dir, { rebuild = true, restart = true, replace = false } = {}) {
  const git = (args) => exec('git', ['-C', dir, ...args]).then((r) => r.stdout.trim());
  if (!existsSync(join(dir, '.git'))) return { updated: false, reason: `${dir} is not a git checkout` };
  if (!(await git(['remote', 'get-url', 'origin']).catch(() => ''))) {
    return { updated: false, reason: 'no origin remote' };
  }
  const resumed = await recoverUpdate(dir, git);
  // Replacing local changes with GitHub's version is only ever asked for in
  // so many words, and even then nothing is thrown away: the changes are
  // kept on a backup branch (and in a stash, if any were unsaved).
  let backup = null;
  if (replace) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    if (await git(['status', '--porcelain'])) await git(['stash', 'push', '--include-untracked', '-m', `helm backup ${stamp}`]);
    backup = `helm-backup-${stamp}`;
    await git(['branch', backup, 'HEAD']);
  } else {
    const on = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (on !== BRANCH && on !== 'HEAD') return { updated: false, reason: `checkout is on ${on}, not ${BRANCH}` };
  }
  // Recovery can have restored a previous commit, so re-check the clean
  // branch before fetching and deciding what remains to do.
  if (await git(['status', '--porcelain'])) return { updated: false, reason: 'uncommitted changes' };

  await exec('git', ['-C', dir, 'fetch', '--quiet', 'origin', BRANCH], { timeout: 30_000 });
  const [head, tip] = await Promise.all([git(['rev-parse', 'HEAD']), git(['rev-parse', `origin/${BRANCH}`])]);
  if (head === tip) {
    if (!resumed || resumed.targetHead !== head) {
      return { updated: false, reason: `already at ${tip.slice(0, 7)}` };
    }
    if (resumed.phase === 'prepared') return applyCommit(dir, git, { head, tip, rebuild, restart, rollback: resumed.rollback });
    return finishUpdate(resumed, restart);
  }
  // Commits made here and not pushed would be thrown away by the reset below.
  // The VM's checkout is one you commit from, and an update asked for from a
  // phone must never be the thing that eats them.
  const ahead = Number(await git(['rev-list', '--count', `origin/${BRANCH}..HEAD`]).catch(() => '0'));
  if (ahead > 0 && !replace) return { updated: false, reason: `${ahead} commit${ahead === 1 ? '' : 's'} of your own changes here - choose replace to use GitHub's version` };
  const result = await applyCommit(dir, git, { head, tip, rebuild, restart });
  return backup ? { ...result, backup } : result;
}

/**
 * Move the checkout to `tip`, install, build and restart - journaled, so a
 * crash part-way has a way back, and rolled back if the build fails.
 */
async function applyCommit(dir, git, { head, tip, rebuild = true, restart = true, rollback = true }) {
  say(`updating ${head.slice(0, 7)} -> ${tip.slice(0, 7)}`);
  const state = { dir, previousHead: head, targetHead: tip, phase: 'prepared', restart, rollback };
  const depsChanged = head === tip || !!(await git(['diff', '--name-only', head, tip, '--', 'package-lock.json']).catch(() => 'yes'));
  const install = rebuild && (depsChanged || !existsSync(join(dir, 'node_modules')));
  if (rebuild) state.artifacts = await saveArtifacts(dir, [
    'apps/web/dist', ...(install ? await dependencyPaths(dir, git, tip) : []),
  ]);
  let started = false;
  try {
    // Copying can take time. Recheck source edits before moving the checkout.
    const expected = rollback ? head : tip;
    if (await git(['rev-parse', 'HEAD']) !== expected || await git(['status', '--porcelain'])) {
      throw new Error('The files changed during the update. Keep your changes and try again.');
    }
    writeUpdateState(state);
    started = true;
    await git(['reset', '--hard', '--quiet', tip]);
    if (install) {
      say('installing dependencies');
      // Install the committed dependency tree without rewriting its lockfile.
      // An install-induced dirty tree would disable rollback and every retry.
      await gentle('npm', ['ci', '--include=dev', '--silent', '--no-fund', '--no-audit'], { cwd: dir });
      await ensurePty(dir);
    }
    if (rebuild) {
      if (existsSync(join(dir, 'scripts', 'build-log-reader.mjs'))) {
        await gentle(process.execPath, ['scripts/build-log-reader.mjs'], { cwd: dir });
      }
      say('building the app');
      await gentle('npm', ['--workspace', '@helm/web', 'run', 'build', '--silent'], { cwd: dir });
    }
    // Mark the source and build complete before touching systemd. If this
    // process dies while scheduling a restart, the next run can finish that
    // part without reinstalling or moving the checkout again.
    state.phase = 'built';
    writeUpdateState(state);
  } catch (error) {
    // Restore generated files even if the owner changed source during the
    // build. Only move the source back while it is still clean and unchanged.
    // A failed build must make the next attempt eligible again. The clean
    // deployment checkout is still at the journaled target, so restore HEAD;
    // unpushed/dirty trees were rejected before this transaction began and
    // are never reset here.
    if (started) await restoreArtifacts(state);
    const now = await git(['rev-parse', 'HEAD']).catch(() => '');
    const dirty = await git(['status', '--porcelain']).catch(() => null);
    // A version the owner saved here is theirs: a failed build leaves it in
    // place for them (or their agent) to fix, rather than moving it away.
    if (started && now === tip && dirty === '' && rollback) await git(['reset', '--hard', '--quiet', head]);
    await clearUpdateState(state);
    throw error;
  }

  return finishUpdate(state, restart);
}

async function finishUpdate(state, restart) {
  if (!restart || state.restart === false) {
    await clearUpdateState(state);
    return { updated: true, restarting: [] };
  }
  const result = await requestRestart();
  if (!result.failed.length) await clearUpdateState(state);
  return { updated: true, ...result };
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
