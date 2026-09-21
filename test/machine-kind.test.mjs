import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * What a machine is for: 'pc', 'vm' or 'nas', carried on its roster record.
 *
 * `kind` is held to the same bar as every other roster field - a closed set,
 * dropped when it is anything else - because a record only means something
 * when every machine agrees on what its fields may hold. And like the name,
 * it has exactly one author: redesignation is an RPC to the machine itself,
 * which is why the tests below go through the daemon's dispatch rather than
 * poking the file.
 */

const root = mkdtempSync(join(tmpdir(), 'helm-kind-'));
process.env.HELM_DIR = join(root, 'helm');
process.env.HELM_DB = join(root, 'hub.sqlite');
process.env.HELM_SSH_DIR = join(root, 'ssh');
process.env.HELM_NO_SERVICE = '1';
// Deterministic: the daemon only reinstalls its service when systemd is the
// thing running it, and these tests must never depend on how CI was started.
delete process.env.INVOCATION_ID;

const N = await import('@helm/protocol/network');
const { newNetworkId, newNetworkKey } = await import('@helm/protocol/identity');
const { M, CONTROLLER_REFUSAL } = await import('@helm/protocol');
const { Daemon } = await import('../packages/connect/src/agent.js');
const { join: joinNet } = await import('../packages/connect/src/serve.js');

test.after(() => rmSync(root, { recursive: true, force: true }));

const machine = (over = {}) => ({
  id: 'aa11bb22cc33',
  name: 'vm-c',
  endpoints: ['https://1-2-3-4.sslip.io'],
  updatedAt: Date.now(),
  addedAt: Date.now(),
  ...over,
});

const only = (over) => N.sanitizeRoster({
  id: 'n1', machines: { aa11bb22cc33: machine(over) }, devices: {}, revoked: {},
}).machines.aa11bb22cc33;

test('a real kind survives the roster checks; anything else is dropped', () => {
  for (const kind of ['pc', 'vm', 'nas']) {
    assert.equal(only({ kind }).kind, kind, kind);
  }
  for (const bad of ['server', 'device', 'controller', 'VM', 'nas\nrm', 42]) {
    assert.equal(only({ kind: bad }).kind, undefined, JSON.stringify(bad));
  }
  // A record from before kinds existed is still a good record.
  assert.ok(only({}));
});

test('a kind the author wrote survives a peer byte for byte', () => {
  // The gossip-convergence property: sanitising is identity on a well-formed
  // record, or two machines would trade full rosters every tick forever.
  const authored = {
    id: 'n1',
    machines: { aa11bb22cc33: machine({ kind: 'nas' }) },
    devices: {},
    revoked: {},
  };
  const stored = N.sanitizeRoster(authored);
  assert.equal(N.rosterHash(authored), N.rosterHash(stored));
});

test('a new network designates its founder the home', () => {
  N.forgetNetwork();
  const net = N.createNetwork({ name: 'first', port: 8787 });
  assert.equal(net.machines[net.self].kind, 'vm');
  assert.equal(net.role, 'vm');
});

test('a merge carries a peer\u2019s kind but not a made-up one', () => {
  N.forgetNetwork();
  const net = N.createNetwork({ name: 'self', port: 8787 });
  const incoming = {
    id: net.id,
    machines: {
      aa11bb22cc33: machine({ kind: 'nas' }),
      ff00ee11dd22: machine({ id: 'ff00ee11dd22', kind: 'fridge' }),
    },
    devices: {},
    revoked: {},
  };
  assert.equal(N.mergeRoster(net, incoming), true);
  assert.equal(net.machines.aa11bb22cc33.kind, 'nas');
  // The record is believed; the field that was not a kind is not.
  assert.ok(net.machines.ff00ee11dd22);
  assert.equal(net.machines.ff00ee11dd22.kind, undefined);
});

// ---------------------------------------------------------------- join

/** A join answer, canned for the one fetch serve.join makes. */
const stubJoin = (role) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      id: newNetworkId(), key: newNetworkKey(),
      machines: {}, devices: {}, revoked: {},
      self: 'aa11bb22cc33', role,
    }),
  });
  return () => { globalThis.fetch = realFetch; };
};

test('a join writes the invited kind onto the self record and the local note', async (t) => {
  for (const [role, want] of [['nas', 'nas'], ['vm', 'vm'], ['pc', 'pc'], ['bogus', 'pc'], [undefined, 'pc']]) {
    N.forgetNetwork();
    const restore = stubJoin(role);
    try {
      const net = await joinNet({ code: 'AAAA-BBBB', at: 'http://home:8787', name: 'joined', port: 8787 });
      assert.equal(net.role, want, `role ${role}`);
      assert.equal(net.machines[net.self].kind, want, `role ${role}`);
      // And what we wrote is something a peer accepts back unchanged.
      const mine = N.roster(N.loadNetwork());
      assert.equal(N.rosterHash(mine), N.rosterHash(N.sanitizeRoster(mine)));
    } finally { restore(); }
  }
});

// -------------------------------------------------- daemon-side redesignate

const daemon = () => new Daemon({ name: 'testbox', port: 8999, advertiseLan: false });

test('machine.set_kind refuses what is not a kind - controllers hardest', async (t) => {
  N.forgetNetwork();
  N.createNetwork({ name: 'testbox', port: 8999 });
  const d = daemon();
  t.after(() => d.stop());
  await assert.rejects(() => d.dispatch(M.MACHINE_SET_KIND, { kind: 'router' }), /one of: pc, vm, nas/);
  for (const word of ['device', 'controller', 'phone']) {
    await assert.rejects(
      () => d.dispatch(M.MACHINE_SET_KIND, { kind: word }),
      (err) => err.message === CONTROLLER_REFUSAL,
      word
    );
  }
});

test('pc and nas are a record change, written by the machine itself', async (t) => {
  N.forgetNetwork();
  const net = N.createNetwork({ name: 'testbox', port: 8999 });
  N.describeSelf(net, { kind: 'pc' });
  const d = daemon();
  t.after(() => d.stop());

  const r = await d.dispatch(M.MACHINE_SET_KIND, { kind: 'nas' });
  assert.equal(r.changed, true);
  assert.equal(r.from, 'pc');
  assert.equal(r.kind, 'nas');

  const after = N.loadNetwork();
  assert.equal(after.machines[after.self].kind, 'nas');
  // The local note travels in step, so `helm status` says the same thing.
  assert.equal(after.role, 'nas');

  // Asking for what it already is changes nothing but still answers.
  const same = await d.dispatch(M.MACHINE_SET_KIND, { kind: 'nas' });
  assert.equal(same.changed, false);
});

test('leaving vm drops the advertised https endpoint', async (t) => {
  N.forgetNetwork();
  const net = N.createNetwork({ name: 'testbox', port: 8999 });
  N.describeSelf(net, { endpoints: ['https://1-2-3-4.sslip.io', 'http://192.168.1.5:8999'] });
  const d = daemon();
  t.after(() => d.stop());
  // What a vm daemon was started with.
  d.advertised = ['https://1-2-3-4.sslip.io'];
  d.extra = ['https://1-2-3-4.sslip.io'];

  const r = await d.dispatch(M.MACHINE_SET_KIND, { kind: 'nas' });
  assert.equal(r.from, 'vm');
  assert.ok(r.notes.some((n) => /Caddy site can be removed/.test(n)));

  const after = N.loadNetwork();
  assert.equal(after.machines[after.self].kind, 'nas');
  assert.ok(!after.machines[after.self].endpoints.some((e) => e.startsWith('https://')),
    `https should be gone from ${after.machines[after.self].endpoints}`);
});

test('becoming vm advertises the address it was given', async (t) => {
  N.forgetNetwork();
  const net = N.createNetwork({ name: 'testbox', port: 8999 });
  N.describeSelf(net, { kind: 'pc' });
  const d = daemon();
  t.after(() => d.stop());

  const r = await d.dispatch(M.MACHINE_SET_KIND, { kind: 'vm', address: 'https://home.example' });
  assert.equal(r.kind, 'vm');
  const after = N.loadNetwork();
  assert.equal(after.machines[after.self].kind, 'vm');
  assert.ok(after.machines[after.self].endpoints.includes('https://home.example'));
  assert.equal(after.role, 'vm');
});

test('becoming vm reuses an https address it already serves', async (t) => {
  N.forgetNetwork();
  const net = N.createNetwork({ name: 'testbox', port: 8999 });
  N.describeSelf(net, { kind: 'pc' });
  const d = daemon();
  t.after(() => d.stop());
  // What the daemon was started with; claiming again is unnecessary.
  d.advertised = ['https://still.example'];
  d.extra = ['https://still.example'];

  const r = await d.dispatch(M.MACHINE_SET_KIND, { kind: 'vm' });
  assert.equal(r.kind, 'vm');
  const after = N.loadNetwork();
  assert.equal(after.machines[after.self].kind, 'vm');
  assert.ok(after.machines[after.self].endpoints.includes('https://still.example'));
});

test('a machine address is held to a bare https origin', async (t) => {
  N.forgetNetwork();
  N.createNetwork({ name: 'testbox', port: 8999 });
  const d = daemon();
  t.after(() => d.stop());
  await assert.rejects(
    () => d.dispatch(M.MACHINE_SET_KIND, { kind: 'vm', address: 'http://home.example' }),
    /https/
  );
  await assert.rejects(
    () => d.dispatch(M.MACHINE_SET_KIND, { kind: 'vm', address: 'https://home.example/path' }),
    /origin/
  );
});
