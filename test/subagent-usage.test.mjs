import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The reducer itself, not a copy of it. Node strips the types, so these run
 * against the same `apply` the app renders from - which matters here, because
 * what is checked is that state survives a sequence of events rather than
 * that one function returns the right shape.
 */
const { apply, emptyLog, foldAgent } = await import('../apps/web/src/session/types.ts');

const spawn = (log, id) => {
  apply(log, { type: 'turn.start', turnId: 't1', text: 'go', at: 1, seq: 1 });
  apply(log, { type: 'item.start', id, kind: 'subagent', turnId: 't1', name: 'Task', at: 2, seq: 2 });
};
const card = (log, id) => log.turns[log.turns.length - 1].items.find((i) => i.id === id);

test('a finished agent keeps the numbers its run collected', () => {
  const log = emptyLog();
  spawn(log, 'a1');
  // The exact shape of a real run: everything while it works...
  apply(log, {
    type: 'item.update', id: 'a1', at: 3, seq: 3,
    agent: { id: 'task-1', status: 'running', description: 'List .ts files', lastTool: 'Bash', toolUses: 11, tokens: 48210 },
  });
  // ...a frame that says only that it is still going...
  apply(log, { type: 'item.update', id: 'a1', at: 4, seq: 4, agent: { id: 'task-1', status: 'running' } });
  // ...and one that says only that it finished. Either of these used to
  // replace the whole object and take the tool count and tokens with it.
  apply(log, {
    type: 'item.update', id: 'a1', at: 5, seq: 5,
    agent: { id: 'task-1', status: 'completed', summary: 'Found three call sites.' },
  });

  const { agent } = card(log, 'a1');
  assert.equal(agent.status, 'completed');
  assert.equal(agent.summary, 'Found three call sites.');
  assert.equal(agent.toolUses, 11, 'the tool count outlived the run');
  assert.equal(agent.tokens, 48210, 'so did the token count');
  assert.equal(agent.lastTool, 'Bash');
  assert.equal(agent.description, 'List .ts files');
});

test('later frames still win where they say something', () => {
  const log = emptyLog();
  spawn(log, 'a2');
  apply(log, { type: 'item.update', id: 'a2', at: 3, seq: 3, agent: { status: 'running', description: 'Looking', tokens: 10 } });
  apply(log, { type: 'item.update', id: 'a2', at: 4, seq: 4, agent: { status: 'running', description: 'Found it', tokens: 99 } });
  const { agent } = card(log, 'a2');
  assert.equal(agent.description, 'Found it', 'merging must not pin the first value');
  assert.equal(agent.tokens, 99);
});

test('folding never mutates what it was given', () => {
  const before = { status: 'running', lastTool: 'Read', tokens: 5 };
  const after = foldAgent(before, { status: 'completed' });
  assert.equal(before.status, 'running', 'the previous state is untouched');
  assert.equal(after.lastTool, 'Read');
  assert.equal(after.tokens, 5);
});

/**
 * The whole path, from a real recording: the CLI's own bytes through the
 * driver and into the state the card renders from. The tests above can only
 * prove the reducer folds what it is handed; this proves the engine hands it
 * anything at all. A card showing a token count no engine ever sends would be
 * a convincing piece of dead UI.
 */
test('a recorded Claude subagent run reaches the card with its tools and tokens', async () => {
  const { fakeCli, collect } = await import('./helpers.mjs');
  const { ClaudeDriver } = await import('../packages/connect/src/drivers/claude.js');

  const fake = fakeCli('claude', 'subagent');
  const driver = new ClaudeDriver({
    cmd: fake.cmd, env: { CLAUDE_CONFIG_DIR: '/tmp/helm-test-claude-home' },
    args: [], cwd: fake.dir, mode: 'default',
  });
  const log = collect(driver);
  await driver.send('spawn an Explore agent');
  await log.until((e) => e.type === 'turn.done');
  await driver.kill();

  const state = emptyLog();
  for (const e of log.events) apply(state, e);

  const cards = state.turns.flatMap((t) => t.items).filter((i) => i.kind === 'subagent');
  assert.equal(cards.length, 1, 'the Task tool_use became one subagent card');
  const { agent } = cards[0];
  assert.equal(agent.toolUses, 1, 'the tool count reached the card');
  assert.equal(agent.tokens, 4210, 'and so did the tokens');
  assert.ok(agent.summary, 'the final report survived the frame that carried it');
});

/**
 * Codex says nothing about a spawned agent between "running" and its summary,
 * so the card sat mute for the whole run. Its child's tools are the only
 * evidence there is, and they now reach the spawn card.
 */
test('a recorded Codex subagent names what its child is doing', async () => {
  const { fakeCli, collect } = await import('./helpers.mjs');
  const { CodexDriver } = await import('../packages/connect/src/drivers/codex.js');

  const fake = fakeCli('codex', 'subagent');
  const driver = new CodexDriver({ cmd: fake.cmd, env: {}, args: [], cwd: fake.dir, mode: 'default' });
  const log = collect(driver);
  await driver.send('spawn one');
  await log.until((e) => e.type === 'turn.done');
  await driver.kill();

  const state = emptyLog();
  for (const e of log.events) apply(state, e);
  const spawnCard = state.turns.flatMap((t) => t.items).find((i) => i.kind === 'subagent' && i.name === 'spawn_agent');
  assert.ok(spawnCard, 'the spawn became a subagent card');
  assert.equal(spawnCard.agent.lastTool, 'ls', "the child's command reached the parent card");
});
