import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// What the owner sees as their own message, cleaned of the envelopes the
// wire and the CLIs wrap it in.
const bundle = await build({ entryPoints: ['apps/web/src/session/userMessage.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
const { userMessage } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

test('a message pasted into a terminal CLI loses the paste wrapper and the image note, and keeps its pictures', () => {
  const raw = '<pasted_content id="8cd0">\nnth  i cant see anything [Image #1]\n\nRead the attached image files before answering:\n[Image #1]: "/home/haseeb/.helm/native-images/182f77ad6c1fe6419b151521/image-1.jpg"\n</pasted_content>';
  const shown = userMessage(raw);
  assert.equal(shown.text, 'nth  i cant see anything [Image #1]');
  assert.deepEqual(shown.attachments, [{ filename: 'image-1.jpg', mime: 'image/jpeg', missing: true }]);
  // Pictures the log already has win over the note's file names.
  const kept = [{ filename: 'shot.png', mime: 'image/png' }];
  assert.deepEqual(userMessage(raw, kept).attachments, kept);
});

test('labels opening a message go, since the pictures show them; labels in the words stay', () => {
  const pics = [{ filename: 'a.png', mime: 'image/png', data: 'x' }, { filename: 'b.png', mime: 'image/png', data: 'y' }];
  assert.equal(userMessage('[Image #1] [Image #2]  lighting isnt great here', pics).text, 'lighting isnt great here');
  assert.equal(userMessage('compare [Image #1] with [Image #2]', pics).text, 'compare [Image #1] with [Image #2]');
  assert.equal(userMessage('[Image #1] [Image #2]', pics).text, '');
  // Without pictures the label is all there is to say one was sent.
  assert.equal(userMessage('[Image #1] hi').text, '[Image #1] hi');
});

test('a plain message, with or without the paste wrapper, is left as written', () => {
  assert.equal(userMessage('hello there').text, 'hello there');
  assert.equal(userMessage('<pasted_content id="1">\nline one\nline two\n</pasted_content>').text, 'line one\nline two');
  assert.equal(userMessage('Read the attached image files before answering: nothing').text, 'Read the attached image files before answering: nothing');
});

test("Claude's record of a command it ran reads cleanly: the command as typed, its output as an answer", () => {
  const out = userMessage('<local-command-stdout>Set model to `claude-opus-5-5`</local-command-stdout>');
  assert.equal(out.text, 'Set model to `claude-opus-5-5`');
  assert.equal(out.printed, true);
  assert.equal(userMessage('<command-name>/model</command-name>\n  <command-message>model</command-message>\n  <command-args>claude-opus-5-5</command-args>').text, '/model claude-opus-5-5');
  assert.equal(userMessage('<local-command-caveat>The command below was run directly.</local-command-caveat>').text, '');
  assert.equal(userMessage('hello there').printed, false);
});
