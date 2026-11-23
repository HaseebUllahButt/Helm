import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'helm-task-progress-'));
process.env.HELM_DIR = join(root, 'state');
const { TaskTransfers } = await import('../packages/connect/src/task-transfer.js');
const { codeKeyInfo } = await import('../packages/connect/src/code-transfer.js');
test.after(() => rmSync(root, { recursive: true, force: true }));

test('restart resumes a saved task copy without a browser polling it', async () => {
  const directory = join(root, 'restart-copy');
  let finish, starts = 0, accepts = 0;
  let accepted;
  const delivered = new Promise(resolve => { accepted = resolve; });
  const network = () => ({ self: 'aa11', machines: { aa11: { id: 'aa11' }, bb22: { id: 'bb22', codePubkey: codeKeyInfo().codePubkey } }, revoked: {} });
  const options = { network, sessions: {}, directory,
    rpc: async (_id, method) => {
      if (method === 'agent.list') return { agents: [{ id: 'test', engine: 'codex', available: true }] };
      assert.equal(method, 'handoff.accept'); accepts++; accepted();
      return { sessionId: 'destination', folder: '/private-target' };
    },
    sendEngine: { start: () => { starts++; return { job: { id: 'saved-copy' } }; },
      wait: () => new Promise(resolve => { finish = resolve; }) },
  };
  const id = 'd'.repeat(24);
  const first = new TaskTransfers(options);
  await first.send({ handoffId: id, folder: root, targetMachineId: 'bb22', profileId: 'test', prompt: 'test', returnToSource: false }, 'aa11');
  first.stop(); finish({ phase: 'interrupted', error: 'Helm stopped.' });
  await new Promise(setImmediate);
  options.sendEngine.status = () => ({ job: { phase: 'done' } });
  options.sendEngine.wait = async () => ({ phase: 'done', target: { path: '/private-target' }, files: { total: 1 }, bytes: { total: 1 } });
  const restarted = new TaskTransfers(options);
  await restarted.reconcile();
  // The saved copy continues in the background. Join its actual completion.
  await delivered;
  await new Promise(setImmediate);
  assert.equal(starts, 1, 'restart keeps the saved copy job');
  assert.equal(accepts, 1);
});

test('automatic copy recovery waits while the owner works in the source chat', async () => {
  const directory = join(root, 'working-source');
  const source = { id: 'source', cwd: root, engine: 'codex', status: 'working' };
  let finish, pauses = 0, accepts = 0, accepted;
  const delivered = new Promise(resolve => { accepted = resolve; });
  const sessions = { get: () => source, history: () => ({ events: [] }),
    interrupt: async () => { pauses++; source.status = 'idle'; },
    setTaskTransfer: (_id, value) => { source.taskTransfer = value; } };
  const options = { directory, sessions,
    network: () => ({ self: 'aa11', machines: { aa11: { id: 'aa11' }, bb22: { id: 'bb22', name: 'Target', codePubkey: codeKeyInfo().codePubkey } }, revoked: {} }),
    rpc: async (_id, method) => {
      if (method === 'agent.list') return { agents: [{ id: 'test', engine: 'codex', available: true }] };
      assert.equal(method, 'handoff.accept'); accepts++; accepted();
      return { sessionId: 'destination', folder: '/private-target' };
    },
    sendEngine: { start: () => ({ job: { id: 'saved-copy' } }), wait: () => new Promise(resolve => { finish = resolve; }) },
  };
  const id = 'e'.repeat(24), first = new TaskTransfers(options);
  await first.send({ handoffId: id, folder: root, sessionId: 'source', targetMachineId: 'bb22', profileId: 'test', prompt: 'test', returnToSource: false }, 'aa11');
  first.stop(); finish({ phase: 'interrupted', error: 'Helm stopped.' });
  await new Promise(setImmediate);
  assert.equal(pauses, 1);
  source.status = 'working';
  const restarted = new TaskTransfers(options);
  await restarted.reconcile();
  await restarted.reconcile();
  assert.equal(pauses, 1, 'recovery cannot interrupt a new owner turn');
  assert.equal(accepts, 0);
  assert.equal(source.taskTransfer.status, 'waiting-to-send');
  source.status = 'idle';
  options.sendEngine.status = () => ({ job: { phase: 'done' } });
  options.sendEngine.wait = async () => ({ phase: 'done', target: { path: '/private-target' }, files: { total: 1 }, bytes: { total: 1 } });
  await restarted.reconcile(); await delivered; await new Promise(setImmediate);
  assert.equal(accepts, 1);
  assert.equal(source.taskTransfer, null, 'a task with no return clears its temporary source notice');
});

test('saving a failed background copy cannot cause an unhandled rejection', async t => {
  const directory = join(root, 'failed-state');
  let finish;
  const errors = [];
  t.mock.method(console, 'error', message => errors.push(message));
  const transfer = new TaskTransfers({
    network: () => ({ self: 'aa11', machines: { aa11: { id: 'aa11' }, bb22: { id: 'bb22', codePubkey: 'test' } }, revoked: {} }),
    sessions: {}, directory,
    rpc: async () => ({ agents: [{ id: 'test', engine: 'codex', available: true }] }),
    sendEngine: {
      start: () => ({ job: { id: 'copy' } }),
      status: () => { throw new Error('copy stopped'); },
      wait: () => new Promise(resolve => { finish = resolve; }),
    },
  });
  const id = 'b'.repeat(24);
  await transfer.send({ handoffId: id, folder: root, targetMachineId: 'bb22', profileId: 'test',
    prompt: 'test', returnToSource: false }, 'aa11');
  rmSync(directory, { recursive: true }); writeFileSync(directory, 'cannot save here');
  finish({ phase: 'failed', error: 'connection lost' });
  await new Promise(setImmediate);
  assert.match(transfer.copying.get(id).error.message, /connection lost/);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Could not save task transfer status/);
});
