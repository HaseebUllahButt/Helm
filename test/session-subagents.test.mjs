import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionSubagents } from '../packages/connect/src/session-subagents.js';

test('a removed chat releases helper records and ignores its pending read', async () => {
  const session = { id: 'gone', spawned: true, engine: 'test' };
  let updates = 0;
  const core = { index: new Map([[session.id, session]]),
    delegation: { refreshTeam() { updates++; } } };
  const sessions = { log() {}, events: { derive: () => [{ id: 'helper', status: 'working' }] } };
  const helpers = new SessionSubagents(sessions, core);
  helpers.agentTools.set(session.id, new Map([['helper', new Set(['tool'])]]));
  const reading = helpers.refreshNative(session);
  assert.equal(helpers.native.size, 1);
  helpers.forget(session.id);
  core.index.delete(session.id);
  await reading;
  assert.equal(helpers.native.size, 0);
  assert.equal(helpers.agentTools.size, 0);
  assert.equal(updates, 0, 'a late read cannot publish the removed chat');
});
