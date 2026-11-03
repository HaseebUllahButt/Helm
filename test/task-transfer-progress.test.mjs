import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
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

test('a failed progress read cannot escape the task copy timer', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const folder = join(root, 'source'); mkdirSync(folder);
  let finish, reads = 0;
  const transfer = new TaskTransfers({
    network: () => ({ self: 'aa11', machines: { aa11: { id: 'aa11' }, bb22: { id: 'bb22', codePubkey: 'test' } }, revoked: {} }),
    sessions: {}, directory: join(root, 'outgoing'),
    rpc: async () => ({ agents: [{ id: 'test', engine: 'codex', available: true }] }),
    sendEngine: {
      start: () => ({ job: { id: 'copy' } }),
      status: () => { reads++; throw new Error('machine was removed'); },
      wait: () => new Promise(resolve => { finish = resolve; }),
    },
  });
  const id = 'a'.repeat(24);
  const result = await transfer.send({ handoffId: id, folder, targetMachineId: 'bb22', profileId: 'test',
    prompt: 'test', returnToSource: false }, 'aa11');
  assert.equal(result.status, 'copying');
  assert.doesNotThrow(() => t.mock.timers.tick(250));
  t.mock.timers.tick(250);
  assert.equal(reads, 1, 'a failed progress watcher stops');
  finish({ phase: 'failed', error: 'copy failed' });
  await new Promise(setImmediate);
  assert.match(transfer.copying.get(id).error.message, /copy failed/);
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

test('a failed background copy is told to the next poll, then forgotten', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let finish;
  const transfer = new TaskTransfers({
    network: () => ({ self: 'aa11', machines: { aa11: { id: 'aa11' }, bb22: { id: 'bb22', codePubkey: 'test' } }, revoked: {} }),
    sessions: {}, directory: join(root, 'forget-failed'),
    rpc: async () => ({ agents: [{ id: 'test', engine: 'codex', available: true }] }),
    sendEngine: { start: () => ({ job: { id: 'copy' } }), status: () => { throw new Error('gone'); },
      wait: () => new Promise(resolve => { finish = resolve; }) },
  });
  const id = 'c'.repeat(24);
  await transfer.send({ handoffId: id, folder: root, targetMachineId: 'bb22', profileId: 'test', prompt: 'test', returnToSource: false }, 'aa11');
  finish({ phase: 'failed', error: 'connection lost' });
  await new Promise(setImmediate);
  assert.match(transfer.copying.get(id).error.message, /connection lost/);
  t.mock.timers.tick(transfer.failedKeepMs - 1);
  assert.ok(transfer.copying.has(id), 'a poll inside the window still sees the failure');
  t.mock.timers.tick(1);
  assert.equal(transfer.copying.has(id), false);
});
