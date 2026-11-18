import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexDaemonSync, olderVersion, daemonBehind } from '../packages/connect/src/codex-daemon.js';

const profile = { id: 'codex', engine: 'codex', cmd: 'codex', env: { CODEX_HOME: '/tmp/helm-codex-daemon-test' } };
const report = (running, cli = '0.170.0', status = 'running') => JSON.stringify({ status, cliVersion: cli, appServerVersion: running });

/** A fake `codex`: answers `daemon version` with `versions`, records every call. */
function fakeCodex(versions) {
  const calls = [];
  let clock = 0;
  const run = async (cmd, args, env) => {
    calls.push({ cmd, args: args.join(' '), env });
    if (args.includes('version')) return `{"stage":"log line"}\n${versions.shift() ?? report('0.170.0')}\n`;
    if (args.includes('update')) return JSON.stringify({ status: 'updated', runningVersion: '0.170.0' });
    return null;
  };
  const sync = new CodexDaemonSync({ run, now: () => clock, everyMs: 60_000 });
  // One check round: the read it starts runs in the background, so let it land.
  const round = async (busy) => { const done = await sync.sync(profile, busy); await sync.reading(profile); return done; };
  return { calls, sync, round, tick: (ms) => { clock += ms; } };
}

test('versions compare by number, and an unknown version is never older', () => {
  assert.equal(olderVersion('0.165.0', '0.170.0'), true);
  assert.equal(olderVersion('0.170.0', '0.170.0'), false);
  assert.equal(olderVersion('0.99.0', '0.100.0'), true);
  assert.equal(olderVersion('0.171.0-alpha.1', '0.170.0'), false);
  assert.equal(olderVersion(undefined, '0.170.0'), false);
  assert.equal(daemonBehind({ status: 'stopped', appServerVersion: '0.1.0', cliVersion: '0.170.0' }), false);
});

test('an older daemon is updated from the installed Codex once nothing is busy', async () => {
  const { calls, round } = fakeCodex([report('0.165.0')]);
  assert.equal(await round(() => false), null, 'the first round only reads, in the background');
  assert.equal(calls.length, 1);
  const done = await round(() => false);
  assert.equal(done.status, 'updated');
  assert.deepEqual(calls.map((c) => c.args), ['app-server daemon version', 'app-server daemon update --from-cli --yes']);
  assert.equal(calls[1].env.CODEX_HOME, profile.env.CODEX_HOME);
});

test('a busy chat holds the update, which comes at the first idle check without a new version read', async () => {
  const { calls, round, tick } = fakeCodex([report('0.165.0')]);
  let busy = true;
  assert.equal(await round(() => busy), null);
  tick(2_500);
  assert.equal(await round(() => busy), null);
  assert.equal(calls.filter((c) => c.args.includes('update')).length, 0);
  busy = false;
  tick(2_500);
  await round(() => busy);
  assert.deepEqual(calls.map((c) => c.args), ['app-server daemon version', 'app-server daemon update --from-cli --yes']);
});

test('a current, stopped or silent daemon is left alone, and is read at most once a minute', async () => {
  for (const answer of [report('0.170.0'), report('0.171.0'), report('0.165.0', '0.170.0', 'stopped'), 'not json']) {
    const { calls, round, tick } = fakeCodex([answer]);
    await round(() => false);
    tick(30_000);
    await round(() => false);
    assert.deepEqual(calls.map((c) => c.args), ['app-server daemon version'], answer);
    tick(30_000);
    await round(() => false);
    assert.equal(calls.length, 2, answer);
  }
});

test('after an update the daemon is read again a minute later, not at once', async () => {
  const { calls, round, tick } = fakeCodex([report('0.165.0'), report('0.165.0')]);
  await round(() => false);
  await round(() => false);
  assert.equal(calls.length, 2);
  tick(2_500);
  await round(() => false);
  assert.equal(calls.length, 2, 'no read right after the update');
  tick(60_000);
  await round(() => false);
  await round(() => false);
  assert.equal(calls.filter((c) => c.args.includes('update')).length, 2);
});
