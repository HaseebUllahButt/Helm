import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Devin reads ~/.agents/skills through the real home directory, so HOME
// must point at a tmp dir before commands.js is imported.
process.env.HOME = mkdtempSync(join(tmpdir(), 'helm-cmds-home-'));
const { listCommands } = await import('../packages/connect/src/commands.js');

const skill = (dir, name, text) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), text);
};

test('claude reads the owner\'s command files, and the project copy wins', () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-cmds-'));
  const project = join(root, 'project');
  const home = join(root, 'home');
  mkdirSync(join(project, '.claude', 'commands', 'ship'), { recursive: true });
  mkdirSync(join(home, 'commands'), { recursive: true });
  writeFileSync(join(project, '.claude', 'commands', 'review.md'),
    '---\ndescription: Review the diff for correctness bugs\n---\nLook at the diff.\n');
  writeFileSync(join(project, '.claude', 'commands', 'ship', 'release.md'), '# Cut a release\nTag, build and push.\n');
  writeFileSync(join(project, '.claude', 'commands', 'notes.txt'), 'ignore me');
  writeFileSync(join(project, '.claude', 'commands', 'dup.md'), 'the project one\n');
  writeFileSync(join(home, 'commands', 'dup.md'), 'the personal one\n');
  writeFileSync(join(home, 'commands', 'standup.md'), 'What did I do yesterday?\n');

  const list = listCommands({ engine: 'claude', cwd: project, home });
  const byName = Object.fromEntries(list.map((c) => [c.name, c]));
  assert.equal(byName.review.description, 'Review the diff for correctness bugs');
  assert.equal(byName.review.source, 'project');
  assert.equal(byName['ship:release'].description, 'Cut a release');
  assert.equal(byName.standup.source, 'yours');
  assert.equal(byName.notes, undefined, 'only markdown files are commands');
  assert.equal(list.filter((c) => c.name === 'dup').length, 1);
  assert.equal(byName.dup.description, 'the project one');
});

test('codex prompts and OpenCode 2 command directories are read', () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-cmds3-'));
  mkdirSync(join(root, 'prompts'), { recursive: true });
  writeFileSync(join(root, 'prompts', 'plan.md'), '---\ndescription: Plan before touching anything\n---\n');
  const codex = listCommands({ engine: 'codex', cwd: '/tmp', home: root });
  assert.equal(codex.find((c) => c.name === 'plan').description, 'Plan before touching anything');

  const project = join(root, 'project');
  mkdirSync(join(project, '.opencode', 'commands', 'team'), { recursive: true });
  mkdirSync(join(root, 'opencode', 'commands'), { recursive: true });
  writeFileSync(join(project, '.opencode', 'commands', 'team', 'review.md'), 'Review this branch.\n');
  writeFileSync(join(root, 'opencode', 'commands', 'release.md'), 'Prepare a release.\n');
  const oc = listCommands({ engine: 'opencode2', cwd: project, home: root });
  assert.equal(oc.find((c) => c.name === 'team/review')?.source, 'project');
  assert.equal(oc.find((c) => c.name === 'release')?.source, 'yours');
});

test('devin reads the owner\'s skills as commands', () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-devin-cmds-'));
  const project = join(root, 'project');
  const xdg = join(root, 'xdg');
  skill(join(project, '.devin', 'skills'), 'review',
    '---\nname: review\ndescription: Review the diff for correctness bugs\n---\nLook at the diff.\n');
  skill(join(project, '.agents', 'skills'), 'ship', '# Cut a release\nTag, build and push.\n');
  skill(join(xdg, 'devin', 'skills'), 'standup', 'What did I do yesterday?\n');
  skill(join(process.env.HOME, '.agents', 'skills'), 'eod',
    '---\nname: eod\ndescription: End of day report\n---\n');
  // Not commands: a directory with no SKILL.md, and a loose markdown file.
  mkdirSync(join(xdg, 'devin', 'skills', 'empty'), { recursive: true });
  writeFileSync(join(xdg, 'devin', 'skills', 'loose.md'), 'ignore me\n');

  const byName = Object.fromEntries(
    listCommands({ engine: 'devin', cwd: project, home: xdg }).map((c) => [c.name, c]));
  assert.equal(byName.review.description, 'Review the diff for correctness bugs');
  assert.equal(byName.review.source, 'project');
  assert.equal(byName.ship.description, 'Cut a release');
  assert.equal(byName.standup.source, 'yours');
  assert.equal(byName.eod.description, 'End of day report');
  assert.equal(byName.empty, undefined, 'a directory without SKILL.md is not a command');
  assert.equal(byName.loose, undefined, 'a stray markdown file is not a skill');
});

test('a devin project skill wins over a personal one and over the agent\'s row', () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-devin-cmds2-'));
  const project = join(root, 'p');
  const xdg = join(root, 'h');
  skill(join(project, '.devin', 'skills'), 'ship', 'the project one\n');
  skill(join(xdg, 'devin', 'skills'), 'ship', 'the personal one\n');
  const list = listCommands({
    engine: 'devin', cwd: project, home: xdg,
    available: [{ name: 'ship', description: 'the agent\'s answer', source: 'devin' }],
  });
  assert.equal(list.filter((c) => c.name === 'ship').length, 1);
  assert.equal(list.find((c) => c.name === 'ship').description, 'the project one');
  assert.equal(list.find((c) => c.name === 'ship').source, 'project');
});
