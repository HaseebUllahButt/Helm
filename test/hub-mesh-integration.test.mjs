import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

const root = mkdtempSync(join(tmpdir(), 'helm-mesh-'));
process.env.HELM_DIR = join(root, 'local');
process.env.HELM_DB = join(root, 'local.sqlite');
const N = await import('@helm/protocol/network');
const { startRelay } = await import('@helm/relay');
const { Link } = await import('../packages/connect/src/agent.js');
const { HubMesh } = await import('../packages/connect/src/hub-mesh.js');

async function until(check) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(20);
  }
  throw new Error('condition timed out');
}

test('local-only clients reach remote machines over the existing outbound daemon link and recover after loss', { timeout: 30000 }, async context => {
  const network = N.createNetwork({ name: 'local', port: 8787 });
  const remote = 'aabbcc112233';
  network.machines[remote] = { id: remote, name: 'remote', endpoints: [], addedAt: Date.now(), updatedAt: Date.now() };
  network.machines.indirect = { id: 'indirect', name: 'indirect', endpoints: [] };
  N.saveNetwork(network);
  const phone = N.issueDevice(network, 'PWA');
  const hub = await startRelay({ port: 0, host: '127.0.0.1', dbFile: process.env.HELM_DB, openLogin: false });
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const frames = [];
  const bridgeFrames = [];
  const messages = [];
  const child = fork(new URL('./fixtures/hub-mesh-peer.mjs', import.meta.url), [], {
    env: { ...process.env, HELM_DIR: join(root, 'remote'), HELM_DB: join(root, 'remote.sqlite') },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  child.on('message', message => messages.push(message));
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  let link;
  let client;
  context.after(async () => {
    link?.stop();
    client?.terminate();
    hub.stop();
    child.kill();
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
    rmSync(root, { recursive: true, force: true });
  });
  child.send({ command: 'start', network: { ...N.loadNetwork(), self: remote }, bridgeId: network.self });
  const upstream = await until(() => {
    assert.equal(messages.find(message => message.error)?.error, undefined, stderr);
    return messages.find(message => message.ready)?.ready;
  });
  const mesh = new HubMesh(N.loadNetwork, hub.meshChanged, hub.meshEvent);
  hub.attachMesh(mesh);
  const daemon = {
    net: network, port: hub.server.address().port, name: 'local',
    describe: async () => ({ version: 'test' }),
    onLinkUp: source => mesh.up(source),
    linkDown: source => mesh.down(source),
    onFrame: async (source, frame) => { bridgeFrames.push(frame); mesh.receive(source, frame); },
  };
  link = new Link(daemon, upstream).start();
  await until(() => mesh.machines().has(remote));
  const headers = { authorization: `Bearer ${phone.token}`, 'content-type': 'application/json' };
  const machines = async () => (await (await fetch(base + '/api/machines', { headers })).json()).machines;
  assert.equal((await machines()).find(machine => machine.id === remote).online, true);
  assert.equal((await machines()).find(machine => machine.id === remote).info.version, 'mesh-test');
  assert.equal(mesh.machines().has('indirect'), false, 'indirect routes must not be advertised to other hubs');
  client = new WebSocket(base.replace('http:', 'ws:') + '/ws?role=client', { headers });
  client.on('message', raw => frames.push(JSON.parse(raw)));
  await until(() => frames.some(frame => frame.t === 'welcome'));
  let sequence = 0;
  async function rpc(method, params = {}) {
    const id = `request-${++sequence}`;
    client.send(JSON.stringify({ t: 'rpc', id, env: remote, method, params }));
    return until(() => frames.find(frame => frame.t === 'rpcResult' && frame.id === id));
  }
  assert.equal((await rpc('session.list')).result.sessions.length, 120);
  assert.equal(messages.filter(message => message.call).at(-1).call.sub, phone.id);
  const read = await fetch(base + '/api/read', {
    method: 'POST', headers, body: JSON.stringify({ env: remote, method: 'session.events', params: { id: 'chat' } }),
  });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).result.sub, phone.id);
  client.send(JSON.stringify({ t: 'subscribe', env: remote }));
  await delay(50);
  await rpc('session.watch', { id: 'chat' });
  await until(() => frames.find(frame => frame.t === 'event' && frame.env === remote && frame.payload.id === 'chat'));
  await assert.rejects(mesh.call('indirect', 'session.list', {}, { sub: phone.id }), /not connected/);
  link.send('hubRpc', { id: 'loop-test', env: 'indirect', sub: phone.id, method: 'session.list' });
  const loopReply = await until(() => bridgeFrames.find(frame => frame.id === 'loop-test'));
  assert.equal(loopReply.error.code, 'offline');
  const beforeSpoof = messages.filter(message => message.call).length;
  client.send(JSON.stringify({ t: 'hubRpc', id: 'device-spoof', env: remote, sub: phone.id, method: 'session.input' }));
  await delay(50);
  assert.equal(messages.filter(message => message.call).length, beforeSpoof, 'devices cannot impersonate a forwarding hub');
  const pendingWrite = rpc('hang');
  const hanging = await until(() => messages.find(message => message.call?.method === 'hang'));
  link.send('rpcResult', { id: hanging.call.id, ok: true, result: 'forged' });
  await delay(50);
  assert.equal(frames.some(frame => frame.result === 'forged'), false, 'only the target daemon can answer its request');
  child.send({ command: 'dropBridge' });
  const uncertain = await pendingWrite;
  assert.equal(uncertain.ok, false);
  assert.match(uncertain.error.message, /delivery may be uncertain/);
  await until(() => frames.some(frame => frame.t === 'presence' && frame.env === remote && frame.online === false));
  await until(() => mesh.machines().has(remote));
  assert.equal((await rpc('session.list')).result.sessions.length, 120);
  assert.equal(messages.filter(message => message.call?.method === 'hang').length, 1);
  await rpc('session.watch', { id: 'after-reconnect' });
  await until(() => frames.find(frame => frame.t === 'event' && frame.payload.id === 'after-reconnect'));
  child.send({ command: 'dropTarget' });
  await until(() => !mesh.machines().has(remote));
  assert.equal((await machines()).find(machine => machine.id === remote).online, false);
  child.send({ command: 'connectTarget' });
  await until(() => mesh.machines().has(remote));
  assert.equal((await rpc('session.list')).result.sessions.length, 120);
  child.send({ command: 'revoke', id: phone.id });
  await until(() => messages.some(message => message.acknowledged === 'revoke'));
  const denied = await rpc('session.input', { data: 'forbidden' });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'forbidden');
  assert.equal(messages.some(message => message.call?.method === 'session.input'), false);
});
