import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationKey } from '../packages/connect/src/engines.js';

// The `opencode` command can be OpenCode 2, and both versions share one
// database. A helper Helm runs as `opencode` is found as `opencode2`; it must
// match its own record, or it shows again as a separate chat in Finished.
test('an OpenCode 2 chat found by the finder matches a helper run as opencode', () => {
  assert.equal(conversationKey('opencode2', 'ses_1'), conversationKey('opencode', 'ses_1'));
  assert.notEqual(conversationKey('opencode', 'ses_1'), conversationKey('opencode', 'ses_2'));
  assert.notEqual(conversationKey('claude', 'x'), conversationKey('codex', 'x'));
});
