import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

const root = mkdtempSync(join(tmpdir(), 'helm-direct-'));
process.env.HELM_DIR = join(root, 'local');
process.env.HELM_DB = join(root, 'local.sqlite');
process.env.HELM_SSH_DIR = join(root, 'ssh');
process.env.HELM_NO_SERVICE = '1';
const N = await import('@helm/protocol/network');
const { T } = await import('@helm/protocol');
const { Link } = await import('../packages/connect/src/agent.js');
const { HubMesh, routeLines } = await import('../packages/connect/src/hub-mesh.js');
const { cleanup } = await import('node-datachannel');
test.after(() => { cleanup(); rmSync(root, { recursive: true, force: true }); });

async function until(check, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(20);
  }
  throw new Error('condition timed out');
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/**
 * Two machines on loopback, each its own process with its own hub: this one
 * dials the other's hub, as the laptop dials the VM's. The other machine's
 * hub is unchanged relay code, so what passes here passes through a hub on
 * the previous Helm too.
 */
test('requests go direct when the channel is up and faster, and the hub takes over safely', { timeout: 90_000 }, async (context) => {
  const network = N.createNetwork({ name: 'local', port: 8787 });
  const far = 'aabbcc112233';
  const old = 'ddeeff445566';
  for (const [id, name] of [[far, 'vm'], [old, 'oldpc'], ['c0ffee000000', 'third']]) {
    network.machines[id] = { id, name, endpoints: [], addedAt: Date.now(), updatedAt: Date.now() };
  }
  N.saveNetwork(network);
  const phone = N.issueDevice(N.loadNetwork(), 'phone');

  const children = [];
  const links = [];
  let mesh;
  context.after(async () => {
    for (const link of links) link.stop();
    mesh?.stop();
    for (const child of children) {
      child.kill();
      if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
    }
  });

  // Each machine's log of what it was asked, which way, and as whom.
  const calls = new Map();
  const machine = async (id, name, { old: isOld = false } = {}) => {
    const messages = [];
    calls.set(id, []);
    const child = fork(new URL('./fixtures/direct-machine.mjs', import.meta.url), [], {
      env: { ...process.env, HELM_DIR: join(root, name), HELM_DB: join(root, `${name}.sqlite`) },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    children.push(child);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('message', (message) => {
      if (message.call) calls.get(id).push(message.call);
      else messages.push(message);
    });
    child.send({ command: 'start', network: { ...N.loadNetwork(), self: id }, old: isOld });
    const url = await until(() => {
      assert.equal(messages.find((m) => m.error)?.error, undefined, stderr);
      return messages.find((m) => m.ready)?.ready;
    });
    const command = async (name, extra = {}) => {
      const before = messages.length;
      child.send({ command: name, ...extra });
      return until(() => messages.slice(before).find((m) => m.acknowledged === name || m.error));
    };
    return { url, command };
  };

  const vm = await machine(far, 'vm');
  const oldpc = await machine(old, 'oldpc', { old: true });
  const roster = N.loadNetwork();
  roster.machines[far].endpoints = [vm.url];
  roster.machines[old].endpoints = [oldpc.url];
  N.saveNetwork(roster);

  // Real time, plus a skew the test moves to skip the waits that stop a
  // route flapping - waiting them out for real would make this minutes long.
  let skew = 0;
  mesh = new HubMesh(N.loadNetwork, () => {}, () => {}, () => {},
    { now: () => performance.now() + skew, probeEvery: 0, direct: true });
  const daemon = {
    net: network, port: 1, name: 'local',
    describe: async () => ({ version: 'test', directRpc: 1 }),
    onLinkUp: (source) => mesh.up(source),
    linkDown: (source) => mesh.down(source),
    onFrame: async (source, frame) => {
      if (mesh.receive(source, frame)) return;
      if (frame.t === T.PONG) source.onPong();
    },
  };
  const toVm = new Link(daemon, vm.url).start();
  const toOld = new Link(daemon, oldpc.url).start();
  links.push(toVm, toOld);
  // The hub route to the VM, slowed on demand the way a VPN slows it.
  let hubDelay = 0;
  const send = toVm.send.bind(toVm);
  toVm.send = (t, extra) => (t === T.HUB_RPC && hubDelay ? void setTimeout(() => send(t, extra), hubDelay) : send(t, extra));
  await until(() => mesh.machines().has(far) && mesh.machines().has(old));

  const via = (id, method) => calls.get(id).filter((c) => c.method === method).map((c) => c.via);
  const timedDirect = async () => {
    await until(() => mesh.direct.estimate(far)?.known);
    for (let i = 0; i < 6 && !mesh.table().find((r) => r.env === far).direct.used; i++) {
      mesh.probeAll();
      await until(() => !mesh.timing.get(toVm)?.get(far)?.probing && !mesh.direct.channels.get(far)?.probing);
    }
    return until(() => mesh.table().find((r) => r.env === far).direct.used);
  };

  // --- Before: every request through the hub. The first one asks for a
  // channel in the background; on loopback it is not clearly faster, so
  // requests stay on the hub - direct must win on numbers, not by default.
  await mesh.call(far, 'session.list', {});
  assert.deepEqual(via(far, 'session.list'), ['hub']);
  await until(() => mesh.direct.isOpen(far));
  const hubTimes = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    await mesh.call(far, 'ping', {});
    hubTimes.push(performance.now() - start);
  }
  assert.ok(via(far, 'ping').filter((v) => v === 'hub').length >= 20, 'unslowed, the hub is kept');
  const directTimes = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    await mesh.direct.call(far, 'ping', {}, { sub: network.self });
    directTimes.push(performance.now() - start);
  }
  console.log(`# loopback round trip, median of 20: hub ${median(hubTimes).toFixed(2)}ms, direct ${median(directTimes).toFixed(2)}ms`);

  // --- The hub route gets slow (a VPN); the channel is now clearly faster.
  hubDelay = 60;
  await timedDirect();
  const slowHub = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    await mesh.call(far, 'ping', {});
    slowHub.push(performance.now() - start);
  }
  console.log(`# with the hub slowed by 60ms: requests take ${median(slowHub).toFixed(2)}ms (direct)`);
  assert.deepEqual(await mesh.call(far, 'session.list', {}), { method: 'session.list', caller: network.self, via: 'direct' });
  // A phone attached here is passed on in its own name, as over a hub.
  assert.deepEqual(await mesh.call(far, 'session.list', {}, { sub: phone.id }),
    { method: 'session.list', caller: phone.id, via: 'direct' });
  // The channel cannot speak for another machine: refused over there.
  await assert.rejects(mesh.direct.call(far, 'session.list', {}, { sub: 'c0ffee000000' }), { code: 'forbidden' });
  assert.equal(calls.get(far).filter((c) => c.caller === 'c0ffee000000').length, 0);

  const [row] = mesh.table().filter((r) => r.env === far);
  assert.equal(row.direct.state, 'open');
  const lines = routeLines({ machines: [{ ...row, name: 'vm' }] });
  assert.match(lines[0], /^ {2}vm\s+direct {2}\d+ms\n\s+backup: via its own hub http:\/\/127\.0\.0\.1:\d+ {2}\d+ms/);

  // --- A write in flight when the channel dies: uncertain, run once only.
  const write = mesh.call(far, 'session.input', { hang: true, text: 'once' });
  const failed = assert.rejects(write, (error) => error.uncertain === true);
  await until(() => via(far, 'session.input').length === 1);
  await vm.command('dropChannels');
  await failed;
  await delay(300);
  assert.deepEqual(via(far, 'session.input'), ['direct'], 'never sent again over the hub');
  // The next request is a new one: it takes the hub.
  assert.equal((await mesh.call(far, 'session.input', { text: 'next' })).via, 'hub');

  // --- A read in flight when the channel dies is asked again over the hub.
  skew += 120_000;
  await mesh.call(far, 'session.list', {});
  await until(() => mesh.direct.isOpen(far));
  await timedDirect();
  const read = mesh.call(far, 'session.events', { hang: true, id: 's' });
  await until(() => via(far, 'session.events').length === 1);
  await vm.command('dropChannels');
  assert.equal((await read).via, 'hub');
  assert.deepEqual(via(far, 'session.events'), ['direct', 'hub']);

  // --- Revoked over there: refused on the next request, then cut off.
  skew += 120_000;
  await mesh.call(far, 'session.list', {});
  await until(() => mesh.direct.isOpen(far));
  await vm.command('revoke', { id: network.self });
  await assert.rejects(mesh.direct.call(far, 'session.list', {}, { sub: network.self }), { code: 'forbidden' });
  const dropped = await vm.command('dropRevoked');
  assert.equal(dropped.peers, 0);
  await until(() => !mesh.direct.isOpen(far));

  // --- The machine on the previous Helm: never a channel, always the hub.
  assert.equal((await mesh.call(old, 'session.list', {})).via, 'hub');
  await delay(500);
  assert.equal(mesh.direct.channels.has(old), false);
  assert.deepEqual(mesh.table().find((r) => r.env === old).direct, { state: 'unsupported', ms: null, used: false });
  assert.equal(calls.get(old).filter((c) => c.via === 'direct').length, 0);
});

test('this machine revoking another closes the channel to it', { timeout: 60_000 }, async (context) => {
  // Covered against fakes in direct-mesh.test.mjs; here only that the real
  // channel goes down when the roster says so.
  const network = N.loadNetwork();
  const far = 'aabbcc112233';
  const child = fork(new URL('./fixtures/direct-machine.mjs', import.meta.url), [], {
    env: { ...process.env, HELM_DIR: join(root, 'vm2'), HELM_DB: join(root, 'vm2.sqlite') },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const messages = [];
  child.on('message', (m) => messages.push(m));
  const fresh = { ...network, revoked: {} };
  child.send({ command: 'start', network: { ...fresh, self: far } });
  const url = await until(() => messages.find((m) => m.ready)?.ready);
  fresh.machines[far].endpoints = [url];
  N.saveNetwork(fresh);
  const mesh = new HubMesh(N.loadNetwork, () => {}, () => {}, () => {}, { probeEvery: 0, direct: true });
  const daemon = {
    net: fresh, port: 1, name: 'local', describe: async () => ({ version: 'test' }),
    onLinkUp: (s) => mesh.up(s), linkDown: (s) => mesh.down(s),
    onFrame: async (s, f) => { if (!mesh.receive(s, f) && f.t === T.PONG) s.onPong(); },
  };
  const link = new Link(daemon, url).start();
  context.after(async () => {
    link.stop();
    mesh.stop();
    child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
  });
  await until(() => mesh.machines().has(far));
  await mesh.call(far, 'session.list', {});
  await until(() => mesh.direct.isOpen(far));
  N.revoke(N.loadNetwork(), far);
  mesh.dropRevoked(N.loadNetwork().revoked);
  assert.equal(mesh.direct.isOpen(far), false);
  await assert.rejects(mesh.call(far, 'session.list', {}), /unknown machine/);
});
