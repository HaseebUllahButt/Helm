import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { commandHelp, wantsHelp, USAGE, OVERVIEW } from '../packages/connect/src/help.js';

const budget = JSON.parse(readFileSync(new URL('./agent-context-budget.json', import.meta.url), 'utf8'));

test('helm help <command> prints that command and its relatives, and --help before -- asks for it', () => {
  const usage = [
    'helm - title', '',
    '  helm exec <machine> -- <command>', '                                    run there',
    '    --env NAME=value               environment',
    '  helm exec-status <machine> <id>   read it later',
    '  helm execute-not <x>              unrelated',
    '  helm say <id> <text...>           send a message', '',
  ].join('\n');
  const exec = commandHelp('exec', usage);
  assert.match(exec, /helm exec <machine>/);
  assert.match(exec, /--env NAME=value/);
  assert.match(exec, /helm exec-status/);
  assert.match(exec, /Do not rerun a command/);
  assert.doesNotMatch(exec, /execute-not|helm say/);
  assert.equal(commandHelp('nosuch', usage), null);
  assert.equal(commandHelp('', usage), null);
  assert.ok(wantsHelp(['--help']));
  assert.ok(wantsHelp(['same', '-h']));
  assert.ok(!wantsHelp(['same', '--', 'explain --help to me']), 'task words after -- are literal');
});

test('every command in the short helm help has its own help', () => {
  const words = [...OVERVIEW.matchAll(/^ {2}(\S.*?) {2,}/gm)].flatMap((m) => m[1].split(', '));
  assert.ok(words.length > 40);
  assert.deepEqual(words.filter((w) => !commandHelp(w, USAGE)), []);
  assert.doesNotMatch(OVERVIEW, /--(?!all)\w/, 'options live in helm help <command>');
});

// Agents read helm help often. Lower the number when the text shrinks; raise it
// only when the owner wants the new text.
test('the short helm help matches the committed size', () => {
  assert.equal(Buffer.byteLength(OVERVIEW), budget.helpOverviewBytes);
});
