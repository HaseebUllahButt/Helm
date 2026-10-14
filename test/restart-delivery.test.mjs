import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// All selectors are set before any Helm import, in this process and its
// children. This test never connects to the owner's network or services.
const root = mkdtempSync(join(tmpdir(), 'helm-restart-delivery-'));
Object.assign(process.env, { HELM_DIR: root, HELM_DB: join(root, 'hub.sqlite'), HELM_SSH_DIR: join(root, 'ssh'),
  HELM_PROCS_SOCKET: join(root, 'procs.sock'), HELM_TERMINALS_SOCKET: join(root, 'terms.sock'), HELM_NATIVE_SOCKET: join(root, 'native.sock'),
  HELM_NO_SERVICE: '1', HELM_NO_SYSTEMD_RUN: '1', HELM_NO_UPDATE: '1' });
const { startRelay } = await import('../apps/relay/src/server.js');
const { createNetwork } = await import('@helm/protocol/network');
const { hubRpc } = await import('../packages/connect/src/hub-client.js');
const { reliableInput } = await import('../packages/protocol/reliable-input.js');
const { TerminalHost } = await import('../packages/connect/src/terminals.js');

const waitFor = async (fn, timeout = 15_000) => {
  const until = Date.now() + timeout;
  for (;;) { const result = await fn(); if (result) return result; if (Date.now() > until) throw new Error('fixture timed out'); await new Promise(resolve => setTimeout(resolve, 25)); }
};
const notice = (child, predicate) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { cleanup(); reject(new Error('daemon notice timed out')); }, 15_000);
  const message = value => { if (predicate(value)) { cleanup(); resolve(value); } };
  const exit = code => { cleanup(); reject(new Error(`fixture exited early: ${code}\n${child.fixtureErrors?.() ?? ''}`)); };
  const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exit); };
  child.on('message', message); child.on('exit', exit);
});

test('running helper and exactly one copy of each message survive an actual daemon replacement', { timeout: 45_000 }, async t => {
  const hub = await startRelay({ port: 0, host: '127.0.0.1', openLogin: false });
  const port = hub.server.address().port;
  const net = createNetwork({ name: 'restart-test', port });
  const agent = join(root, 'agent.mjs');
  const fakeAgent = new URL('./fake-agent.mjs', import.meta.url).href;
  writeFileSync(agent, `import {appendFileSync} from 'node:fs';\nawait import(${JSON.stringify(fakeAgent)});\nlet buf=''; process.stdin.on('data', chunk => { buf+=chunk; let at; while((at=buf.indexOf('\\n'))>=0) { const line=buf.slice(0,at); buf=buf.slice(at+1); if(!line)continue; const m=JSON.parse(line); if(m.method==='session/prompt')appendFileSync(${JSON.stringify(join(root, 'prompts'))},JSON.stringify({pid:process.pid,prompt:m.params.prompt})+'\\n'); } });\nsetInterval(()=>appendFileSync(${JSON.stringify(join(root, 'heartbeats'))},process.pid+'\\n'),50);\n`);
  const command = join(root, 'devin');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(command, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(agent)} "$@"\n`, { mode: 0o700 });
  writeFileSync(join(root, 'profiles.json'), JSON.stringify({ version: 1, profiles: [
    { id: 'test', engine: 'devin', cmd: command, args: [], env: { FAKE_TURN_MS: '2000' }, source: 'alias' },
  ] }));
  const children = [];
  const boot = async () => {
    const child = fork(fileURLToPath(new URL('./fixtures/restart-delivery-daemon.mjs', import.meta.url)), [], {
      env: { ...process.env }, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.push(child);
    let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
    child.fixtureErrors = () => errors;
    child.stdout.resume();
    try { await notice(child, value => value.ready); } catch (error) { error.message += '\n' + errors; throw error; }
    return child;
  };
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'exit'); child.kill('SIGTERM'); await done;
    }
    const host = new TerminalHost({ socketPath: process.env.HELM_PROCS_SOCKET, unit: 'helm-test-procs' });
    if (await host.ensure({ spawn: false }).catch(() => false)) await host.shutdown();
    await hub.stop(); rmSync(root, { recursive: true, force: true });
  });
  let daemon = await boot();
  let ready = notice(daemon, value => value.helper); daemon.send('setup');
  const { helper, parent } = await ready;
  const rpc = (method, params, timeout = 300) => hubRpc(net, net.self, method, params, { timeout: Math.min(timeout, 300), budget: Math.min(timeout, 300) });
  await hubRpc(net, net.self, 'session.input', { id: helper, data: 'original task' }, { timeout: 5000, budget: 5000 });
  const prompts = () => { try { return readFileSync(join(root, 'prompts'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch { return []; } };
  const beats = () => { try { return readFileSync(join(root, 'heartbeats'), 'utf8').trim().split('\n'); } catch { return []; } };
  await waitFor(() => prompts().length === 1);
  const pid = prompts()[0].pid;
  ready = notice(daemon, value => value.dropping); daemon.send('drop'); await ready;
  const accepted = notice(daemon, value => value.acceptedWithoutReply);
  const first = reliableInput(rpc, { id: helper, data: 'change of plan' }, { messageId: '1'.repeat(32), timeout: 20_000 });
  await accepted;
  let exit = once(daemon, 'exit'); daemon.kill('SIGKILL'); await exit;
  // The message below starts while no daemon exists. Neither sender exits
  // or invents a replacement helper; both retry their original identities.
  const second = reliableInput(rpc, { id: helper, data: 'stop building the old plan' }, { messageId: '2'.repeat(32), timeout: 20_000 });
  const before = beats().filter(value => value === String(pid)).length;
  await waitFor(() => beats().filter(value => value === String(pid)).length >= before + 4);
  daemon = await boot();
  await Promise.all([first, second]);
  const inventory = await rpc('session.list', { includeDelegations: true }, 3000);
  assert.equal(inventory.sessions.find(session => session.id === helper)?.delegation.parentId, parent);
  await waitFor(() => prompts().length >= 3);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(prompts().length, 3, 'the lost acknowledgment and reconnect must not duplicate either message');
  assert.ok(prompts().every(prompt => prompt.pid === pid), 'the same OS agent process handles all three messages');
  const text = prompts().map(prompt => JSON.stringify(prompt.prompt));
  for (const expected of ['original task', 'change of plan', 'stop building the old plan']) assert.equal(text.filter(value => value.includes(expected)).length, 1);
  // A later graceful service restart also retains the receipts.
  exit = once(daemon, 'exit'); daemon.kill('SIGTERM'); await exit;
  daemon = await boot();
  await reliableInput(rpc, { id: helper, data: 'change of plan' }, { messageId: '1'.repeat(32) });
  assert.equal(prompts().length, 3);
  t.diagnostic(`Helper ${helper}, PID ${pid}: survived SIGKILL and SIGTERM; lost-ack and downtime messages each arrived once.`);
});
