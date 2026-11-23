import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The reducer itself, not a copy of it. Node strips the types, so these run
 * against the same `apply` the app renders from - which matters here, because
 * what is checked is that state survives a sequence of events rather than
 * that one function returns the right shape.
 */
const { apply, emptyLog } = await import('../apps/web/src/session/types.ts');

const spawn = (log, id) => {
  apply(log, { type: 'turn.start', turnId: 't1', text: 'go', at: 1, seq: 1 });
  apply(log, { type: 'item.start', id, kind: 'subagent', turnId: 't1', name: 'Task', at: 2, seq: 2 });
};
const card = (log, id) => log.turns[log.turns.length - 1].items.find((i) => i.id === id);

/**
 * The whole path, from a real recording: the CLI's own bytes through the
 * driver and into the state the card renders from. Later frames that say
 * only "running" or "completed" must not wipe the tool count and tokens.
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

test('a stopped or exited agent process leaves no subagent card still running', () => {
  for (const end of [
    { type: 'turn.done', turnId: 't1', status: 'interrupted', at: 5, seq: 5 },
    { type: 'status', status: 'exited', at: 5, seq: 5 },
  ]) {
    const log = emptyLog();
    spawn(log, 'a3');
    apply(log, { type: 'item.update', id: 'a3', at: 3, seq: 3, agent: { id: 'task-3', status: 'running', description: 'Checking' } });
    apply(log, { type: 'turn.done', turnId: 't1', status: 'ok', at: 4, seq: 4 });
    // A background agent outlives its turn: the card is still live, rightly.
    assert.equal(card(log, 'a3').agent.status, 'running');
    apply(log, end);
    // Its process is gone, so the card must stop looking like it streams.
    assert.equal(card(log, 'a3').agent.status, 'stopped', `${end.type} ${end.status}`);
  }
});
