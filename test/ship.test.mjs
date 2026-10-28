import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { installFromCheckout } from '../packages/connect/src/update.js';
import { ship, machineState, ShipError } from '../packages/connect/src/ship.js';

const root = mkdtempSync(join(tmpdir(), 'helm-ship-'));
test.after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (dir, file, text, msg = file) => {
  writeFileSync(join(dir, file), text);
  git(dir, 'add', file);
  git(dir, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', msg);
};

/** origin, the main checkout, this chat's worktree on a branch, and the installed checkout. */
function repos() {
  const base = join(root, String(n++));
  const origin = join(base, 'origin.git');
  const main = join(base, 'main');
  const wt = join(base, 'wt');
  const installed = join(base, 'installed');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, main], { stdio: 'ignore' });
  git(main, 'checkout', '-q', '-b', 'main');
  git(main, 'config', 'user.name', 'test'); git(main, 'config', 'user.email', 'test@example.invalid');
  commit(main, 'a.txt', 'one\n');
  git(main, 'push', '-q', 'origin', 'main');
  git(main, 'worktree', 'add', '-q', '-b', 'helm/x', wt);
  commit(wt, 'a.txt', 'two\n', 'change a');
  execFileSync('git', ['clone', '-q', main, installed], { stdio: 'ignore' });
  return { origin, main, wt, installed };
}

/**
 * The network as `helm ship` sees it: this machine reports what its
 * installed checkout holds; `peer` copies it after `lag` more asks.
 */
function network({ installed }, { lag = 1, peerWeb = null, offline = true, peerSync = null, restarting = 0, peerLag = null } = {}) {
  const head = () => git(installed, 'rev-parse', 'HEAD');
  const start = head();
  let asks = 0;
  let laptopAsks = 0;
  const machines = { self: { name: 'why' }, peer: { name: 'VM' }, ...(offline ? { off: { name: 'HomePC' } } : {}),
    ...(restarting ? { laptop: { name: 'Laptop' } } : {}) };
  const rpc = async (_net, id, method) => {
    assert.equal(method, 'env.info');
    if (id === 'off') throw new Error('offline');
    if (id === 'laptop') {
      // Restarting when ship starts, then back on the old version, then the new one.
      const k = laptopAsks++;
      if (k < restarting) throw new Error('restarting');
      const v = k < restarting + 2 ? start : head();
      return { name: 'Laptop', version: { full: v }, web: { commit: v } };
    }
    if (id === 'self') return { name: 'why', version: { full: head(), dir: installed }, web: { commit: head() } };
    const v = !peerSync && asks++ >= (peerLag ?? lag) ? head() : start;
    return { name: 'VM', version: { full: v }, web: { commit: peerWeb ?? v }, sync: peerSync };
  };
  return { net: { self: 'self', machines }, rpc };
}

function run(r, over = {}) {
  const lines = [];
  let clock = 0;
  const { net, rpc } = network(r, over.network);
  return {
    lines,
    result: ship({
      cwd: r.wt, net, rpc, checks: async () => {}, log: (l) => lines.push(l), updateLock: (work) => work(),
      install: (dir, source) => installFromCheckout(dir, source, {rebuild:false, restart:false}),
      now: () => clock, sleep: async (ms) => { clock += ms; }, waitMs: 60_000, ...over.ship,
    }),
  };
}

test('ships a branch: main, origin, the installed checkout and every online machine', async () => {
  const r = repos();
  const { lines, result } = run(r);
  const out = await result;
  const tip = git(r.main, 'rev-parse', 'main');
  assert.equal(out.ok, true);
  assert.equal(out.tip, tip);
  assert.equal(readFileSync(join(r.main, 'a.txt'), 'utf8'), 'two\n');
  assert.equal(git(r.origin, 'rev-parse', 'main'), tip);
  assert.equal(git(r.installed, 'rev-parse', 'HEAD'), tip);
  assert.equal(git(r.main, 'rev-list', '--parents', '-n1', 'main').split(' ').length, 3, 'a merge commit, with a new time');
  assert.deepEqual(out.offline, ['HomePC']);
  const text = lines.join('\n');
  assert.match(text, /Skipped offline machines: HomePC/);
  assert.match(text, /VM\s+waiting: runs \w{7}/);
  assert.match(text, new RegExp(`VM\\s+ok: runs ${tip.slice(0, 7)}, app built from ${tip.slice(0, 7)}`));
  assert.match(text, /Shipped \w{7}\. Every online machine runs it\./);
});

test('runs the checks before the merge and stops when they fail', async () => {
  const r = repos();
  const before = git(r.main, 'rev-parse', 'main');
  const { result } = run(r, { ship: { checks: async () => { throw new Error('red'); } } });
  await assert.rejects(result, (e) => e instanceof ShipError && /checks failed/.test(e.message));
  assert.equal(git(r.main, 'rev-parse', 'main'), before);
});

test('refuses uncommitted work in the chat copy', async () => {
  const r = repos();
  writeFileSync(join(r.wt, 'a.txt'), 'half done\n');
  const { result } = run(r);
  await assert.rejects(result, (e) => e instanceof ShipError && /Commit these files first:\n\s+a\.txt/.test(e.message));
});

test('a clash with main leaves main as it was', async () => {
  const r = repos();
  commit(r.main, 'a.txt', 'other\n', 'other chat');
  const before = git(r.main, 'rev-parse', 'main');
  const { result } = run(r);
  await assert.rejects(result, (e) => e instanceof ShipError && /Main changed the same lines/.test(e.message));
  assert.equal(git(r.main, 'rev-parse', 'main'), before);
  assert.equal(git(r.main, 'status', '--porcelain'), '');
  assert.equal(existsSync(join(r.main, '.git', 'MERGE_HEAD')), false);
});

test("another chat's unsaved edits in the installed checkout are reported and kept", async () => {
  const r = repos();
  writeFileSync(join(r.installed, 'a.txt'), 'their edit\n');
  const { result } = run(r);
  await assert.rejects(result, (e) => e instanceof ShipError && /unsaved edits[\s\S]*a\.txt[\s\S]*another chat/.test(e.message));
  assert.equal(readFileSync(join(r.installed, 'a.txt'), 'utf8'), 'their edit\n');
});

test('an app that was not rebuilt keeps the machine waiting until the time runs out', async () => {
  const r = repos();
  const old = git(r.main, 'rev-parse', 'main');
  const { lines, result } = run(r, { network: { peerWeb: old, offline: false } });
  const out = await result;
  assert.equal(out.ok, false);
  const text = lines.join('\n');
  assert.match(text, new RegExp(`VM\\s+waiting: runs \\w{7}, but the app is built from ${old.slice(0, 7)}`));
  assert.match(text, /Still waiting after 1 min: VM/);
  assert.match(text, /did not reach every online machine/);
});

test('a machine whose sync stays blocked is marked stuck', () => {
  const contains = (want, have) => want === have;
  const info = { version: { full: 'old' }, web: { commit: 'old' }, sync: { reason: 'Local changes are blocking automatic updates.' } };
  assert.deepEqual(machineState(info, 'new', contains),
    { state: 'waiting', text: 'runs old: Local changes are blocking automatic updates.', note: 'Local changes are blocking automatic updates.' });
  assert.equal(machineState({ version: { full: 'old' }, sync: { diverged: true, with: 'Laptop' } }, 'new', contains).note,
    'it and Laptop both have their own changes');
  assert.equal(machineState(null, 'new', contains).text, 'restarting');
  assert.equal(machineState({ version: { full: 'new' }, web: { commit: 'new', dirty: true } }, 'new', contains).text,
    'runs new, app built from new with unsaved edits');
});

test('stops waiting for a machine whose sync note does not change', async () => {
  const r = repos();
  const { lines, result } = run(r, { network: { offline: false, peerSync: { reason: 'Local changes are blocking automatic updates.' } }, ship: { waitMs: 10 * 60_000 } });
  const out = await result;
  assert.equal(out.ok, false);
  const text = lines.join('\n');
  assert.match(text, /VM\s+stuck: runs \w{7}: Local changes are blocking automatic updates\./);
  assert.match(text, /Stuck: VM\./);
  assert.doesNotMatch(text, /Still waiting/);
});

test('a machine that is restarting when ship starts is waited for', async () => {
  const r = repos();
  const { lines, result } = run(r, { network: { offline: false, restarting: 3 } });
  const out = await result;
  assert.equal(out.ok, true);
  assert.deepEqual(out.offline, []);
  const text = lines.join('\n');
  assert.match(text, /Laptop\s+waiting: runs \w{7}/);
  assert.match(text, /Laptop\s+ok: runs/);
});

test("refuses to touch another chat's unfinished merge in main", async () => {
  const r = repos();
  git(r.main, 'checkout', '-q', '-b', 'other');
  commit(r.main, 'a.txt', 'theirs\n', 'other');
  git(r.main, 'checkout', '-q', 'main');
  commit(r.main, 'a.txt', 'mine\n', 'main side');
  assert.throws(() => git(r.main, 'merge', 'other'));
  writeFileSync(join(r.main, 'b.txt'), 'their fix in progress\n');
  const { result } = run(r);
  await assert.rejects(result, (e) => e instanceof ShipError && /Another merge is not finished/.test(e.message));
  assert.equal(existsSync(join(r.main, '.git', 'MERGE_HEAD')), true);
  assert.equal(readFileSync(join(r.main, 'b.txt'), 'utf8'), 'their fix in progress\n');
});

test('a copy that is not on a branch is refused', async () => {
  const r = repos();
  git(r.wt, 'checkout', '-q', '--detach');
  const { result } = run(r);
  await assert.rejects(result, (e) => e instanceof ShipError && /not on a branch/.test(e.message));
});

test('main without origin is not reported as shipped', async () => {
  const r = repos();
  git(r.main, 'remote', 'remove', 'origin');
  const { lines, result } = run(r, { network: { offline: false } });
  const out = await result;
  assert.equal(out.ok, false);
  assert.match(lines.join('\n'), /Main has no origin[\s\S]*but origin does not have it/);
});

test('waits for an update that already runs here before it moves the installed checkout', async () => {
  const r = repos();
  const before = git(r.installed, 'rev-parse', 'HEAD');
  let busy = 2;
  const seen = [];
  const updateLock = async (work) => {
    seen.push(git(r.installed, 'rev-parse', 'HEAD'));
    return busy-- > 0 ? { updated: false, reason: 'an update is already running' } : work();
  };
  const { lines, result } = run(r, { network: { offline: false }, ship: { updateLock } });
  const out = await result;
  assert.equal(out.ok, true);
  assert.deepEqual(seen, [before, before, before], 'the checkout stays put while the update runs');
  assert.match(lines.join('\n'), /Waiting for the update that runs on this machine/);
});

test('a machine that comes back late is still checked while another one keeps ship waiting', async () => {
  const r = repos();
  // Laptop answers only after 60 s; VM needs 30 asks (about 90 s) to update.
  const { lines, result } = run(r, { network: { offline: false, restarting: 20, peerLag: 30 }, ship: { waitMs: 10 * 60_000 } });
  const out = await result;
  assert.equal(out.ok, true);
  assert.deepEqual(out.offline, []);
  assert.match(lines.join('\n'), /Laptop\s+ok: runs/);
});

test("the merge commit is newer than both parents, even in the same second", async () => {
  const r = repos();
  const parents = ['main', 'helm/x'].map((ref) => Number(git(r.main, 'log', '-1', '--format=%ct', ref)));
  // The test clock starts at 0, far behind the commits: the merge must still be newer.
  const { result } = run(r);
  await result;
  assert.ok(Number(git(r.main, 'log', '-1', '--format=%ct', 'main')) > Math.max(...parents));
});

test('runs private release proof only after all online machines have the release', async () => {
  const r = repos();
  let checked = false;
  const {result} = run(r, {network:{offline:false}, ship:{verifyRelease:async ({tip}) => {
    assert.equal(git(r.installed, 'rev-parse', 'HEAD'), tip);
    checked = true;
  }}});
  assert.equal((await result).ok, true);
  assert.equal(checked, true);
});
test('a failed private release proof prevents a shipped result', async () => {
  const r = repos();
  const {result} = run(r, {network:{offline:false}, ship:{verifyRelease:async () => {throw Error('Reconnect failed');}}});
  await assert.rejects(result, /Reconnect failed/);
});
