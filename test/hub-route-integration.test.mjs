import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = mkdtempSync(join(tmpdir(), 'helm-route-'));
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

async function until(check) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(20);
  }
  throw new Error('condition timed out');
}

/**
 * Two real hubs that can both reach the same machine, as the VM's and the
 * machine's own do. Unchanged relay code on the far side: what a hub on the
 * previous Helm version would do.
 */
test('both routes to a machine are timed over real hubs and its own hub is used', { timeout: 30000 }, async context => {
  const network = N.createNetwork({ name: 'local', port: 8787 });
  const remote = 'aabbcc112233';
  network.machines[remote] = { id: remote, name: 'homepc', endpoints: [], addedAt: Date.now(), updatedAt: Date.now() };
  N.saveNetwork(network);

  const children = [];
  const links = [];
  let mesh;
  context.after(async () => {
    for (const link of links) link.stop();
    mesh?.stop();
    for (const child of children) {
      child.kill();
      if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
    }
  });
  async function farHub(name) {
    const messages = [];
    const child = fork(new URL('./fixtures/hub-mesh-peer.mjs', import.meta.url), [], {
      env: { ...process.env, HELM_DIR: join(root, name), HELM_DB: join(root, `${name}.sqlite`) },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    children.push(child);
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('message', message => messages.push(message));
    child.send({ command: 'start', network: { ...N.loadNetwork(), self: remote }, bridgeId: network.self });
    return until(() => {
      assert.equal(messages.find(message => message.error)?.error, undefined, stderr);
      return messages.find(message => message.ready)?.ready;
    });
  }
  const vm = await farHub('vm');
  const own = await farHub('own');
  // The machine publishes `own` as its address; `vm` is a third party.
  const roster = N.loadNetwork();
  roster.machines[remote].endpoints = [own];
  N.saveNetwork(roster);

  mesh = new HubMesh(N.loadNetwork, () => {}, () => {}, () => {});
  const daemon = {
    net: network, port: 1, name: 'local',
    describe: async () => ({ version: 'test' }),
    onLinkUp: source => mesh.up(source),
    linkDown: source => mesh.down(source),
    onFrame: async (source, frame) => {
      if (mesh.receive(source, frame)) return;
      if (frame.t === T.PONG) source.onPong();
    },
  };
  // The third party first: before this change, first-connected won.
  links.push(new Link(daemon, vm).start());
  await until(() => mesh.machines().has(remote));
  links.push(new Link(daemon, own).start());
  await until(() => [...mesh.links.values()].filter(machines => machines.has(remote)).length === 2);

  const [viaVm, viaOwn] = links;
  assert.equal(mesh.route(remote), viaOwn, 'the machine\'s own hub before measurements');
  await until(() => mesh.estimate(viaVm, remote)?.known && mesh.estimate(viaOwn, remote)?.known);
  await until(() => viaVm.rtt != null && viaOwn.rtt != null);
  // On loopback both are a millisecond or two: no clear win, so no move.
  assert.equal(mesh.route(remote), viaOwn);
  assert.deepEqual(await mesh.call(remote, 'session.watch', { id: 'x' }), { method: 'session.watch', sub: network.self, params: { id: 'x' } });

  const [row] = mesh.table();
  assert.equal(row.url, own);
  assert.equal(row.own, true);
  assert.equal(typeof row.ms, 'number');
  assert.equal(typeof row.hubMs, 'number');
  assert.equal(row.others[0].url, vm);
  const lines = routeLines({ machines: [{ ...row, name: 'homepc' }], lan: { on: false, reason: 'turned off', heard: [] } });
  assert.match(lines[0], /homepc\s+via its own hub http:\/\/127\.0\.0\.1:\d+\s+\d+ms/);
  assert.match(lines[0], /\n\s+also: http:\/\/127\.0\.0\.1:\d+ \d+ms/);
  assert.equal(lines.at(-1), '  local network: off (turned off)');

  // Losing the chosen hub moves the next request to the other at once.
  viaOwn.stop();
  assert.equal(mesh.route(remote), viaVm);
  assert.equal((await mesh.call(remote, 'session.watch', {})).method, 'session.watch');
});
