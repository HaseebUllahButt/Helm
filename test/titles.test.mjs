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

test('long fallback titles end at a word boundary and preserve substantive text', () => {
  const title = promptTitle(['Please investigate why the authentication refresh endpoint intermittently returns an error']);
  assert.equal(title, 'investigate why the authentication refresh endpoint…');
  assert.equal(promptTitle(['Fix <Button> rendering']), 'Fix <Button> rendering');
});
