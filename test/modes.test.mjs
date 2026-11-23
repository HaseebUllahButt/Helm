import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modesFor } from '../packages/connect/src/modes.js';

test('codex sandbox spellings agree: thread/start takes a string, turn/start an object', () => {
  const SHAPE = {
    'read-only': 'readOnly',
    'workspace-write': 'workspaceWrite',
    'danger-full-access': 'dangerFullAccess',
  };
  for (const m of modesFor('codex')) {
    assert.ok(SHAPE[m.sandbox], `${m.id} has an unknown sandbox ${m.sandbox}`);
    assert.deepEqual(m.sandboxPolicy, { type: SHAPE[m.sandbox] }, `${m.id} disagrees with itself`);
    assert.ok(['untrusted', 'on-request', 'never'].includes(m.approvalPolicy));
  }
  // Only the mode that drops the sandbox is marked dangerous.
  for (const m of modesFor('codex')) assert.equal(!!m.danger, m.sandbox === 'danger-full-access');
});
