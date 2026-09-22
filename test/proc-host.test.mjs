import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, fakeCli } from './helpers.mjs';

// Agent processes outliving the daemon.
//
// ACP sessions are held by the terminal host for the same reason ptys are:
// an upgrade restarts the daemon, and a restart must not kill a thread that
// is mid-turn. The host buffers what the agent says while nobody is
// listening and hands it over on rebind, so a turn that finished during the
// gap still reports its end.
const dir = mkdtempSync(join(tmpdir(), 'helm-proc-host-'));
process.env.HELM_DIR = dir;
process.env.HELM_NO_SERVICE = '1';
// systemd-run would put the host in a transient unit that outlives the test
// run; here the plain detached child is what we want.
process.env.HELM_NO_SYSTEMD_RUN = '1';

const { TerminalHost, PROC_SOCKET_PATH } = await import('../packages/connect/src/terminals.js');
const { DevinDriver } = await import('../packages/connect/src/drivers/devin.js');
const { ClaudeDriver } = await import('../packages/connect/src/drivers/claude.js');
const { CodexDriver } = await import('../packages/connect/src/drivers/codex.js');

// The proc host is the terminal-host binary on its own socket and unit -
// same protocol, separate lifecycle from the pty host.
const procHost = () => new TerminalHost({ socketPath: PROC_SOCKET_PATH, unit: 'helm-procs' });

const AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
// The driver appends its own argv ('acp', ...) in front - a wrapper takes
// them the way the real `devin` binary would.
const agentCmd = join(dir, 'devin');
writeFileSync(agentCmd, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(AGENT)} "$@"\n`);
chmodSync(agentCmd, 0o755);

async function until(fn, ms = 8000) {
  const stop = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > stop) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('a proc survives the daemon that started it, backlog intact', async (t) => {
  const first = procHost();
  t.after(() => first.detach());
  assert.equal(await first.ensure(), true, 'a host should start on demand');

  await first.openProc('p1', { cmd: agentCmd, args: ['acp'], env: {} });
  assert.equal(first.hasProc('p1'), true);

  const pipe = first.procPipe('p1');
  let seen = '';
  pipe.onData((d) => { seen += d; });
  pipe.write(JSON.stringify({ jsonrpc: '2.0', id: 'i1', method: 'initialize', params: {} }) + '\n');
  await until(() => seen.includes('"i1"'), 4000);

  // The daemon goes away mid-conversation.
  first.detach();
  await new Promise((r) => setTimeout(r, 300));

  // Its replacement finds the process still running - and rebindable.
  const second = procHost();
  t.after(() => second.detach());
  assert.equal(await second.ensure(), true);
  assert.equal(second.hasProc('p1'), true, 'the proc should have outlived the first daemon');

  const pipe2 = second.procPipe('p1');
  assert.ok(pipe2, 'a surviving proc hands back a stream');
  let seen2 = '';
  pipe2.onData((d) => { seen2 += d; });
  pipe2.write(JSON.stringify({ jsonrpc: '2.0', id: 'i2', method: 'session/new', params: {} }) + '\n');
  await until(() => seen2.includes('fake-session-1'), 4000);

  pipe2.kill('SIGTERM');
  await until(() => !second.hasProc('p1'), 4000);
});

test('a turn still running across a restart reports its end', async (t) => {
  const host1 = procHost();
  t.after(() => host1.detach());
  assert.equal(await host1.ensure(), true);

  // Daemon one: the driver starts a hosted agent and prompts it. The fake
  // waits before answering, so the turn is open when the daemon goes away.
  let openTurn = null;
  const d1 = new DevinDriver({
    cmd: agentCmd, args: [], env: { FAKE_TURN_MS: '500' },
    cwd: dir, mode: 'ask',
    procHost: host1, procId: 's1',
    openTurn: () => openTurn, pendingEvents: () => [],
  });
  const log1 = collect(d1);
  await d1.send('do the thing');
  const started = await log1.until((e) => e.type === 'item.delta');
  assert.ok(started, 'the agent answered before the restart');
  openTurn = log1.of('turn.start')[0]?.turnId;
  assert.ok(openTurn);

  // Daemon one exits - politely, the way an upgrade stops it.
  await d1.suspend();
  host1.detach();
  await new Promise((r) => setTimeout(r, 200));

  // Daemon two: the process is still there; a new driver binds it and the
  // turn's response - already produced while nobody was attached - lands
  // as the turn.done the log was missing.
  const host2 = procHost();
  t.after(() => host2.detach());
  assert.equal(await host2.ensure(), true);
  assert.equal(host2.hasProc('s1'), true, 'the agent process should have survived');

  const d2 = new DevinDriver({
    cmd: agentCmd, args: [], env: { FAKE_TURN_MS: '500' },
    cwd: dir, mode: 'ask',
    procHost: host2, procId: 's1',
    openTurn: () => openTurn, pendingEvents: () => [],
  });
  const log2 = collect(d2);
  await d2.start();
  const done = await log2.until((e) => e.type === 'turn.done');
  assert.equal(done.turnId, openTurn);
  assert.equal(done.status, 'ok');
  await d2.kill();
});

test('a permission request stays answerable across a restart', async (t) => {
  const host1 = procHost();
  t.after(() => host1.detach());
  assert.equal(await host1.ensure(), true);

  const pendings = [];
  const d1 = new DevinDriver({
    cmd: agentCmd, args: [], env: { FAKE_TURN_MS: '300', FAKE_ASK: '1' },
    cwd: dir, mode: 'ask',
    procHost: host1, procId: 's2',
    openTurn: () => null, pendingEvents: () => [],
  });
  const log1 = collect(d1);
  await d1.send('run something risky');
  const ask = await log1.until((e) => e.type === 'permission.request');
  pendings.push(ask);   // what the event log would have recorded
  const openTurn = log1.of('turn.start')[0]?.turnId;

  await d1.suspend();
  host1.detach();
  await new Promise((r) => setTimeout(r, 200));

  const host2 = procHost();
  t.after(() => host2.detach());
  assert.equal(await host2.ensure(), true);
  assert.equal(host2.hasProc('s2'), true);

  const d2 = new DevinDriver({
    cmd: agentCmd, args: [], env: { FAKE_TURN_MS: '300', FAKE_ASK: '1' },
    cwd: dir, mode: 'ask',
    procHost: host2, procId: 's2',
    openTurn: () => openTurn, pendingEvents: () => pendings,
  });
  const log2 = collect(d2);
  await d2.start();
  // The question the first daemon surfaced is the question the second
  // answers - the agent was still holding it open.
  await d2.answer(ask.requestId, { option: 'allow' });
  const done = await log2.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  await d2.kill();
});

test('a hosted Codex app-server survives and is rebound by the next daemon', async (t) => {
  const fake = fakeCli('codex', 'plain');
  const env = { CODEX_HOME: join(fake.dir, 'home') };
  const procId = `codex-server-${createHash('sha256').update(`${fake.cmd}|${env.CODEX_HOME}`).digest('hex').slice(0, 20)}`;
  const host1 = procHost();
  t.after(() => host1.detach());
  assert.equal(await host1.ensure(), true);

  const d1 = new CodexDriver({
    cmd: fake.cmd, env, cwd: fake.dir,
    mode: 'ask', procHost: host1, procId: 'codex-persist',
  });
  const log1 = collect(d1);
  await d1.send('Reply with exactly the words: hello from helm');
  await log1.until((e) => e.type === 'turn.done');
  assert.equal(host1.hasProc(procId), true);
  const threadId = d1.threadId;

  await d1.suspend();
  host1.detach();
  const host2 = procHost();
  t.after(() => host2.detach());
  assert.equal(await host2.ensure(), true);
  assert.equal(host2.hasProc(procId), true, 'the app-server should outlive the first daemon');

  const d2 = new CodexDriver({
    cmd: fake.cmd, env, cwd: fake.dir,
    mode: 'ask', engineSessionId: threadId, procHost: host2, procId: 'codex-persist',
  });
  await d2.start();
  assert.equal(d2.threadId, threadId, 'the replacement driver should attach to the same thread');
  await d2.kill();
  await until(() => !host2.hasProc(procId));
});

test('a hosted Claude process survives and is rebound by the next daemon', async (t) => {
  const fake = fakeCli('claude', 'plain');
  const host1 = procHost();
  t.after(() => host1.detach());
  assert.equal(await host1.ensure(), true);

  const d1 = new ClaudeDriver({
    cmd: fake.cmd, env: {}, cwd: fake.dir, mode: 'ask',
    procHost: host1, procId: 'claude-persist',
  });
  const log1 = collect(d1);
  await d1.send('Reply with exactly the words: hello from helm');
  await log1.until((e) => e.type === 'turn.done');
  assert.equal(host1.hasProc('claude-persist'), true);
  const sessionId = d1.engineSessionId;

  await d1.suspend();
  host1.detach();
  const host2 = procHost();
  t.after(() => host2.detach());
  assert.equal(await host2.ensure(), true);
  assert.equal(host2.hasProc('claude-persist'), true, 'Claude should outlive the first daemon');

  const d2 = new ClaudeDriver({
    cmd: fake.cmd, env: {}, cwd: fake.dir, mode: 'ask', engineSessionId: sessionId,
    procHost: host2, procId: 'claude-persist',
  });
  await d2.start();
  assert.equal(d2.engineSessionId, sessionId, 'the replacement driver should keep the same Claude session');
  await d2.kill();
  await until(() => !host2.hasProc('claude-persist'));
});

// Leave nothing running: the host outlives this process by design.
test.after(async () => {
  const last = procHost();
  if (await last.ensure({ spawn: false }).catch(() => false)) {
    await last.shutdown();
  }
  rmSync(dir, { recursive: true, force: true });
});
