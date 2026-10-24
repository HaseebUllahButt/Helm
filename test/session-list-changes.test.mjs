import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A device that holds a chat list names its digest and gets only the chats
// that changed, so a phone does not download the whole list again each time
// one chat starts or ends.
const root = mkdtempSync(join(tmpdir(), 'helm-session-list-'));
process.env.HELM_DIR = join(root, 'helm');
process.env.HELM_NO_SERVICE = '1';
delete process.env.INVOCATION_ID;
test.after(() => rmSync(root, { recursive: true, force: true }));

const { Daemon } = await import('../packages/connect/src/agent.js');
const { M } = await import('@helm/protocol');
const N = await import('@helm/protocol/network');
N.forgetNetwork();
N.createNetwork({ name: 'listbox', port: 8998 });
const d = new Daemon({ name: 'listbox', port: 8998, advertiseLan: false });

let chats = [];
d.sessions = { list: async () => chats.map((s) => ({ ...s })) };

test('a held list gets only its changes, and an unknown one the full list', async () => {
  chats = [{ id: 'a', title: 'one', status: 'idle' }, { id: 'b', title: 'two', status: 'done' }];
  const full = await d.dispatch(M.SESSION_LIST, {});
  assert.deepEqual(full.sessions, chats);
  assert.equal(typeof full.digest, 'string');

  const same = await d.dispatch(M.SESSION_LIST, { have: full.digest });
  assert.deepEqual(same, { base: full.digest, digest: full.digest, unchanged: true });

  chats = [{ id: 'c', title: 'new', status: 'working' }, { id: 'a', title: 'one', status: 'working' }, { id: 'b', title: 'two', status: 'done' }];
  const delta = await d.dispatch(M.SESSION_LIST, { have: full.digest });
  assert.equal(delta.sessions, undefined);
  assert.equal(delta.base, full.digest);
  assert.deepEqual(delta.ids, ['c', 'a', 'b']);
  assert.deepEqual(delta.changed, [chats[0], chats[1]]);
  assert.notEqual(delta.digest, full.digest);

  chats = [{ id: 'a', title: 'one', status: 'working' }];
  const removed = await d.dispatch(M.SESSION_LIST, { have: delta.digest });
  assert.deepEqual([removed.ids, removed.changed], [['a'], []]);

  const unknown = await d.dispatch(M.SESSION_LIST, { have: 'not-a-digest' });
  assert.deepEqual(unknown.sessions, chats);
});

test('a request for project keys always gets the full list', async () => {
  chats = [{ id: 'a', title: 'one' }];
  const full = await d.dispatch(M.SESSION_LIST, {});
  const projects = await d.dispatch(M.SESSION_LIST, { have: full.digest, projects: true });
  assert.deepEqual(projects.sessions, chats);
  assert.ok(projects.projects);
});
