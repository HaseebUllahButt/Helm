import { execFileSync, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { M } from '@helm/protocol';
import { locked } from './update.js';

/**
 * `helm ship`: the rollout every Helm change ends with, as one command. It
 * merges this chat's branch into main, pushes main, moves this machine's
 * installed checkout, and then waits until every online machine runs the
 * new commit and serves an app built from it - the four places AGENTS.md
 * says to check separately. Agents did each step by hand and often stopped
 * before the last machine had restarted.
 *
 * Machines copy a version from a machine that runs it (version-sync.js), so
 * nothing here touches another machine. Installed checkouts can hold other
 * chats' unsaved edits: they are reported, never reset or stashed.
 */

const STEP_MS = 3000;
const INFO_MS = 8000;
// A sync note that stays this long is not a passing restart.
const STUCK_MS = 2 * 60_000;
// A machine that is restarting when ship starts answers again within this.
const OFFLINE_MS = 45_000;

export class ShipError extends Error {}

function git(dir, args, { raw = false, env } = {}) {
  try {
    const out = execFileSync('git', ['-C', dir, '-c', 'core.quotePath=false', ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    return raw ? out : out.trim();
  } catch (err) {
    // A merge names its clashes on stdout and other notes on stderr.
    const why = [err.stdout, err.stderr].filter(Boolean).join('\n').trim() || err.message;
    throw Object.assign(new Error(why.split('\n').slice(0, 8).join('\n')), { git: true });
  }
}

const tryGit = (dir, args) => { try { return git(dir, args); } catch { return null; } };
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const short = (sha) => String(sha ?? '').slice(0, 7);

/** Tracked edits only: untracked scratch files do not change what ships. */
function trackedEdits(dir) {
  return git(dir, ['status', '--porcelain'], { raw: true }).split('\n').filter((l) => l && !l.startsWith('??'));
}

/** The checkout that owns main: the first entry of `git worktree list`. */
export function mainWorktree(dir) {
  const first = git(dir, ['worktree', 'list', '--porcelain']).split('\n').find((l) => l.startsWith('worktree '));
  return first ? first.slice('worktree '.length) : dir;
}

/** Whether commit `have` includes commit `want`, asked of any repo that may know both. */
export function includes(dirs, want, have) {
  if (!want || !have) return false;
  if (want === have) return true;
  return dirs.some((dir) => tryGit(dir, ['merge-base', '--is-ancestor', want, have]) !== null);
}

/**
 * Where one machine is. `ok` once it runs `tip` (or newer) and serves an app
 * built from it; `waiting` while it restarts or copies the version.
 */
export function machineState(info, tip, contains) {
  if (!info) return { state: 'waiting', text: 'restarting' };
  const runs = info.version?.full;
  if (!runs) return { state: 'waiting', text: 'cannot read its version' };
  const runsTip = contains(tip, runs);
  const web = info.web;
  const webTip = Boolean(web?.commit) && contains(tip, web.commit);
  if (runsTip && webTip) {
    return { state: 'ok', text: `runs ${short(runs)}, app built from ${short(web.commit)}${web.dirty ? ' with unsaved edits' : ''}` };
  }
  if (!runsTip) {
    const why = info.sync?.diverged
      ? `it and ${info.sync.with} both have their own changes`
      : info.sync?.reason;
    return { state: 'waiting', text: `runs ${short(runs)}${why ? `: ${why}` : ''}`, note: why ?? null };
  }
  return { state: 'waiting', text: web?.commit ? `runs ${short(runs)}, but the app is built from ${short(web.commit)}` : `runs ${short(runs)}, but the app build has no version stamp` };
}

function runCheck(dir) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', '-s', 'check'], { cwd: dir, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`npm run check exited with ${code}`))));
  });
}

/**
 * @param {object} o
 * @param {object} o.net     this machine's network (loadNetwork())
 * @param {Function} o.rpc   hubRpc(net, machineId, method, params, opts)
 */
export async function ship({
  cwd = process.cwd(), net, rpc, check = true, waitMs = 10 * 60_000, log = console.log,
  now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), checks = runCheck,
  updateLock = locked,
} = {}) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  const branch = git(top, ['branch', '--show-current']);
  const mainDir = mainWorktree(top);
  if (git(mainDir, ['branch', '--show-current']) !== 'main') {
    throw new ShipError(`${mainDir} is not on main. Helm ships from the checkout that holds main.`);
  }
  const edits = trackedEdits(top);
  if (edits.length) throw new ShipError(`Commit these files first:\n${edits.map((l) => `    ${l.slice(3)}`).join('\n')}`);
  if (!branch && !includes([top], git(top, ['rev-parse', 'HEAD']), git(top, ['rev-parse', 'main']))) {
    throw new ShipError('This copy is not on a branch. Run git switch -c <branch>, then helm ship again.');
  }
  let pushed = true;

  if (branch && branch !== 'main') {
    const ahead = Number(git(top, ['rev-list', '--count', `main..${branch}`]));
    if (!ahead) {
      log(`  Main already has ${branch}.`);
    } else {
      if (check) {
        log('  Running npm run check…');
        try { await checks(top); } catch {
          throw new ShipError('The checks failed. Fix them, commit, and run helm ship again.');
        }
        log('  Checks passed.');
      }
      // Another chat may be half way through a merge in main; aborting would lose its fixes.
      if (tryGit(mainDir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']) !== null) {
        throw new ShipError(`Another merge is not finished in ${mainDir}. Wait for it, then run helm ship again.`);
      }
      try {
        // Always a new merge commit, timed after both parents: machines take
        // a version only when its commit time is newer than theirs
        // (version-sync.js). A fast-forward keeps the branch commit's time,
        // and a merge in the same second as main's last commit ties it.
        const after = Math.max(...[`main`, branch].map((ref) => Number(git(mainDir, ['log', '-1', '--format=%ct', ref])))) + 1;
        const when = `${Math.max(Math.floor(now() / 1000), after)} +0000`;
        git(mainDir, ['merge', '--no-ff', '--no-edit', branch], { env: { GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when } });
      } catch (err) {
        if (tryGit(mainDir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']) !== null) tryGit(mainDir, ['merge', '--abort']);
        throw new ShipError(/CONFLICT/.test(err.message)
          ? `Main changed the same lines. Run git merge main here, fix the clashes, commit, and run helm ship again.\n${err.message}`
          : `Git did not merge ${branch} into main:\n${err.message}`);
      }
      log(`  Merged ${branch} into main.`);
    }
  }
  const tip = git(mainDir, ['rev-parse', 'main']);

  if (tryGit(mainDir, ['remote', 'get-url', 'origin']) === null) {
    pushed = false;
    log('  ! Main has no origin, so nothing was pushed.');
  } else {
    try {
      git(mainDir, ['push', '-q', 'origin', 'main']);
      log(`  Pushed main (${short(tip)}) to origin.`);
    } catch (err) {
      pushed = false;
      log(`  ! Git did not push main:\n${err.message.replace(/^/gm, '    ')}`);
    }
  }

  // This machine first: the others copy a version only once a machine runs it.
  let here;
  try {
    here = await rpc(net, net.self, M.ENV_INFO, {}, { timeout: INFO_MS, budget: INFO_MS });
  } catch {
    throw new ShipError('Helm is not running on this machine, so no machine can take the new version.');
  }
  const installed = here.version?.dir;
  const dirs = [mainDir, ...(installed ? [installed] : [])];
  if (installed && real(installed) !== real(mainDir) && !includes([installed], tip, tryGit(installed, ['rev-parse', 'HEAD']))) {
    const theirs = trackedEdits(installed);
    if (theirs.length) {
      throw new ShipError(`${installed} has unsaved edits, so Helm cannot restart into the new version:\n` +
        `${theirs.map((l) => `    ${l.slice(3)}`).join('\n')}\n  They belong to another chat. Ask it to commit them, then run helm ship again.`);
    }
    // Under the update lock: moving the checkout while an update builds
    // would leave an app built from the old commit under the new one.
    let moved = null;
    const until = now() + waitMs;
    for (let told = false; !moved;) {
      moved = await updateLock(async () => {
        try {
          git(installed, ['pull', '-q', '--ff-only', mainDir, 'main']);
          return { done: true };
        } catch (err) {
          return { error: err };
        }
      });
      if (moved?.reason) {
        if (!told) { log('  Waiting for the update that runs on this machine…'); told = true; }
        moved = null;
        if (now() >= until) throw new ShipError(`An update still runs on this machine after ${Math.round(waitMs / 60_000)} min. Main has the change; run helm ship again later.`);
        await sleep(STEP_MS);
      }
    }
    if (moved.error) throw new ShipError(`Git did not move ${installed} to main:\n${moved.error.message}`);
    log(`  Moved ${installed} to ${short(tip)}.`);
  }

  const contains = (want, have) => includes(dirs, want, have);
  const ask = (id) => rpc(net, id, M.ENV_INFO, {}, { timeout: INFO_MS, budget: INFO_MS }).catch(() => null);
  const ids = Object.keys(net.machines ?? {});
  const name = (id, info) => info?.name ?? net.machines[id]?.name ?? short(id);
  const width = Math.max(...ids.map((id) => name(id).length), 4);
  const pending = new Map();
  // Machines that have not answered yet. One that answers later joins the
  // wait; one still silent after OFFLINE_MS is offline and skipped.
  const unseen = new Set(ids);
  const join = (id, info) => {
    if (!info || !unseen.delete(id)) return;
    pending.set(id, { name: name(id, info), info, shown: null, note: null, since: 0 });
  };
  log(`  Waiting for each machine to run ${short(tip)}…`);

  const started = now();
  const deadline = started + waitMs;
  const done = new Map();
  (await Promise.all(ids.map(ask))).forEach((info, i) => join(ids[i], info));
  for (;;) {
    for (const [id, m] of pending) {
      const s = machineState(m.info, tip, contains);
      if (s.note !== m.note) { m.note = s.note ?? null; m.since = now(); }
      const stuck = s.state === 'waiting' && m.note && now() - m.since > STUCK_MS;
      const line = `    ${m.name.padEnd(width)}  ${stuck ? 'stuck' : s.state}: ${s.text}`;
      if (line !== m.shown) { log(line); m.shown = line; }
      if (s.state === 'ok' || stuck) { done.set(id, { ...s, stuck }); pending.delete(id); }
    }
    const waitingOffline = unseen.size > 0 && now() - started < OFFLINE_MS;
    if ((!pending.size && !waitingOffline) || now() >= deadline) break;
    await sleep(STEP_MS);
    await Promise.all([
      ...[...pending].map(async ([id, m]) => { m.info = await ask(id); }),
      // Asked to the end: a machine back after OFFLINE_MS is still checked.
      ...[...unseen].map(async (id) => join(id, await ask(id))),
    ]);
  }

  const offline = [...unseen].map((id) => name(id));
  if (offline.length) log(`  Skipped offline machines: ${offline.join(', ')}.`);
  const late = [...pending.values()].map((m) => m.name);
  const stuck = [...done].filter(([, s]) => s.stuck).map(([id]) => name(id));
  if (late.length) log(`  ! Still waiting after ${Math.round(waitMs / 60_000)} min: ${late.join(', ')}.`);
  if (stuck.length) log(`  ! Stuck: ${stuck.join(', ')}. Read the reason above.`);
  const everywhere = !late.length && !stuck.length;
  log(!everywhere ? `  ${short(tip)} did not reach every online machine.`
    : pushed ? `  Shipped ${short(tip)}. Every online machine runs it.`
      : `  Every online machine runs ${short(tip)}, but origin does not have it.`);
  return { tip, ok: everywhere && pushed, offline };
}
