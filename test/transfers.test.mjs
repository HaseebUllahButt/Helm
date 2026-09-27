import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'helm-transfers-'));
process.env.HELM_DIR = join(root, 'helm');
process.env.HELM_DB = join(root, 'hub.sqlite');
process.env.HELM_SSH_DIR = join(root, 'ssh');
process.env.HELM_NO_SERVICE = '1';
delete process.env.INVOCATION_ID;

const work = join(process.cwd(), `.helm-transfers-test-${process.pid}`);
rmSync(work, { recursive: true, force: true });

test.after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

const CT = await import('../packages/connect/src/code-transfer.js');
const {
  Transfers, transferGrantDigest, transferRequestDigest,
  encodeTransferGrant, decodeTransferGrant,
} = await import('../packages/connect/src/transfers.js');

const SRC = 'aa11bb22cc33';
const OTHER = 'cc33dd44ee55';
const net = {
  id: 'n1',
  self: 'bb22cc33dd44',
  machines: {
    [SRC]: { id: SRC, name: 'laptop' },
    [OTHER]: { id: OTHER, name: 'desktop' },
    bb22cc33dd44: { id: 'bb22cc33dd44', name: 'target' },
  },
  devices: { dev1: { id: 'dev1', label: 'phone' } },
  revoked: {},
};
const signPub = CT.codeSigningInfo().codeSignPubkey;
net.machines[SRC].codeSignPubkey = signPub;
net.machines[OTHER].codeSignPubkey = signPub;
net.machines[net.self].codeSignPubkey = signPub;

const sourceDir = join(work, 'source');
mkdirSync(sourceDir, { recursive: true });
writeFileSync(join(sourceDir, 'a.txt'), 'code');

let seq = 0;
const requestFor = (grantToken, over = {}) => {
  const grant = decodeTransferGrant(grantToken);
  const transferId = (seq++).toString(16).padStart(24, '0');
  const snapshot = CT.createCodeSnapshot(sourceDir);
  const p = {
    transferId,
    sourceMachineId: SRC,
    targetMachineId: net.self,
    folder: join(work, `dest-${transferId}`),
    envelope: CT.sealCodeSnapshot(snapshot, grant.transferPubkey, transferId),
    snapshotDigest: snapshot.digest,
    grantSecret: grant.secret,
    ...over,
  };
  p.requestDigest = transferRequestDigest(p);
  p.sourceSignature = CT.signHandoffDigest(p.requestDigest);
  return p;
};

const make = (opts = {}) => new Transfers({ network: () => net, ...opts });
const forSrc = { sourceMachineId: SRC };

test('a grant is issued by this machine only - never a device or a peer', () => {
  const t = make();
  for (const caller of ['dev1', SRC, undefined, 'eeff00112233']) {
    assert.throws(() => t.receive(forSrc, caller), /this machine only/, String(caller));
  }
  const revoked = new Transfers({
    network: () => ({ ...net, revoked: { [net.self]: Date.now() } }),
  });
  assert.throws(() => revoked.receive(forSrc, net.self), /this machine only/);

  const { grant, expiresAt } = t.receive(forSrc, net.self);
  const decoded = decodeTransferGrant(grant);
  assert.equal(decoded.v, 1);
  assert.equal(decoded.targetMachineId, net.self);
  assert.equal(decoded.sourceMachineId, SRC);
  assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + 10 * 60_000);
  assert.equal(
    CT.verifyHandoffSignature(signPub, transferGrantDigest(decoded), decoded.signature),
    true,
  );
});

test('a grant must name a real, unrevoked source machine', () => {
  const t = make();
  for (const sourceMachineId of [undefined, 'dev1', 'eeff00112233', 42]) {
    assert.throws(() => t.receive({ sourceMachineId }, net.self), /machine of this network/);
  }
  const revokedSource = new Transfers({
    network: () => ({ ...net, revoked: { [OTHER]: Date.now() } }),
  });
  assert.throws(
    () => revokedSource.receive({ sourceMachineId: OTHER }, net.self), /machine of this network/);
});

test('the grant ttl clamps to 1-15 minutes and grants live only in memory', () => {
  const t = make();
  const short = t.receive({ ...forSrc, ttlMs: 5_000 }, net.self);
  assert.ok(short.expiresAt - Date.now() >= 59_000 && short.expiresAt - Date.now() <= 61_000);
  const long = t.receive({ ...forSrc, ttlMs: 60 * 60_000 }, net.self);
  assert.ok(long.expiresAt - Date.now() <= 15 * 60_000);
});

test('a grant token decodes strictly or not at all', () => {
  const t = make();
  const { grant } = t.receive(forSrc, net.self);
  const decoded = decodeTransferGrant(grant);
  assert.match(decoded.transferPubkey, /^[A-Za-z0-9_-]{40,512}$/);
  assert.match(decoded.secret, /^[A-Za-z0-9_-]{20,128}$/);
  assert.ok(Number.isInteger(decoded.expiresAt));

  for (const bad of [
    'not a token', 'x'.repeat(5000),
    encodeTransferGrant({ ...decoded, v: 2 }),
    encodeTransferGrant({ ...decoded, targetMachineId: 'zzz' }),
    encodeTransferGrant({ ...decoded, sourceMachineId: 'zzz' }),
    encodeTransferGrant({ ...decoded, transferPubkey: 'short' }),
    encodeTransferGrant({ ...decoded, secret: 'short' }),
    encodeTransferGrant({ ...decoded, expiresAt: 'soon' }),
    encodeTransferGrant({ ...decoded, signature: 'short' }),
  ]) {
    assert.throws(() => decodeTransferGrant(bad), /invalid transfer grant/);
  }
});

test('a signed source request lands the snapshot and answers the minimal receipt', async () => {
  const t = make();
  const { grant } = t.receive(forSrc, net.self);
  const p = requestFor(grant);
  const r = await t.accept(p, SRC);

  assert.deepEqual(Object.keys(r).sort(), ['bytes', 'digest', 'files', 'folder', 'skipped']);
  assert.equal(r.files, 1);
  assert.equal(readFileSync(join(r.folder, 'a.txt'), 'utf8'), 'code');
  assert.equal(r.folder, p.folder);

  const other = requestFor(grant);
  await assert.rejects(() => t.accept(other, SRC), /different request/);

  const corrupted = { ...p, envelope: { ...p.envelope, data: 'AAAA' } };
  const again = await t.accept(corrupted, SRC);
  assert.deepEqual(again, r);
});

test('a grant issued for one source cannot be spent by another machine', async () => {
  const t = make();
  const { grant } = t.receive(forSrc, net.self);
  const foreign = requestFor(grant, { sourceMachineId: OTHER });
  await assert.rejects(() => t.accept(foreign, OTHER), /not issued for this source machine/);
  assert.equal(existsSync(foreign.folder), false);

  const r = await t.accept(requestFor(grant), SRC);
  assert.equal(r.files, 1);
});

test('identical concurrent accepts join into one materialization', async () => {
  const t = make();
  const { grant } = t.receive(forSrc, net.self);
  const p = requestFor(grant);
  const [a, b] = await Promise.all([t.accept(p, SRC), t.accept(p, SRC)]);
  assert.deepEqual(a, b);
  assert.equal(readFileSync(join(a.folder, 'a.txt'), 'utf8'), 'code');
});

test('unknown and expired grant secrets are refused', async () => {
  const t = make();
  const { grant } = t.receive(forSrc, net.self);
  const p = requestFor(grant);

  const unknown = requestFor(grant, { grantSecret: 'x'.repeat(24) });
  await assert.rejects(() => t.accept(unknown, SRC), /unknown or expired/);

  let now = Date.now();
  const timed = new Transfers({ network: () => net, now: () => now });
  const { grant: dying } = timed.receive({ ...forSrc, ttlMs: 60_000 }, net.self);
  const stale = requestFor(dying);
  now += 2 * 60_000;
  await assert.rejects(() => timed.accept(stale, SRC), /unknown or expired/);
  assert.equal(existsSync(stale.folder), false);
});

test('a wrong caller or signature fails before a byte is written', async () => {
  const t = make();
  const { grant } = t.receive(forSrc, net.self);
  const p = requestFor(grant);

  await assert.rejects(() => t.accept(p, 'dev1'), /machines? of this network/);
  await assert.rejects(() => t.accept(p, 'eeff00112233'), /machines? of this network/);
  await assert.rejects(() => t.accept(p, net.self), /does not match the calling machine/);
  await assert.rejects(
    () => t.accept({ ...p, targetMachineId: SRC }, SRC), /not this machine/);
  await assert.rejects(
    () => t.accept({ ...p, requestDigest: '0'.repeat(64) }, SRC), /does not match its contents/);
  await assert.rejects(
    () => t.accept({ ...p, sourceSignature: CT.signHandoffDigest('0'.repeat(64)) }, SRC),
    /source signature/);
  await assert.rejects(
    () => t.accept({ ...p, sourceSignature: 'AAAA' }, SRC), /source signature/);
  assert.equal(existsSync(p.folder), false);
});

test('dispatch: devices cannot receive or accept, and session.start cannot plant a handoff id', async (t) => {
  const N = await import('@helm/protocol/network');
  const { M } = await import('@helm/protocol');
  const { Daemon } = await import('../packages/connect/src/agent.js');
  N.forgetNetwork();
  const realNet = N.createNetwork({ name: 'testbox', port: 8999 });
  const d = new Daemon({ name: 'testbox', port: 8999, advertiseLan: false });
  t.after(() => d.stop());
  d.transfers = new Transfers({ network: () => N.loadNetwork() });

  await assert.rejects(
    () => d.dispatch(M.TRANSFER_RECEIVE, { sourceMachineId: realNet.self }, 'dev1'),
    /this machine only/);
  await assert.rejects(
    () => d.dispatch(M.TRANSFER_ACCEPT, { transferId: 'a'.repeat(24) }, 'dev1'),
    /machines? of this network/);
  const offered = await d.dispatch(
    M.TRANSFER_RECEIVE, { sourceMachineId: realNet.self }, realNet.self);
  const decoded = decodeTransferGrant(offered.grant);
  assert.equal(decoded.targetMachineId, realNet.self);
  assert.equal(decoded.sourceMachineId, realNet.self);

  const seen = [];
  d.sessions = {
    start: async (opts) => { seen.push(opts); return { id: 's1' }; },
    stop: async () => {},
  };
  await d.dispatch(M.SESSION_START, { title: 'x', originHandoffId: 'a'.repeat(24) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].originHandoffId, undefined);
});
