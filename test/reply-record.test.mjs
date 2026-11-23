import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Imported chats carry the agent's own records of question replies and old
// image wrappers. The owner sees their answers, never the raw record.
const bundle = await build({ entryPoints: ['apps/web/src/session/userMessage.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
const { userMessage } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

test('an imported question reply shows only the answers', () => {
  const text = `<send_user_message_question_reply>\n${JSON.stringify([
    { answer: 'Before today’s Fable change only', question: 'Which rollback point do you mean?', questionItemId: '["internal","call-id",0]' },
    { answer: 'Keep my chats', question: 'What should be preserved?' },
  ])}\n</send_user_message_question_reply>`;
  assert.equal(userMessage(text, []).text, 'Before today’s Fable change only\n\nKeep my chats');
});

test('ordinary messages and unfamiliar reply records stay as written', () => {
  for (const text of [
    'I wrote <send_user_message_question_reply> in my notes.',
    '<send_user_message_question_reply>broken JSON</send_user_message_question_reply>',
    '<send_user_message_question_reply>[{"answer":42}]</send_user_message_question_reply>',
    '<send_user_message_question_reply>[]</send_user_message_question_reply>',
  ]) assert.equal(userMessage(text, []).text, text);
});

test('an old image wrapper becomes a picture and keeps its caption', () => {
  const text = '<image name=[Image #1] path="/tmp/old-image.png">\n</image>\n[Image #1] Why is this broken?';
  const gone = userMessage(text, []);
  assert.equal(gone.text, 'Why is this broken?');
  assert.deepEqual(gone.attachments, [{ filename: 'old-image.png', mime: 'image/png', missing: true }]);
  const kept = [{ filename: 'old-image.png', mime: 'image/png', data: 'x' }];
  assert.deepEqual(userMessage(text, kept), { text: 'Why is this broken?', attachments: kept, printed: false, to: undefined });
});
