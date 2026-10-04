import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = mkdtempSync(join(process.cwd(), '.helm-task-send-state-'));
process.env.HELM_DIR = root;
const work = join(process.cwd(), `.helm-task-send-${process.pid}`);
mkdirSync(work, { recursive: true });
test.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });

const { TaskTransfers } = await import('../packages/connect/src/task-transfer.js');
const { Handoffs } = await import('../packages/connect/src/handoffs.js');
const { codeKeyInfo, codeSigningInfo } = await import('../packages/connect/src/code-transfer.js');
const { M } = await import('@helm/protocol');
const sourceId = 'aa11';
const targetId = 'bb22';
const net = {
  self: sourceId, revoked: {}, devices: { phone: {} },
  machines: {
    [sourceId]: { id: sourceId, name: 'Laptop', ...codeSigningInfo(), codePubkey: codeKeyInfo().codePubkey },
    [targetId]: { id: targetId, name: 'VM', ...codeSigningInfo(), codePubkey: codeKeyInfo().codePubkey },
  },
};
let sequence = 0;
test('unchanged files stay out of the encrypted return delta and project Git history stays untouched', async () => {
  const { options, params, destination, handoffs } = fixture();
  writeFileSync(join(params.folder, 'unchanged.bin'), randomBytes(128 * 1024));
  const sender = new TaskTransfers(options);
  await sender.send(params, 'phone');
  writeFileSync(join(params.targetFolder, 'app.js'), 'small edit');
  destination.status = 'done';
  const returned = await handoffs.collect(params.handoffId, sourceId);
  assert.ok(returned.envelope.data.length < 2000, 'only changed files travel back');
  assert.match(returned.baseCommit, /^[a-f0-9]{40}$/);
  assert.match(returned.commit, /^[a-f0-9]{40}$/);
  assert.equal(existsSync(join(params.folder, '.git')), false);
  assert.equal(existsSync(join(params.targetFolder, '.git')), false);
  await sender.collect(params.handoffId);
  assert.equal(readFileSync(join(params.folder, 'unchanged.bin')).length, 128 * 1024);
});
test('completed tasks return changed files and deletions automatically, preserving unrelated local edits', async () => {
  const { options, params, destination, returns } = fixture();
  const sender = new TaskTransfers(options);
  await sender.send(params, 'phone');
  writeFileSync(join(params.targetFolder, 'app.js'), 'remote implementation');
  unlinkSync(join(params.targetFolder, 'package.json'));
  writeFileSync(join(params.targetFolder, '.env'), 'TOKEN=returned-secret');
  writeFileSync(join(params.folder, 'local.txt'), 'keep local');
  await sender.reconcile();
  assert.equal(sender.status(params, 'phone').return.status, 'waiting');
  destination.status = 'done';
  await sender.collect(params.handoffId);
  await sender.reconcile();
  assert.equal(sender.status(params, 'phone').return.status, 'returned');
  assert.equal(readFileSync(join(params.folder, 'app.js'), 'utf8'), 'remote implementation');
  assert.equal(readFileSync(join(params.folder, '.env'), 'utf8'), 'TOKEN=returned-secret');
  assert.equal(statSync(join(params.folder, '.env')).mode & 0o777, 0o600);
  assert.equal(existsSync(join(params.folder, 'package.json')), false);
  assert.equal(readFileSync(join(params.folder, 'local.txt'), 'utf8'), 'keep local');
  assert.equal(destination.taskTransfer.status, 'returned');
  assert.equal(returns.length, 1);
  await new TaskTransfers(options).reconcile();
  assert.equal(returns.length, 1);
});

test('conflicting edits stay intact until explicitly resolved; persisted returns survive disconnects', async () => {
  const { options, params, destination } = fixture();
  const sender = new TaskTransfers(options);
  await sender.send(params, 'phone');
  writeFileSync(join(params.targetFolder, 'app.js'), 'remote change');
  writeFileSync(join(params.targetFolder, 'new.js'), 'remote new file');
  writeFileSync(join(params.folder, 'app.js'), 'my local change');
  destination.status = 'done';
  await sender.reconcile();
  const status = sender.status(params, 'phone').return;
  assert.equal(status.status, 'conflict');
  assert.deepEqual(status.conflicts, ['app.js']);
  assert.equal(readFileSync(join(params.folder, 'app.js'), 'utf8'), 'my local change');
  assert.equal(existsSync(join(params.folder, 'new.js')), false);
  assert.equal(readFileSync(join(status.folder, 'app.js'), 'utf8'), 'remote change');
  await assert.rejects(() => sender.retryReturn({ ...params, keepLocal: ['new.js'] }, 'phone'), /only reported conflicts/);
  const rpc = options.rpc;
  options.rpc = (...args) => {
    assert.notEqual(args[1], M.TASK_COLLECT);
    return rpc(...args);
  };
  const restarted = new TaskTransfers(options);
  await restarted.retryReturn({ handoffId: params.handoffId, keepLocal: ['app.js'] }, 'phone');
  assert.equal(restarted.status(params, 'phone').return.status, 'returned');
  assert.equal(readFileSync(join(params.folder, 'app.js'), 'utf8'), 'my local change');
  assert.equal(readFileSync(join(params.folder, 'new.js'), 'utf8'), 'remote new file');
});

test('failed or blocked remote turns and working original threads cannot trigger a return', async () => {
  const { options, params, destination, completed, source } = fixture();
  const sender = new TaskTransfers(options);
  await sender.send(params, 'phone');
  destination.status = 'done';
  completed.events[0].status = 'error';
  await sender.reconcile();
  assert.equal(sender.status(params, 'phone').return.status, 'waiting');
  completed.events[0].status = 'ok';
  completed.pending = [{ requestId: 'permission' }];
  await sender.reconcile();
  assert.equal(sender.status(params, 'phone').return.status, 'waiting');
  completed.pending = [];
  source.status = 'working';
  await sender.reconcile();
  assert.equal(sender.status(params, 'phone').return.status, 'waiting');
  source.status = 'idle';
  await sender.collect(params.handoffId);
  await sender.reconcile();
  assert.equal(sender.status(params, 'phone').return.status, 'returned');
});

test('returns authenticate the peer and reject modified signatures before touching local files', async () => {
  const { options, params, destination, handoffs } = fixture();
  const sender = new TaskTransfers(options);
  await sender.send(params, 'phone');
  destination.status = 'done';
  await assert.rejects(() => handoffs.collect(params.handoffId, 'phone'), /unknown handoff|machine/);
  const rpc = options.rpc;
  options.rpc = async (...args) => {
    const reply = await rpc(...args);
    return args[1] === M.TASK_COLLECT ? { ...reply, snapshotDigest: 'tampered' } : reply;
  };
  const changedSender = new TaskTransfers(options);
  await assert.rejects(() => changedSender.collect(params.handoffId), /did not verify/);
  assert.equal(readFileSync(join(params.folder, 'app.js'), 'utf8'), 'finished-before-pause');
});
function fixture() {
  const handoffId = (++sequence).toString(16).padStart(24, '0');
  const folder = join(work, `source-${sequence}`);
  mkdirSync(folder);
  writeFileSync(join(folder, 'app.js'), 'unfinished');
  writeFileSync(join(folder, '.env'), 'TOKEN=project-secret');
  writeFileSync(join(folder, 'package.json'), '{"dependencies":{}}');
  const source = { id: 'thread', cwd: folder, title: 'Continue build', engine: 'codex', mode: 'readonly', status: 'working' };
  const starts = [], inputs = [], links = [], accepted = [];
  const destination = { id: `destination-${sequence}`, status: 'working' };
  const completed = { events: [{ type: 'turn.done', turnId: 'remote-turn', status: 'ok' }], pending: [] };
  const returns = [];
  let pauses = 0;
  const sessions = {
    get: () => source,
    interrupt: async () => {
      pauses++;
      source.status = 'done';
      writeFileSync(join(folder, 'app.js'), 'finished-before-pause');
    },
    history: () => ({ events: [{ type: 'turn.start', turnId: 'turn', text: 'Finish the feature; preserve contract XYZ' }] }),
    linkChild: (...args) => links.push(args),
    receiveTaskReturn: (_id, data) => { source.taskTransfer = data; returns.push(data); },
    setTaskTransfer: (_id, data) => { source.taskTransfer = data; },
  };
  const handoffs = new Handoffs({
    network: () => ({ ...net, self: targetId }), file: join(root, `receipts-${sequence}.json`),
    profiles: async () => [{ id: 'codex', engine: 'codex' }],
    sessions: {
      start: async (params) => { starts.push(params); return { id: `destination-${sequence}` }; },
      input: async (...args) => { inputs.push(args); },
      get: () => destination,
      history: () => completed,
      setTaskTransfer: (_id, data) => { destination.taskTransfer = data; },
    },
  });
  const rpc = async (target, method, params, options) => {
    assert.equal(target, targetId);
    if (method === M.AGENT_LIST) return { agents: [{ id: 'codex', engine: 'codex', available: true, defaultMode: 'full' }] };
    if (method === M.TASK_COLLECT) return handoffs.collect(params.handoffId, sourceId);
    if (method === M.TASK_RETURNED) return handoffs.returned(params, sourceId);
    assert.equal(method, M.HANDOFF_ACCEPT);
    accepted.push(params);
    options.onRoute('direct');
    return handoffs.accept(params, sourceId);
  };
  const options = { network: () => net, sessions, rpc, enqueue: async () => {}, directory: join(root, `outgoing-${sequence}`) };
  const params = { handoffId, folder, targetFolder: join(work, `target-${sequence}`),
    targetMachineId: targetId, sessionId: source.id, profileId: 'codex', includeEnv: true };
  return { options, params, source, starts, inputs, links, accepted, destination, completed, handoffs, returns, pauses: () => pauses };
}

test('a continued task pauses before copying, carries env and encrypted context, and preserves read-only mode', async () => {
  const fixtureData = fixture();
  const { options, params, starts, inputs, links, accepted } = fixtureData;
  const sender = new TaskTransfers(options);
  const result = await sender.send(params, 'phone');
  assert.equal(result.status, 'running');
  assert.equal(result.route, 'direct');
  assert.equal(fixtureData.pauses(), 1);
  assert.equal(readFileSync(join(result.receipt.folder, 'app.js'), 'utf8'), 'finished-before-pause');
  assert.equal(readFileSync(join(result.receipt.folder, '.env'), 'utf8'), 'TOKEN=project-secret');
  assert.equal(statSync(join(result.receipt.folder, '.env')).mode & 0o777, 0o600);
  assert.equal(starts[0].mode, 'readonly');
  assert.equal(accepted[0].restoreGit, false);
  assert.match(inputs[0][1], /preserve contract XYZ/);
  assert.match(inputs[0][1], /recreate the required dependencies/);
  assert.doesNotMatch(JSON.stringify(accepted[0]), /preserve contract XYZ|project-secret/);
  assert.equal(links.length, 1);
  writeFileSync(join(params.folder, 'app.js'), 'later-local-change');
  assert.deepEqual(await new TaskTransfers(options).send(params, 'phone'), result);
  assert.equal(starts.length, 1);
  assert.equal(inputs.length, 1);
  await assert.rejects(() => sender.send({ ...params, prompt: 'different task' }, 'phone'), /does not match/);
});

test('omitted secrets need acknowledgement before the source is paused', async () => {
  const fixtureData = fixture();
  const { options, params } = fixtureData;
  const result = await new TaskTransfers(options).send({ ...params, includeEnv: false }, 'phone');
  assert.equal(result.sent, false);
  assert.equal(result.requiresAcknowledgement, true);
  assert.equal(fixtureData.pauses(), 0);
  assert.equal(existsSync(params.targetFolder), false);
});

test('transport failure queues the frozen encrypted request and retry reuses it after source changes', async () => {
  const { options, params, accepted } = fixture();
  const baseRpc = options.rpc;
  let offline = true;
  let queued;
  options.rpc = async (...args) => {
    if (args[1] === M.HANDOFF_ACCEPT && offline) throw new Error('socket closed');
    return baseRpc(...args);
  };
  options.enqueue = async (_target, request) => { queued = request; };
  const sender = new TaskTransfers(options);
  assert.equal((await sender.send(params, 'phone')).status, 'queued');
  assert.ok(queued.promptEnvelope);
  writeFileSync(join(params.folder, 'app.js'), 'changed-after-queue');
  offline = false;
  const result = await new TaskTransfers(options).send(params, 'phone');
  assert.equal(JSON.stringify(accepted[0]), JSON.stringify(queued));
  assert.equal(readFileSync(join(result.receipt.folder, 'app.js'), 'utf8'), 'finished-before-pause');
});

test('peer callers, unavailable accounts and target execution failures never become successful sends', async () => {
  const { options, params } = fixture();
  const sender = new TaskTransfers(options);
  await assert.rejects(() => sender.send(params, targetId), /paired device/);
  await assert.rejects(() => sender.send({ ...params, profileId: 'missing' }, 'phone'), /unavailable/);
  let queued = false;
  const baseRpc = options.rpc;
  options.rpc = async (...args) => {
    if (args[1] === M.HANDOFF_ACCEPT) throw new Error('profile login failed');
    return baseRpc(...args);
  };
  options.enqueue = async () => { queued = true; };
  await assert.rejects(() => new TaskTransfers(options).send(params, 'phone'), /profile login failed/);
  assert.equal(queued, false);
});

test('a new task starts without interrupting or linking a source thread', async () => {
  const fixtureData = fixture();
  const { options, params, starts, inputs, links } = fixtureData;
  const result = await new TaskTransfers(options).send({ ...params, sessionId: undefined, prompt: 'Build a dashboard' }, sourceId);
  assert.equal(result.status, 'running');
  assert.equal(fixtureData.pauses(), 0);
  assert.equal(starts[0].mode, 'full');
  assert.equal(links.length, 0);
  assert.match(inputs[0][1], /Build a dashboard/);
});

test('concurrent retries share one destination session', async () => {
  const { options, params, starts, inputs } = fixture();
  const sender = new TaskTransfers(options);
  const results = await Promise.all([sender.send(params, 'phone'), sender.send(params, 'phone')]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(starts.length, 1);
  assert.equal(inputs.length, 1);
});

test('the snapshot waits for the interrupted source to settle', async () => {
  const { options, params, source } = fixture();
  options.sessions.interrupt = async () => {
    setTimeout(() => {
      writeFileSync(join(params.folder, 'app.js'), 'last-write-before-stopping');
      source.status = 'done';
    }, 30);
  };
  const result = await new TaskTransfers(options).send(params, 'phone');
  assert.equal(readFileSync(join(result.receipt.folder, 'app.js'), 'utf8'), 'last-write-before-stopping');
});

test('a task from a Git project starts from files without restoring or fetching Git history', async () => {
  const { options, params } = fixture();
  execFileSync('git', ['init', '-q', params.folder]);
  execFileSync('git', ['-C', params.folder, 'add', 'app.js']);
  execFileSync('git', ['-C', params.folder, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial']);
  execFileSync('git', ['-C', params.folder, 'remote', 'add', 'origin', 'https://example.invalid/never-fetch.git']);
  const result = await new TaskTransfers(options).send(params, 'phone');
  assert.equal(result.status, 'running');
  assert.equal(existsSync(join(result.receipt.folder, '.git')), false);
  assert.ok(existsSync(join(result.receipt.folder, 'app.js')));
});
