import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// commands.js resolves ~/.agents/skills through the real home directory, so
// HOME must point at a tmp dir before that module is ever imported.
process.env.HOME = mkdtempSync(join(tmpdir(), 'helm-devin-home-'));
const { listCommands } = await import('../packages/connect/src/commands.js');
const { DEVIN_COMMANDS } = await import('../packages/connect/src/drivers/devin.js');

const skill = (dir, name, text) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), text);
};

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

  const list = listCommands({ engine: 'devin', cwd: project, home: xdg });
  const byName = Object.fromEntries(list.map((c) => [c.name, c]));

  assert.equal(byName.review.description, 'Review the diff for correctness bugs');
  assert.equal(byName.review.source, 'project');
  assert.equal(byName.ship.source, 'project');
  assert.equal(byName.ship.description, 'Cut a release');
  assert.equal(byName.standup.source, 'yours');
  assert.equal(byName.standup.description, 'What did I do yesterday?');
  assert.equal(byName.eod.source, 'yours');
  assert.equal(byName.eod.description, 'End of day report');
  assert.equal(byName.empty, undefined, 'a directory without SKILL.md is not a command');
  assert.equal(byName.loose, undefined, 'a stray markdown file is not a skill');
});

test('a project skill wins over a personal one of the same name', () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-devin-cmds2-'));
  const project = join(root, 'p');
  const xdg = join(root, 'h');
  skill(join(project, '.devin', 'skills'), 'ship', 'the project one\n');
  skill(join(xdg, 'devin', 'skills'), 'ship', 'the personal one\n');
  const list = listCommands({ engine: 'devin', cwd: project, home: xdg });
  assert.equal(list.filter((c) => c.name === 'ship').length, 1);
  assert.equal(list.find((c) => c.name === 'ship').description, 'the project one');
  assert.equal(list.find((c) => c.name === 'ship').source, 'project');
});

test('a skill keeps its own row when the agent advertises the same name', () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-devin-cmds3-'));
  const project = join(root, 'p');
  skill(join(project, '.devin', 'skills'), 'review', '---\ndescription: the file\'s answer\n---\n');
  const list = listCommands({
    engine: 'devin', cwd: project, home: join(root, 'h'),
    available: [{ name: 'review', description: 'the agent\'s answer', source: 'devin' }],
  });
  assert.equal(list.filter((c) => c.name === 'review').length, 1);
  const row = list.find((c) => c.name === 'review');
  assert.equal(row.source, 'project');
  assert.equal(row.description, 'the file\'s answer');
});

test('devin\'s static fallback joins the palette like an advertised set', () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-devin-cmds4-'));
  const list = listCommands({
    engine: 'devin', cwd: join(root, 'p'), home: join(root, 'h'),
    available: DEVIN_COMMANDS,
  });
  for (const name of ['status', 'fast', 'mcp', 'rename', 'help', 'usage']) {
    assert.ok(list.some((c) => c.name === name), `/${name} is offered`);
  }
  // helm's own /compact is intercepted before the CLI sees it, so a file or
  // an advertisement can never take its row.
  assert.equal(list.filter((c) => c.name === 'compact').length, 1);
  assert.equal(list.find((c) => c.name === 'compact').source, 'helm');
});

test('devin /usage is in the palette before the driver advertises anything', () => {
  const root = mkdtempSync(join(tmpdir(), 'helm-devin-cmds5-'));
  const list = listCommands({
    engine: 'devin', cwd: join(root, 'p'), home: join(root, 'h'), available: [],
  });
  const usage = list.filter((c) => c.name === 'usage');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].source, 'devin');
  assert.equal(usage[0].description, 'Show account quota and usage');
});
