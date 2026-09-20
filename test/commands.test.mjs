import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listCommands, BUILT_IN } from '../packages/connect/src/commands.js';

test('the palette is helm\'s own actions plus the commands the owner wrote', () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-cmds-'));
  const project = join(root, 'project');
  mkdirSync(join(project, '.claude', 'commands', 'ship'), { recursive: true });
  writeFileSync(join(project, '.claude', 'commands', 'review.md'),
    '---\ndescription: Review the diff for correctness bugs\n---\nLook at the diff.\n');
  writeFileSync(join(project, '.claude', 'commands', 'ship', 'release.md'),
    '# Cut a release\nTag, build and push.\n');
  // Not markdown, and so not a command.
  writeFileSync(join(project, '.claude', 'commands', 'notes.txt'), 'ignore me');

  const home = join(root, 'home');
  mkdirSync(join(home, 'commands'), { recursive: true });
  writeFileSync(join(home, 'commands', 'standup.md'), 'What did I do yesterday?\n');

  const list = listCommands({ engine: 'claude', cwd: project, home });
  const byName = Object.fromEntries(list.map((c) => [c.name, c]));

  assert.ok(BUILT_IN.every((b) => byName[b.name]), 'helm\'s own actions are always offered');
  assert.equal(byName.review.description, 'Review the diff for correctness bugs');
  assert.equal(byName.review.source, 'project');
  // A nested directory is one level of namespace, spelled the way the CLI does.
  assert.equal(byName['ship:release'].description, 'Cut a release');
  assert.equal(byName.standup.description, 'What did I do yesterday?');
  assert.equal(byName.standup.source, 'yours');
  assert.equal(byName['notes'], undefined, 'only markdown files are commands');
});

test('a machine with no commands directory has a palette, not an error', () => {
  const list = listCommands({ engine: 'claude', cwd: '/nowhere-at-all', home: '/nowhere-either' });
  assert.deepEqual(list.map((c) => c.name), BUILT_IN.map((c) => c.name));
});

test('a project command wins over a personal one of the same name', () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-cmds2-'));
  const project = join(root, 'p');
  const home = join(root, 'h');
  mkdirSync(join(project, '.claude', 'commands'), { recursive: true });
  mkdirSync(join(home, 'commands'), { recursive: true });
  writeFileSync(join(project, '.claude', 'commands', 'ship.md'), 'the project one\n');
  writeFileSync(join(home, 'commands', 'ship.md'), 'the personal one\n');
  const list = listCommands({ engine: 'claude', cwd: project, home });
  assert.equal(list.filter((c) => c.name === 'ship').length, 1);
  assert.equal(list.find((c) => c.name === 'ship').description, 'the project one');
});

test('codex reads prompts, and an engine with none offers only helm\'s actions', () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-cmds3-'));
  mkdirSync(join(root, 'prompts'), { recursive: true });
  writeFileSync(join(root, 'prompts', 'plan.md'), '---\ndescription: Plan before touching anything\n---\n');
  const codex = listCommands({ engine: 'codex', cwd: '/tmp', home: root });
  assert.equal(codex.find((c) => c.name === 'plan').description, 'Plan before touching anything');
  assert.deepEqual(
    listCommands({ engine: 'devin', cwd: '/tmp', home: root }).map((c) => c.name),
    BUILT_IN.map((c) => c.name),
  );
});

test('commands advertised by the live CLI join the palette without duplicates', () => {
  const list = listCommands({
    engine: 'devin', cwd: '/tmp', home: '/nowhere',
    available: [
      { name: 'status', description: 'Check authentication status', source: 'devin' },
      { name: 'compact', description: 'Agent compact', source: 'devin' },
    ],
  });
  assert.equal(list.find((c) => c.name === 'status').description, 'Check authentication status');
  assert.equal(list.filter((c) => c.name === 'compact').length, 1);
  assert.equal(list.find((c) => c.name === 'compact').source, 'helm');
});
