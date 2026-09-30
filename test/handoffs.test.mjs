import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The target side of a code handoff: one idempotent accept, driven by a
 * record on disk that survives retries and restarts. Sessions are faked -
 * what is being proved here is the sequencing and the durable record, not
 * the drivers.
 */

const helmDir = mkdtempSync(join(tmpdir(), 'helm-handoffs-'));
process.env.HELM_DIR = helmDir;
// materializeCode insists the landing folder is inside the home directory;
// the suite runs from the repo checkout, which is inside it.
const work = join(process.cwd(), `.helm-handoffs-test-${process.pid}`);
rmSync(work, { recursive: true, force: true });

test.after(() => {
  rmSync(helmDir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

const SRC = 'aa11bb22cc33';
const net = {
  id: 'n1',
  self: 'bb22cc33dd44',
  machines: {
    [SRC]: { id: SRC, name: 'laptop' },
    bb22cc33dd44: { id: 'bb22cc33dd44', name: 'target' },
  },
  devices: { dev1: { id: 'dev1', label: 'phone' } },
  revoked: {},
};

class FakeSessions {
  constructor() {
    this.starts = [];
    this.inputs = [];   // sends that reached the agent
    this.attempts = []; // every send the caller tried, dedupe excluded
    this.turns = new Map();     // turnId -> 'open' | 'done' | 'failed' | 'removed'
    this.byHandoff = new Map(); // handoffId -> session, the crash-recovery lookup
    this.failNextInput = false;
    this.startDelay = 0;  // slows start so concurrent accepts can overlap
  }
  async start(opts) {
    if (this.startDelay) {
      await new Promise((r) => setTimeout(r, this.startDelay));
    }
    this.starts.push(opts);
    const session = { id: `sess-${this.starts.length}`, title: opts.title ?? 'untitled' };
    if (opts.originHandoffId) this.byHandoff.set(opts.originHandoffId, session);
    if (opts.parent?.handoffId) this.byHandoff.set(opts.parent.handoffId, session);
    return session;
  }
  // The real Sessions finds a handoff's session through the handoff id on
  // its record (or its parent link, for records that predate the field)
  // when the handoff receipt was lost between the start and the write.
  handoffSession(handoffId) {
    return this.byHandoff.get(handoffId) ?? null;
  }
  // Same contract as the real Sessions over the event log: an open or done
  // turn dedupes, a failed or removed one refuses the recycled id.
  turnState(id, turnId) {
    return this.turns.get(turnId) ?? null;
  }
  async input(id, text, { turnId } = {}) {
    const state = this.turns.get(turnId) ?? null;
    if (state === 'open' || state === 'done') return { ok: true, duplicate: true };
    if (state === 'failed' || state === 'removed') {
      throw Object.assign(new Error('the turn already failed'), { code: 'turn_failed' });
    }
    this.attempts.push({ id, text, turnId });
    if (this.failNextInput) {
      this.failNextInput = false;
      this.turns.set(turnId, 'failed'); // the send logged a turn.done error
      throw new Error('driver refused the send');
    }
    this.turns.set(turnId, 'open');
    this.inputs.push({ id, text, turnId });
    return { ok: true };
  }
}

const CT = await import('../packages/connect/src/code-transfer.js');
const { Handoffs, handoffRequestDigest } = await import('../packages/connect/src/handoffs.js');

// The fixture source machine signs like a real one: the signing key under
// this HELM_DIR stands in for SRC's, so the roster pins its public half.
net.machines[SRC].codeSignPubkey = CT.codeSigningInfo().codeSignPubkey;

const handoffsDir = join(helmDir, 'handoffs-work');
const sourceDir = join(handoffsDir, 'source');
mkdirSync(sourceDir, { recursive: true });
writeFileSync(join(sourceDir, 'a.txt'), 'code');
writeFileSync(join(sourceDir, '.env'), 'TOKEN=x');

let seq = 0;
const request = (dir = sourceDir) => {
  const handoffId = (seq++).toString(16).padStart(24, '0');
  const snapshot = CT.createCodeSnapshot(dir);
  const p = {
    handoffId,
    sourceMachineId: SRC,
    targetMachineId: net.self,
    folder: join(work, `target-${handoffId}`),
    envelope: CT.sealCodeSnapshot(snapshot, CT.codeKeyInfo().codePubkey, handoffId),
    snapshotDigest: snapshot.digest,
    profileId: 'claudea',
    model: 'opus',
    mode: 'default',
    title: 'Handoff · a task',
    parent: {
      handoffId, machineId: SRC, sessionId: 'srcsession',
      sourceFolder: dir, digest: snapshot.digest,
    },
    prompt: 'pick up where the laptop left off',
    digest: snapshot.digest,
  };
  // The source computes the digest over the fields it just wrote, then
  // signs it - the pair is what makes the request immutable at the hub and
  // its author provable at the target.
  p.requestDigest = handoffRequestDigest(p);
  p.sourceSignature = CT.signHandoffDigest(p.requestDigest);
  return p;
};

// Rebind a mutated request so it is self-consistent again - the difference
// between 'a different operation' (reaches the record check) and 'a lying
// digest' (rejected at validation).
const rebind = (p) => {
  p.requestDigest = handoffRequestDigest(p);
  p.sourceSignature = CT.signHandoffDigest(p.requestDigest);
  return p;
};

// The target validates the named profile against what this machine really
// has - in tests that list is whatever the case needs.
const knownProfiles = async () => [{ id: 'claudea', engine: 'claude' }];
const make = (opts = {}) => new Handoffs({
  sessions: new FakeSessions(), network: () => net, profiles: knownProfiles, ...opts,
});

test('a handoff is accepted from the machine that sourced it, and nobody else', async () => {
  const p = request();
  // The declared source and the caller have to be the same machine.
  await assert.rejects(() => make().accept({ ...p, sourceMachineId: net.self }, SRC), /does not match/);
  // A device is not a machine; nor is an absent caller, nor an unknown id.
  await assert.rejects(() => make().accept(p, 'dev1'), /machines? of this network/);
  await assert.rejects(() => make().accept(p, undefined), /machines? of this network/);
  await assert.rejects(() => make().accept(p, 'eeff00112233'), /machines? of this network/);
  // A declared source that is not a roster machine is refused too.
  await assert.rejects(() => make().accept({ ...p, sourceMachineId: 'eeff00112233' }, 'eeff00112233'), /machines? of this network/);
  // A revoked machine's handoff is refused.
  await assert.rejects(() => new Handoffs({
    sessions: new FakeSessions(),
    network: () => ({ ...net, revoked: { [SRC]: Date.now() } }),
    profiles: knownProfiles,
  }).accept(p, SRC), /machines? of this network/);
  // And the ids themselves are checked.
  await assert.rejects(() => make().accept({ ...p, handoffId: 'not-hex' }, SRC), /handoff id/);
  // The work happens on this machine, so a job meant for anyone else - or
  // naming nobody - is refused before it touches the disk.
  await assert.rejects(() => make().accept({ ...p, targetMachineId: undefined }, SRC), /not this machine/);
  await assert.rejects(() => make().accept({ ...p, targetMachineId: SRC }, SRC), /not this machine/);
  await assert.rejects(() => make().accept({ ...p, targetMachineId: 'zz' }, SRC), /not this machine/);
  // A parent pointing at another handoff, another machine or another
  // snapshot is a lie.
  await assert.rejects(
    () => make().accept({ ...p, parent: { ...p.parent, machineId: net.self } }, SRC),
    /parent/,
  );
  await assert.rejects(
    () => make().accept({ ...p, parent: { ...p.parent, digest: '0'.repeat(64) } }, SRC),
    /parent/,
  );
  // The snapshot digest is required and is a sha256 hex.
  await assert.rejects(() => make().accept({ ...p, snapshotDigest: 'nope' }, SRC), /snapshot digest/);
  await assert.rejects(
    () => make().accept({ ...p, snapshotDigest: undefined, parent: undefined }, SRC),
    /snapshot digest/,
  );
  // The request digest is required, is a sha256 hex, and is honest about
  // the request it rides on - a changed prompt under a stale digest lies.
  await assert.rejects(
    () => make().accept({ ...p, requestDigest: undefined }, SRC), /request digest/);
  await assert.rejects(
    () => make().accept({ ...p, requestDigest: 'nope' }, SRC), /request digest/);
  await assert.rejects(
    () => make().accept({ ...p, requestDigest: '0'.repeat(64) }, SRC), /does not match its contents/);
  await assert.rejects(
    () => make().accept({ ...p, prompt: 'something else entirely' }, SRC), /does not match its contents/);
  // The request carries the source's signature over that digest: missing,
  // malformed, or signed over the wrong digest all fail before the disk.
  await assert.rejects(
    () => make().accept({ ...p, sourceSignature: undefined }, SRC), /source signature/);
  await assert.rejects(
    () => make().accept({ ...p, sourceSignature: 'AAAA' }, SRC), /source signature/);
  await assert.rejects(
    () => make().accept(
      { ...p, sourceSignature: CT.signHandoffDigest('0'.repeat(64)) }, SRC,
    ), /source signature/);
  // And a source whose roster record never published a signing key cannot
  // sign anything into existence.
  await assert.rejects(() => new Handoffs({
    sessions: new FakeSessions(),
    network: () => ({
      ...net,
      machines: { ...net.machines, [SRC]: { id: SRC, name: 'laptop' } },
    }),
    profiles: knownProfiles,
  }).accept(p, SRC), /no pinned signing key/);
  // Nothing was written for any of that.
  assert.equal(existsSync(join(helmDir, 'handoffs.json')), false);
});

test('accepting a handoff materializes, starts and prompts - once', async () => {
  const sessions = new FakeSessions();
  const h = new Handoffs({ sessions, network: () => net, profiles: knownProfiles });
  const p = request();
  const r = await h.accept(p, SRC);

  assert.equal(r.status, 'running');
  assert.equal(r.sessionId, 'sess-1');
  assert.equal(r.sourceMachineId, SRC);
  assert.equal(r.folder, p.folder);
  assert.equal(r.digest, p.digest);
  assert.equal(r.files, 1);
  assert.equal(r.skipped, 1);
  assert.equal(readFileSync(join(p.folder, 'a.txt'), 'utf8'), 'code');
  assert.equal(existsSync(join(p.folder, '.env')), false);

  assert.equal(sessions.starts.length, 1);
  assert.equal(sessions.starts[0].cwd, p.folder);
  assert.equal(sessions.starts[0].profileId, 'claudea');
  assert.equal(sessions.starts[0].parent.handoffId, p.handoffId);
  assert.equal(sessions.inputs.length, 1);
  assert.equal(sessions.inputs[0].id, 'sess-1');
  assert.equal(sessions.inputs[0].text, p.prompt);
  assert.equal(sessions.inputs[0].turnId, `handoff-${p.handoffId}-1`);
  assert.equal(r.promptAttempt, 1);

  // A retry - the source repeating the same handoff id - returns the same
  // receipt and does none of the work again.
  const again = await h.accept(p, SRC);
  assert.equal(again.status, 'running');
  assert.equal(again.sessionId, r.sessionId);
  assert.equal(again.folder, r.folder);
  assert.equal(sessions.starts.length, 1);
  assert.equal(sessions.inputs.length, 1, 'the prompt is delivered once');

  // A fresh Handoffs over the same store - the daemon-restart case - sees
  // the same record and still does not redo the work.
  const revived = new Handoffs({ sessions, network: () => net, profiles: knownProfiles });
  const third = await revived.accept(p, SRC);
  assert.equal(third.sessionId, r.sessionId);
  assert.equal(sessions.starts.length, 1);
  assert.equal(sessions.inputs.length, 1);

  // And the machine that sourced it can read it back.
  const status = revived.status(p.handoffId, SRC);
  assert.equal(status.status, 'running');
  assert.throws(() => revived.status(p.handoffId, 'dev1'), /machines? of this network/);
  assert.throws(() => revived.status(p.handoffId, net.self), /unknown handoff/);
});

test('a failure after the session starts persists; a retry resumes, not restarts', async () => {
  const sessions = new FakeSessions();
  const h = new Handoffs({ sessions, network: () => net, profiles: knownProfiles });
  const p = request();

  sessions.failNextInput = true;
  await assert.rejects(() => h.accept(p, SRC), /refused the send/);

  // The failed record holds what already happened.
  const record = JSON.parse(readFileSync(join(helmDir, 'handoffs.json'), 'utf8'))
    .handoffs[p.handoffId];
  assert.equal(record.status, 'failed');
  assert.equal(record.sessionId, 'sess-1');
  assert.equal(record.folder, p.folder);
  assert.equal(record.error, 'driver refused the send');
  assert.equal(record.promptAttempt, 1);

  // The send failed, so the turn id on the wire already failed. A retry
  // must not answer 'running' on the strength of that logged failure -
  // it walks to the next deterministic id and this send fails too.
  sessions.failNextInput = true;
  await assert.rejects(() => h.accept(p, SRC), /refused the send/);
  assert.equal(sessions.inputs.length, 0, 'nothing reached the agent');
  assert.equal(sessions.attempts.map((a) => a.turnId).join(','),
    `handoff-${p.handoffId}-1,handoff-${p.handoffId}-2`);
  assert.equal(h.status(p.handoffId, SRC).status, 'failed');
  assert.equal(h.status(p.handoffId, SRC).promptAttempt, 2);

  // Third time is the charm: both dead ids are stepped over, the prompt
  // goes out under the third, and only now is the receipt 'running'.
  const r = await h.accept(p, SRC);
  assert.equal(r.status, 'running');
  assert.equal(r.sessionId, 'sess-1');
  assert.equal(r.error, null);
  assert.equal(r.promptAttempt, 3);
  assert.equal(sessions.starts.length, 1);
  assert.equal(sessions.inputs.length, 1);
  assert.equal(sessions.inputs[0].turnId, `handoff-${p.handoffId}-3`);
});

test('a repeated id carrying a different request is not a retry', async () => {
  const sessions = new FakeSessions();
  const h = new Handoffs({ sessions, network: () => net, profiles: knownProfiles });
  const p = request();
  assert.equal((await h.accept(p, SRC)).status, 'running');
  const done = sessions.inputs.length + sessions.starts.length;

  // Same handoff id, something different inside the request - each
  // honestly rebound so it passes content validation and meets the
  // record-level check. An id is claimed by the operation that first
  // used it; these are rejected before a byte of work happens.
  for (const variant of [
    rebind({ ...p, prompt: 'a different instruction' }),
    rebind({ ...p, profileId: 'codexa' }),
    rebind({ ...p, mode: 'plan' }),
    rebind({ ...p, title: 'a different title' }),
    rebind({ ...p, folder: `${p.folder}-other` }),
    // A consistently claimed but different snapshot is still a different
    // operation under a used id.
    rebind({ ...p, snapshotDigest: '0'.repeat(64), parent: { ...p.parent, digest: '0'.repeat(64) } }),
    rebind({ ...p, parent: { ...p.parent, sessionId: 'othersession' } }),
  ]) {
    await assert.rejects(() => h.accept(variant, SRC), /does not match its original request/);
  }
  assert.equal(sessions.starts.length + sessions.inputs.length, done,
    'a mismatched retry has no side effects');
  assert.equal(h.status(p.handoffId, SRC).status, 'running', 'the record is untouched');
});

test('a real retry reseals the same snapshot and resumes', async () => {
  const sessions = new FakeSessions();
  const h = new Handoffs({ sessions, network: () => net, profiles: knownProfiles });
  const p = request();
  assert.equal((await h.accept(p, SRC)).status, 'running');

  // Sealing is randomized - a retried `helm handoff --handoff-id` makes a
  // new envelope over the same code. The request binds the plaintext
  // digest, so this is still the same operation: the fresh envelope is
  // ignored and none of the work repeats.
  const snapshot = CT.createCodeSnapshot(sourceDir);
  const reseal = CT.sealCodeSnapshot(snapshot, CT.codeKeyInfo().codePubkey, p.handoffId);
  assert.notEqual(JSON.stringify(reseal), JSON.stringify(p.envelope),
    'the resealed envelope is different ciphertext');
  const again = await h.accept({ ...p, envelope: reseal }, SRC);
  assert.equal(again.status, 'running');
  assert.equal(again.sessionId, 'sess-1');
  assert.equal(sessions.starts.length, 1);
  assert.equal(sessions.inputs.length, 1);
});

test('a falsely claimed snapshot digest fails before any session starts', async () => {
  const sessions = new FakeSessions();
  const h = new Handoffs({ sessions, network: () => net, profiles: knownProfiles });
  const p = request();
  // The envelope carries real code; the digest claim lies about it. What
  // the decrypted tree actually hashes to is what decides.
  const claimed = rebind({ ...p, snapshotDigest: '0'.repeat(64), parent: undefined });
  await assert.rejects(() => h.accept(claimed, SRC), /snapshot digest does not match/);
  assert.equal(sessions.starts.length, 0, 'no session starts for a bad snapshot');
  const record = JSON.parse(readFileSync(join(helmDir, 'handoffs.json'), 'utf8'))
    .handoffs[p.handoffId];
  assert.equal(record.status, 'failed');
  assert.equal(record.folder, null, 'the materialized folder is not claimed by the record');
});

test('a different snapshot inside a validly sealed envelope fails before any write', async () => {
  const sessions = new FakeSessions();
  const h = new Handoffs({ sessions, network: () => net, profiles: knownProfiles });
  const p = request();

  const otherDir = join(handoffsDir, 'other-source');
  mkdirSync(otherDir, { recursive: true });
  writeFileSync(join(otherDir, 'b.txt'), 'different code');
  const otherSnapshot = CT.createCodeSnapshot(otherDir);
  assert.notEqual(otherSnapshot.digest, p.snapshotDigest);
  const sneaky = {
    ...p,
    envelope: CT.sealCodeSnapshot(otherSnapshot, CT.codeKeyInfo().codePubkey, p.handoffId),
  };

  await assert.rejects(() => h.accept(sneaky, SRC), /digest/);
  assert.equal(sessions.starts.length, 0, 'no session was started');
  assert.equal(existsSync(p.folder), false, 'no destination was created');
  assert.equal(existsSync(`${p.folder}.helm-stage-${p.handoffId}`), false, 'no stage either');
  const record = JSON.parse(readFileSync(join(helmDir, 'handoffs.json'), 'utf8'))
    .handoffs[p.handoffId];
  assert.equal(record.status, 'failed');
  assert.equal(record.folder, null);
});

test('a session orphaned by a crashed accept is adopted, not duplicated', async () => {
  const sessions = new FakeSessions();
  const h = new Handoffs({ sessions, network: () => net, profiles: knownProfiles });
  const p = request();
  delete p.parent;
  rebind(p);
  await h.accept(p, SRC);
  assert.equal(sessions.starts.length, 1);
  assert.equal(sessions.starts[0].originHandoffId, p.handoffId);

  // The crash window: sessions.start wrote the session, the daemon died
  // before the receipt recorded it. Doctor the store into that state -
  // materialized, but with no sessionId.
  const file = join(helmDir, 'handoffs.json');
  const store = JSON.parse(readFileSync(file, 'utf8'));
  store.handoffs[p.handoffId].sessionId = null;
  store.handoffs[p.handoffId].status = 'materialized';
  writeFileSync(file, JSON.stringify(store));

  const revived = new Handoffs({ sessions, network: () => net, profiles: knownProfiles });
  const r = await revived.accept(p, SRC);
  assert.equal(r.status, 'running');
  assert.equal(r.sessionId, 'sess-1', 'the existing session is adopted by its handoff id');
  assert.equal(sessions.starts.length, 1, 'no twin session is started');
  assert.equal(sessions.inputs.length, 1, 'the prompt is not re-sent');
});

test('a corrupt handoffs file reads as an empty store and is left alone', async () => {
  const file = join(helmDir, 'handoffs.json');
  writeFileSync(file, 'this is not json {');
  const h = new Handoffs({ sessions: new FakeSessions(), network: () => net, profiles: knownProfiles });
  assert.throws(() => h.status('ab'.repeat(12), SRC), /unknown handoff/);
  assert.ok(existsSync(file));
  assert.equal(readFileSync(file, 'utf8'), 'this is not json {');
});

test('two simultaneous accepts of the same request join into one', async () => {
  const sessions = new FakeSessions();
  sessions.startDelay = 50; // long enough for the second accept to arrive mid-flight
  const h = new Handoffs({ sessions, network: () => net, profiles: knownProfiles });
  const p = request();

  // Every hub may deliver the same queued job; the accepts overlap.
  const [a, b] = await Promise.all([h.accept(p, SRC), h.accept(p, SRC)]);
  assert.equal(a.status, 'running');
  assert.equal(b.sessionId, a.sessionId);
  assert.equal(sessions.starts.length, 1, 'the session starts once');
  assert.equal(sessions.inputs.length, 1, 'the prompt is delivered once');
  assert.equal(existsSync(join(p.folder, 'a.txt')), true);

  // A concurrent caller carrying a *different* request under the same id is
  // refused, never folded into the accept already running.
  const p2 = request();
  const [kept, refused] = await Promise.allSettled([
    h.accept(p2, SRC),
    h.accept(rebind({ ...p2, prompt: 'a different instruction' }), SRC),
  ]);
  assert.equal(kept.status, 'fulfilled');
  assert.equal(refused.status, 'rejected');
  assert.match(refused.reason.message, /does not match its original request/);
  assert.equal(sessions.starts.length, 2, 'only the first request ran');
});

test('a request with no mode runs the engine default, never a saved preference', async () => {
  const sessions = new FakeSessions();
  // The profile's remembered startPrefs ask for the dangerous mode; a
  // queued job must not silently inherit it.
  const profiles = async () => [{
    id: 'claudea', engine: 'claude', startPrefs: { mode: 'bypassPermissions' },
  }];
  const h = new Handoffs({ sessions, network: () => net, profiles });
  const p = request();
  const { mode, requestDigest, ...rest } = p;
  const r = await h.accept(rebind(rest), SRC);
  assert.equal(r.status, 'running');
  assert.equal(sessions.starts.length, 1);
  assert.equal(sessions.starts[0].mode, 'default', "claude's safe default, not the saved yolo");
  assert.equal(r.mode, 'default', 'the effective mode lands on the receipt');
});

test('an unknown profile fails the accept, then the same id retries once it exists', async () => {
  const sessions = new FakeSessions();
  // The profile list starts empty, as on a machine still installing CLIs.
  let available = [];
  const h = new Handoffs({
    sessions, network: () => net, profiles: async () => available,
  });
  const p = request();
  await assert.rejects(() => h.accept(p, SRC), /no agent profile claudea/);
  assert.equal(sessions.starts.length, 0, 'no session starts for a missing profile');
  const record = JSON.parse(readFileSync(join(helmDir, 'handoffs.json'), 'utf8'))
    .handoffs[p.handoffId];
  assert.equal(record.status, 'failed');
  assert.equal(record.folder, p.folder, 'materialization completed and stays');

  // The profile appears; the identical request under the same id resumes
  // rather than being permanently wedged.
  available = [{ id: 'claudea', engine: 'claude' }];
  const r = await h.accept(p, SRC);
  assert.equal(r.status, 'running');
  assert.equal(sessions.starts.length, 1);
  assert.equal(sessions.starts[0].cwd, p.folder);
});

test('a worktree snapshot restores its provenance before the session starts', async () => {
  // A real little repo is the source, so the snapshot carries git
  // metadata and the target folder gets a repository, not just files.
  const { execFileSync } = await import('node:child_process');
  const repo = join(work, 'git-source');
  mkdirSync(repo, { recursive: true });
  const git = (args) => execFileSync('git', ['-C', repo, ...args], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'test']);
  writeFileSync(join(repo, 'a.txt'), 'versioned code');
  git(['add', 'a.txt']);
  git(['commit', '-m', 'init']);

  const sessions = new FakeSessions();
  const h = new Handoffs({ sessions, network: () => net, profiles: knownProfiles });
  const p = request(repo);
  const r = await h.accept(p, SRC);
  assert.equal(r.status, 'running');
  assert.equal(r.git.commit.length, 40);
  assert.equal(r.gitRestore.restored, true);
  assert.equal(r.gitRestore.fetched, false, 'no remote, so no fabricated history');
  assert.equal(existsSync(join(r.folder, '.git')), true);
  assert.equal(sessions.starts.length, 1);

  // A retry does not restore twice.
  const again = await h.accept(p, SRC);
  assert.equal(again.gitRestoredAt, r.gitRestoredAt);
});
