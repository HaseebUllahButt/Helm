import test from 'node:test';
import assert from 'node:assert/strict';
import { informative, promptTitle } from '../packages/connect/src/titles.js';

test('title fallback finds the request after a greeting and injected context', () => {
  assert.equal(promptTitle([
    '<environment_context>\n<cwd>/tmp/project</cwd>\n</environment_context>\nHi!\n# Task\nPlease fix the login bug',
  ]), 'fix the login bug');
  assert.equal(informative('Hello, could you please fix the login bug'), 'fix the login bug');
  assert.equal(informative('Alright, so what I want you to do is fix the login bug'), 'fix the login bug');
  assert.equal(informative('Please help me with the following:\nRepair password reset'), 'Repair password reset');
  assert.equal(promptTitle(['hi', 'thanks!']), null);
});

test('a short message keeps its words when the opener was most of it', () => {
  assert.equal(informative('hello there'), 'hello there');
  assert.equal(informative('Please help'), 'Please help');
  assert.equal(informative('please ask me'), 'ask me');
  assert.equal(informative('Hi there!\nfix the login bug'), 'fix the login bug');
});

test('long fallback titles end at a word boundary and preserve substantive text', () => {
  const title = promptTitle(['Please investigate why the authentication refresh endpoint intermittently returns an error']);
  assert.equal(title, 'investigate why the authentication refresh endpoint…');
  assert.equal(promptTitle(['Fix <Button> rendering']), 'Fix <Button> rendering');
});

test('a title is what the owner said, without the CLIs\' image and paste labels', async () => {
  const { bareTitle, promptTitle } = await import('../packages/connect/src/titles.js');
  assert.equal(bareTitle('[Image #1] how is this triggered'), 'how is this triggered');
  assert.equal(bareTitle('[Pasted text #2 +40 lines] fix this'), 'fix this');
  assert.equal(promptTitle(['[Image #1] how is this triggered']), 'how is this triggered');
});
