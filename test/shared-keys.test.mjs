import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'helm-shared-keys-'));
process.env.HELM_DIR = root;
const { SharedKeyStore, keyHome, keyNames, token } = await import('../packages/connect/src/shared-key-store.js');
const { SharedKeys } = await import('../packages/connect/src/shared-keys.js');
const { codeKeyInfo, openSharedKeyPacket, sealCodeSnapshot } = await import('../packages/connect/src/code-transfer.js');
const { keyOutput } = await import('../packages/connect/src/key-output.js');
const { ExecutionJobs } = await import('../packages/connect/src/execution.js');
const { parseWorkArgs } = await import('../packages/connect/src/execution-cli.js');
const { parseSpawnArgs } = await import('../packages/connect/src/spawn-cli.js');
const { parseTaskArgs } = await import('../packages/connect/src/task-cli.js');
const { runKeysCommand } = await import('../packages/connect/src/shared-keys-cli.js');
test.after(() => rmSync(root, { recursive: true, force: true }));

const id = () => randomBytes(8).toString('hex');
const secret = token() + 'ñ="⌘"';
const otherSecret = token();
const { codePubkey } = codeKeyInfo();
const machines = {
  aaa: { id: 'aaa', addedAt: 1, name: 'Home', codePubkey },
  bbb: { id: 'bbb', addedAt: 2, name: 'Work', codePubkey },
};

function fixture(t) {
  const path = join(root, token(), 'vault.json');
  const store = new SharedKeyStore({ path, now: () => 200 });
  const state = { aaa: new Map(), bbb: new Map() }, cards = new Map(), nodes = {};
  function createNode(self) {
    const sessions = {
      get(chat) {
        if (!state[self].has(chat)) throw new Error('Chat missing.');
        return state[self].get(chat);
      },
      showHelmAsk(chat, card) { cards.set(card.requestId, { chat, ...card }); },
      closeHelmAsk(_chat, requestId) { cards.delete(requestId); },
    };
    const network = () => ({ self, machines, devices: { owner: {} }, revoked: {} });
    nodes[self]?.stop();
    nodes[self] = new SharedKeys({ sessions, network, store, directory: join(path, '..', self),
      rpc: async (target, method, params) => nodes[target].dispatch(method, params, self) });
  }
  createNode('aaa'); createNode('bbb');
  t.after(() => { nodes.aaa.stop(); nodes.bbb.stop(); });
  return { path, nodes, cards, state, createNode, store };
}

test('save from input and reuse private encryption across machines and restarts', async t => {
  const { nodes, path, state, createNode } = fixture(t);
  const output = [], input = Buffer.from(secret);
  const rpc = (who, method, params) => nodes[who].dispatch(method, params, 'bbb');
  await runKeysCommand(['set', 'APP_KEY'], { rpc, self: 'bbb', env: {}, read: async () => input, write: text => output.push(text) });
  assert.ok(input.every(byte => byte === 0));
  assert.deepEqual(output, ['Saved APP_KEY.']);
  assert.ok(!readFileSync(path, 'utf8').includes(secret));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  createNode('aaa');
  const chat = { id: id(), title: 'Ask once', status: 'working' };
  state.bbb.set(chat.id, chat);
  const request = { id: token(), names: ['APP_KEY'], target: 'aaa', kind: 'command', chat: chat.id };
  assert.deepEqual(await rpc('bbb', 'keys.request', request), { state: 'asking' });
  createNode('bbb');
  assert.deepEqual(await rpc('bbb', 'keys.request', request), { state: 'asking' });
  await nodes.bbb.answer(chat.id, 'keys-' + request.id, { option: 'allow', message: secret });
  assert.deepEqual(await rpc('bbb', 'keys.wait', { id: request.id }), { state: 'allowed' });
  assert.deepEqual(await nodes.aaa.claimCommand(request.id, 'bbb'), { APP_KEY: secret });
  await assert.rejects(nodes.aaa.claimCommand(request.id, 'bbb'), /already used/);
  const result = await rpc('bbb', 'keys.list', {});
  assert.deepEqual(result.keys, [{ name: 'APP_KEY', machines: ['Home'], lastUse: 200 }]);
  assert.deepEqual(result.grants.map(({ name, chat, machine }) => [name, chat, machine]), [['APP_KEY', chat.id, 'Work']]);
  assert.equal(JSON.stringify(result).includes(secret), false);
  for (const file of readdirSync(join(path, '..', 'bbb'))) {
    assert.equal(readFileSync(join(path, '..', 'bbb', file), 'utf8').includes(secret), false);
  }
});

test('only the intended machine and chat get each grant, and revocation stops the next use', async t => {
  const { nodes, state, store, cards } = fixture(t);
  store.set('A', secret);
  store.set('B', otherSecret);
  const local = (method, params) => nodes.aaa.dispatch(method, params, 'aaa');
  const remote = (method, params) => nodes.bbb.dispatch(method, params, 'bbb');
  const source = { id: id(), title: 'Source chat', status: 'working' };
  const child = { id: id(), title: 'Child chat', status: 'working' };
  state.aaa.set(source.id, source); state.bbb.set(child.id, child);
  const permit = { id: token(), kind: 'chat', names: ['B', 'A'], chat: source.id, target: 'bbb' };
  assert.deepEqual(await local('keys.request', permit), { state: 'asking' });
  assert.equal(cards.get('keys-' + permit.id).detail, 'A, B');
  await nodes.aaa.answer(source.id, 'keys-' + permit.id, { option: 'allow' });
  await assert.rejects(nodes.aaa.attach(permit.id, 'aaa', source), /no shared key grant/);
  await assert.rejects(nodes.bbb.attach(permit.id, 'bbb', child), /no shared key grant/);
  await nodes.bbb.attach(permit.id, 'aaa', child);
  await nodes.bbb.attach(permit.id, 'aaa', child);
  await assert.rejects(nodes.bbb.attach(permit.id, 'aaa', { ...child, id: id() }), /already used/);
  const use = { id: token(), kind: 'command', names: ['A', 'B'], chat: child.id, target: 'bbb' };
  assert.deepEqual(await remote('keys.request', use), { state: 'allowed' });
  const grants = (await local('keys.list', {})).grants;
  assert.ok(!grants.some(grant => grant.chat === source.id));
  const grant = grants.find(grant => grant.chat === child.id && grant.name === 'A');
  await nodes.aaa.dispatch('keys.revoke', { id: grant.id }, 'owner');
  await assert.rejects(nodes.bbb.claimCommand(use.id, 'bbb'), /ended access/);
  await nodes.bbb.attach(permit.id, 'aaa', child);
  const again = { ...use, id: token() };
  assert.deepEqual(await remote('keys.request', again), { state: 'asking' });
  await nodes.bbb.answer(child.id, 'keys-' + again.id, { option: 'deny' });
  assert.deepEqual(await remote('keys.wait', { id: again.id }), { state: 'denied' });
  child.status = 'exited';
  nodes.bbb.onSession(child);
  await assert.rejects(remote('keys.request', { ...use, id: token() }), /chat has ended/);
  assert.ok(!(await local('keys.list', {})).grants.some(g => g.chat === child.id));
  await local('keys.remove', { name: 'B' });
  assert.ok(!(await local('keys.list', {})).keys.some(key => key.name === 'B'));
});

test('requests reject unsupported destinations, read-only chats and untrusted callers', async t => {
  const { nodes, store, state } = fixture(t);
  store.set('ONLY', secret);
  const chat = { id: id(), mode: 'readonly' };
  state.bbb.set(chat.id, chat);
  const p = { id: token(), names: ['ONLY'], target: 'aaa', kind: 'command', chat: chat.id };
  await assert.rejects(nodes.bbb.dispatch('keys.request', p, 'owner'), /own machine/);
  await assert.rejects(nodes.bbb.dispatch('keys.request', p, 'aaa'), /own machine/);
  await assert.rejects(nodes.bbb.dispatch('keys.request', p, 'bbb'), /read-only/);
  await assert.rejects(nodes.aaa.dispatch('keys.vault', { action: 'list' }, 'owner'), /paired machine/);
  await assert.rejects(nodes.bbb.dispatch('keys.set', { name: 'ONLY', value: secret }, 'aaa'), /Manage shared keys/);
  assert.equal(keyHome({ machines }).id, 'aaa');
  assert.throws(() => keyNames(['EVIL=VALUE']), /key name/);
  assert.throws(() => openSharedKeyPacket(sealCodeSnapshot({ value: secret }, codePubkey, 'shared-key-save-A'), 'shared-key-save-B'));
});

test('keys survive arbitrary pipe chunk boundaries and stay out of command records', { timeout: 20_000 }, async t => {
  const sample = Buffer.from(`before ${secret} after ${otherSecret}.`);
  const expected = 'before [hidden] after [hidden].';
  for (let i = 0; i <= sample.length; i++) {
    const filter = keyOutput([secret, otherSecret]);
    assert.equal(Buffer.concat([filter(sample.subarray(0, i)), filter(sample.subarray(i)), filter(Buffer.alloc(0), true)]).toString(), expected);
  }

  const directory = join(root, 'commands');
  const jobs = new ExecutionJobs({ directory });
  t.after(() => jobs.stop());
  const job = token();
  jobs.start({ id: job, keyPermit: job, cwd: root, timeout: 10_000,
    argv: [process.execPath, '-e', 'const key = process.env.APP_KEY; process.stdout.write(key.slice(0, 6)); process.stdout.write(key.slice(6)); console.error(JSON.stringify({ key }));'] },
  'owner', { APP_KEY: secret });
  let cursor = 0, stdout = '', stderr = '', result;
  do {
    result = await jobs.read({ id: job, since: cursor, wait: 1000 }, 'owner');
    for (const chunk of result.chunks) {
      const value = Buffer.from(chunk.data, 'base64').toString();
      if (chunk.stream === 'stdout') stdout += value;
      else stderr += value;
    }
    cursor = result.last;
  } while (result.status !== 'exited' || result.more);
  assert.equal(result.exitCode, 0, result.error || stderr);
  assert.equal(stdout, '[hidden]');
  assert.deepEqual(JSON.parse(stderr), { key: '[hidden]' });
  assert.ok(!readFileSync(join(directory, job, 'state.json'), 'utf8').includes(secret));
  assert.ok(!readdirSync(join(directory, job)).includes('spec.json'));
});

test('repeatable key flags preserve words after -- and keyed tasks skip env files', () => {
  assert.deepEqual(parseWorkArgs(['--key', 'A', '--key', 'B', '--', 'echo', '--key']).keys, ['A', 'B']);
  assert.deepEqual(parseSpawnArgs(['work', '-', 'fake', '--key', 'A', '--key', 'B', '--', '--key']).options.key, ['A', 'B']);
  const task = parseTaskArgs(['work', '--account', 'fake', '--key', 'A', '--key', 'B', '--', 'hi'], { machineId: name => name });
  assert.equal(task.request.includeEnv, false);
  assert.deepEqual(task.options.key, ['A', 'B']);
});
