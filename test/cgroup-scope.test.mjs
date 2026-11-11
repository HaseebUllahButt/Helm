import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// On 2026-11-11 the memory guard (systemd-oomd) stopped one unit that held
// every terminal, every build and the Codex daemon: 3440 processes, three
// working helpers. Each terminal and agent now gets a memory group (scope)
// of its own, so the guard stops only the biggest one.
const dir = mkdtempSync(join(tmpdir(), 'helm-cgroup-scope-'));
process.env.HELM_DIR = dir;
delete process.env.HELM_TERMINALS_SOCKET;
delete process.env.HELM_PROCS_SOCKET;
process.env.HELM_NO_SERVICE = '1';
// Hosts as plain children, as in a private copy; scopes asked for by name.
process.env.HELM_NO_SYSTEMD_RUN = '1';
process.env.HELM_SCOPES = '1';

const scope = await import('../packages/connect/src/cgroup-scope.js');
const { describeStop } = await import('../packages/connect/src/agent-stops.js');
const { TerminalHost, PROC_SOCKET_PATH, SOCKET_PATH } = await import('../packages/connect/src/terminals.js');

test.after(() => rmSync(dir, { recursive: true, force: true }));

const cgroupOf = (pid) => readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim().split('/').pop();

async function until(fn, ms = 10_000) {
  const stop = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > stop) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('scope names belong to this Helm and to one id', () => {
  const prefix = scope.scopePrefix('proc', 'a/b c');
  assert.match(prefix, /^helm-proc-[0-9a-f]{10}-a_b_c-$/);
  const unit = scope.unitName('proc', 'a/b c');
  assert.ok(unit.startsWith(prefix) && unit.endsWith('.scope'));
  assert.notEqual(unit, scope.unitName('proc', 'a/b c'), 'a stray process in an old scope must not block the next start');
});

test('no scope when they are turned off', async () => {
  process.env.HELM_SCOPES = '';
  process.env.HELM_NO_SCOPES = '1';
  scope.resetScopes();
  try {
    assert.equal(await scope.scopeCommand('proc', 'x', '/bin/sh', []), null);
  } finally {
    process.env.HELM_SCOPES = '1';
    delete process.env.HELM_NO_SCOPES;
    scope.resetScopes();
  }
});

test('the journal decides whether the memory guard stopped a unit', async () => {
  const prefix = scope.scopePrefix('proc', 'agent');
  let reads = 0;
  const stops = async () => { reads++; return reads < 2 ? [] : [`${prefix}abc123.scope`]; };
  // The manager writes its line just after the kill: asked again.
  assert.equal(await scope.stoppedForMemory([prefix], { since: Date.now(), waits: [10, 10], stops }), true);
  assert.equal(reads, 2);
  // Another unit's stop is not this one's.
  assert.equal(await scope.stoppedForMemory([scope.scopePrefix('proc', 'other')], { since: Date.now(), waits: [], stops: async () => [`${prefix}x.scope`] }), false);
  // A stop that was not a kill asks once.
  reads = 0;
  assert.equal(await scope.stoppedForMemory([prefix], { since: Date.now(), killed: false, stops: async () => { reads++; return []; } }), false);
  assert.equal(reads, 1);
});

test('a memory stop is said in plain words', () => {
  const text = describeStop({ at: Date.parse('2026-11-11T16:20:02Z'), id: 'a', signal: 'SIGKILL', memory: true });
  assert.match(text, /^The memory guard stopped its process at \d+ Nov \d\d:\d\d:\d\d, because the computer ran out of memory\.$/);
  assert.match(scope.MEMORY_STOP, /memory guard stopped this program/);
});

const ready = process.platform === 'linux' && await scope.scopesReady();

test('each agent process and terminal gets its own memory group', { skip: !ready && 'no systemd user manager here' }, async (t) => {
  const procs = new TerminalHost({ socketPath: PROC_SOCKET_PATH, unit: 'helm-procs' });
  const ptys = new TerminalHost({ socketPath: SOCKET_PATH });
  t.after(async () => {
    for (const h of [procs, ptys]) { await h.shutdown?.().catch(() => {}); h.detach(); }
  });
  await procs.ensure();
  const a = await procs.openProc('agent-a', { cmd: 'sleep', args: ['30'], cwd: dir, env: {} });
  const b = await procs.openProc('agent-b', { cmd: '/bin/sh', args: ['-c', 'sleep 30'], cwd: dir, env: {} });
  const groupA = await until(() => cgroupOf(a.pid).startsWith(scope.scopePrefix('proc', 'agent-a')) && cgroupOf(a.pid));
  const groupB = await until(() => cgroupOf(b.pid).startsWith(scope.scopePrefix('proc', 'agent-b')) && cgroupOf(b.pid));
  assert.notEqual(groupA, groupB);
  // A child stays in its agent's group.
  assert.ok(groupA.endsWith('.scope'));

  // A kill that the memory guard did not send is reported as before.
  const pipe = procs.procPipe('agent-a');
  const exit = new Promise((r) => pipe.onExit(r));
  process.kill(a.pid, 'SIGKILL');
  const e = await exit;
  assert.equal(e.signal, 'SIGKILL');
  assert.equal(e.memory, false);

  // A command that is not there still fails to start, as before.
  await assert.rejects(procs.openProc('missing', { cmd: 'helm-no-such-command', args: [], cwd: dir, env: {} }), /could not start/);

  await ptys.ensure();
  const term = await ptys.open('term-a', { cmd: 'sleep', args: ['30'], cwd: dir }).catch(() => null);
  if (!term?.pid) return t.diagnostic('no pty support here');
  await until(() => cgroupOf(term.pid).startsWith(scope.scopePrefix('term', 'term-a')));
  // A CLI terminal's host makes the group itself: it reads the CLI's own
  // arguments, which must stay as they were.
  const cli = await ptys.open('cli-a', { cmd: 'sleep', args: ['30'], cwd: dir, exactEnv: true,
    env: { PATH: process.env.PATH, HOME: process.env.HOME }, native: { engine: 'claude' } });
  await until(() => cgroupOf(cli.pid).startsWith(scope.scopePrefix('term', 'cli-a')));
  const native = await until(() => ptys.nativeSessions?.().find((n) => n.id === 'cli-a'));
  assert.equal(native.nativePid, cli.pid);
});
