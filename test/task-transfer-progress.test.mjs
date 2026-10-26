import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'helm-task-progress-'));
process.env.HELM_DIR = join(root, 'state');
const { TaskTransfers } = await import('../packages/connect/src/task-transfer.js');
test.after(() => rmSync(root, { recursive: true, force: true }));

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
