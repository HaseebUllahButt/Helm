import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { brainHost } from '@helm/protocol/brain-host';

const root = mkdtempSync(join(tmpdir(), 'helm-network-brain-'));
process.env.HELM_DIR = root;
process.env.HELM_SSH_DIR = join(root, 'ssh');
const N = await import('@helm/protocol/network');
const { M } = await import('@helm/protocol');
const { Daemon } = await import('../packages/connect/src/agent.js');
test.after(() => rmSync(root, { recursive: true, force: true }));

test('the same VM wins on every device, even when offline or missing its old kind', () => {
  const machines = [
    { id: 'laptop', name: 'Laptop', online: true },
    { id: 'older', name: 'backup', kind: 'vm', online: true },
    { id: 'home', name: 'VM', online: false },
  ];
  assert.equal(brainHost(machines).id, 'home');
  assert.equal(brainHost([...machines].reverse()).id, 'home');
  assert.equal(brainHost(Object.fromEntries(machines.map(m => [m.id, m]))).id, 'home');
  assert.equal(brainHost([{ id: 'pc', name: 'why', kind: 'pc' }]), null);
  assert.equal(brainHost([{ id: 'vm', name: 'server', kind: 'vm' }]).id, 'vm');
});

test('concurrent brain.open calls create one VM conversation and initialize its map once', async () => {
  N.forgetNetwork();
  N.createNetwork({ name: 'VM' });
  const daemon = new Daemon();
  let session = null, starts = 0, inputs = 0;
  const prompts = [];
  daemon.refreshSnapshot = async () => ({ machines: { why: { name: 'why', at: Date.now(), folders: [{ path: '/work/project' }], sessions: [] } } });
  daemon.sessions = {
    brainSession: () => session,
    start: async options => {
      starts++;
      await new Promise(resolve => setTimeout(resolve, 10));
      session = { ...options, id: 'one-brain', engine: 'codex', driver: 'codex', status: 'idle' };
      return session;
    },
    input: async (id, text) => { inputs++; prompts.push({ id, text }); },
    get: () => session,
    connect: async () => session,
    setBrainVersion: (_, version) => { session.brainVersion = version; },
    setModel: async (_, model) => { session.model = model; },
  };
  const results = await Promise.all(Array.from({ length: 4 }, () => daemon.dispatch(M.BRAIN_OPEN, { profileId: 'codex' })));
  assert.equal(starts, 1);
  assert.equal(inputs, 1);
  assert.ok(results.every(r => r.session.id === 'one-brain' && r.envId === daemon.id));
  assert.equal(session.cwd, join(root, 'brain'));
  assert.match(prompts[0].text, /single Helm brain/);
  assert.match(prompts[0].text, /\/work\/project/);
  const reopened = await daemon.dispatch(M.BRAIN_OPEN, { model: 'other' });
  assert.equal(reopened.created, false);
  assert.equal(reopened.session.model, 'other');
  assert.equal(inputs, 1, 'opening the same brain does not resend its initialization');
  await assert.rejects(daemon.dispatch(M.SESSION_START, { brain: true }), /Use brain.open/);
});

test('a missing provider thread renews the same brain and carries its previous context', async () => {
  N.forgetNetwork();
  N.createNetwork({ name: 'VM' });
  const daemon = new Daemon();
  const session = { id: 'retained-brain', brain: true, brainVersion: 2, engine: 'codex', driver: 'codex', status: 'idle' };
  let missing = true, resets = 0, prompt = '';
  daemon.refreshSnapshot = async () => ({ machines: {} });
  daemon.sessions = {
    brainSession: () => session,
    get: () => session,
    connect: async () => { if (missing) throw new Error('thread not found: removed-provider-thread'); },
    resetBrainProvider: async id => { assert.equal(id, session.id); missing = false; resets++; delete session.brainVersion; },
    events: { tail: () => [{ type: 'turn.start', turnId: 'earlier', text: 'My project is /work/helm on why' }] },
    input: async (_, text) => { prompt = text; },
    setBrainVersion: (_, version) => { session.brainVersion = version; },
  };
  const result = await daemon.dispatch(M.BRAIN_OPEN, {});
  assert.equal(result.session.id, 'retained-brain');
  assert.equal(result.created, false);
  assert.equal(resets, 1);
  assert.match(prompt, /My project is \/work\/helm on why/);
  daemon.sessions.connect = async () => { throw new Error('authentication failed'); };
  await assert.rejects(daemon.dispatch(M.BRAIN_OPEN, {}), /authentication failed/);
  assert.equal(resets, 1, 'auth failures never replace the provider conversation');
});

test('a network with no VM refuses to create a local replacement brain', async () => {
  N.forgetNetwork();
  const net = N.createNetwork({ name: 'Laptop' });
  N.describeSelf(net, { kind: 'pc' });
  const daemon = new Daemon();
  daemon.sessions = { start: () => assert.fail('must not start a local brain') };
  await assert.rejects(daemon.dispatch(M.BRAIN_OPEN, { profileId: 'codex' }), /needs a VM/);
});

test('an adopted server reporting a missing thread on input is also renewed once', async () => {
  N.forgetNetwork();
  N.createNetwork({ name: 'VM' });
  const daemon = new Daemon();
  const session = { id: 'adopted-brain', brain: true, engine: 'codex', driver: 'codex', status: 'idle' };
  let inputs = 0, resets = 0;
  daemon.refreshSnapshot = async () => ({ machines: {} });
  daemon.sessions = {
    brainSession: () => session, get: () => session, connect: async () => session,
    events: { tail: () => [] },
    input: async () => { if (++inputs === 1) throw new Error('thread not found: old-thread'); },
    resetBrainProvider: async () => { resets++; },
    setBrainVersion: (_, version) => { session.brainVersion = version; },
  };
  const result = await daemon.dispatch(M.BRAIN_OPEN, {});
  assert.equal(result.session.id, 'adopted-brain');
  assert.equal(inputs, 2);
  assert.equal(resets, 1);
});

test('an offline remote VM cannot cause brain.open on a laptop to create a local brain', async () => {
  N.forgetNetwork();
  const net = N.createNetwork({ name: 'Laptop' });
  N.describeSelf(net, { kind: 'pc' });
  N.mergeRoster(net, { id: net.id, machines: {
    remotevm: { id: 'remotevm', name: 'VM', kind: 'vm', endpoints: ['http://127.0.0.1:1'], addedAt: Date.now(), updatedAt: Date.now() },
  }, devices: {}, revoked: {} });
  const daemon = new Daemon();
  daemon.sessions = { start: () => assert.fail('must not start a laptop brain') };
  await assert.rejects(daemon.dispatch(M.BRAIN_OPEN, { profileId: 'codex' }));
});

test('retiring a former machine brain preserves its session and event history', async () => {
  process.env.HELM_NO_SERVICE = '1';
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const saved = { id: 'former', title: 'Brain', cwd: '/work', engine: 'codex', driver: 'codex', brain: true, status: 'idle' };
  writeFileSync(join(root, 'sessions.json'), JSON.stringify({ version: 1, sessions: [saved] }));
  const sessions = new Sessions(new EventEmitter());
  try {
    sessions.events.append(saved.id, { type: 'turn.start', turnId: 'old-turn', text: 'Owner-confirmed project location' });
    sessions.retireBrains();
    assert.equal(sessions.brainSession(), null);
    assert.equal(sessions.get(saved.id).title, 'Brain');
    assert.equal(sessions.get(saved.id).brain, undefined);
    assert.equal(JSON.parse(readFileSync(join(root, 'sessions.json'))).sessions.length, 1);
    assert.equal(sessions.events.since(saved.id, 0)[0].text, 'Owner-confirmed project location');
  } finally { sessions.stop(); }
});
