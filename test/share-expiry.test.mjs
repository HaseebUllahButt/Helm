import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep the test's share file out of the real ~/.helm.
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-shares-'));
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));

const { addShare, listShares, removeShare, removeChatShares, DEFAULT_TTL_MS } = await import('../packages/connect/src/shares.js');

test('a new share ends after 3 hours by default', () => {
  const s = addShare({ name: 'spin-default', port: 3000 });
  assert.equal(DEFAULT_TTL_MS, 3 * 60 * 60 * 1000);
  assert.equal(s.expiresAt - s.createdAt, DEFAULT_TTL_MS);
  assert.ok(listShares().some((x) => x.name === 'spin-default'));
  removeShare('spin-default');
});

test('keep makes a share that does not end', () => {
  const s = addShare({ name: 'spin-kept', port: 3001, keep: true });
  assert.equal(s.expiresAt, undefined);
  assert.ok(listShares(Date.now() + 10 * DEFAULT_TTL_MS).some((x) => x.name === 'spin-kept'));
  removeShare('spin-kept');
});

test('an ended share is no longer listed, so its port cannot be reached', () => {
  addShare({ name: 'spin-old', port: 3002, ttlMs: 1000 });
  const later = Date.now() + 5000;
  assert.equal(listShares(later).some((x) => x.name === 'spin-old'), false);
  removeShare('spin-old');
});

test('deleting a chat stops the short links it made, never a kept one or another chat\'s', () => {
  addShare({ name: 'spin-mine', port: 3010, chat: 'chat-a' });
  addShare({ name: 'spin-kept-mine', port: 3011, chat: 'chat-a', keep: true });
  addShare({ name: 'spin-theirs', port: 3012, chat: 'chat-b' });
  addShare({ name: 'spin-owner', port: 3013 });
  assert.equal(listShares().find((x) => x.name === 'spin-kept-mine').chat, undefined, 'a kept link belongs to no chat');
  assert.deepEqual(removeChatShares('chat-a'), ['spin-mine']);
  assert.deepEqual(listShares().map((x) => x.name).filter((n) => n.startsWith('spin-')).sort(), ['spin-kept-mine', 'spin-owner', 'spin-theirs']);
  assert.deepEqual(removeChatShares('chat-a'), []);
  for (const name of ['spin-kept-mine', 'spin-theirs', 'spin-owner']) removeShare(name);
});
