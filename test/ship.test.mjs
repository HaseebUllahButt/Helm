import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
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
function network({ installed }, { lag = 1, peerWeb = null, offline = true, peerSync = null } = {}) {
  const head = () => git(installed, 'rev-parse', 'HEAD');
  const start = head();
  let asks = 0;
  const machines = { self: { name: 'why' }, peer: { name: 'VM' }, ...(offline ? { off: { name: 'HomePC' } } : {}) };
  const rpc = async (_net, id, method) => {
    assert.equal(method, 'env.info');
    if (id === 'off') throw new Error('offline');
    if (id === 'self') return { name: 'why', version: { full: head(), dir: installed }, web: { commit: head() } };
    const v = !peerSync && asks++ >= lag ? head() : start;
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
      cwd: r.wt, net, rpc, checks: async () => {}, log: (l) => lines.push(l),
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
