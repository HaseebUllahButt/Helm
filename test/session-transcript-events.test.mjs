import test from 'node:test';
import assert from 'node:assert/strict';
import { transcriptEvents } from '../packages/connect/src/session-transcript-events.js';

test('helper pages keep the parent and item identities when earlier messages arrive', () => {
  const messages = [{ role: 'user', text: 'One long task', sourceId: 'prompt' },
    ...Array.from({ length: 200 }, (_, i) => ({ role: 'assistant', sourceId: 'reply-' + i, text: 'Reply ' + i, tools: [] }))];
  const options = { context: { id: 'native-message-prompt-0', text: 'One long task' }, open: true };
  const tail = transcriptEvents(messages.slice(-40), { ...options, offset: 161 });
  const earlier = transcriptEvents(messages.slice(-80), { ...options, offset: 121 });
  const whole = transcriptEvents(messages, { offset: 0, open: true });
  assert.equal(tail[0].turnId, whole[0].turnId);
  assert.equal(earlier[0].turnId, whole[0].turnId);
  for (const item of tail.filter(e => e.type === 'item.start')) {
    assert.deepEqual(earlier.find(e => e.type === item.type && e.id === item.id), { ...item, seq: earlier.find(e => e.id === item.id).seq });
    assert.ok(whole.some(e => e.id === item.id && e.turnId === item.turnId));
  }
  assert.equal(tail.filter(e => e.type === 'item.start').length, 40);
});
