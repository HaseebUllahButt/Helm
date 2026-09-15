import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The reducer itself, not a copy of it. Node strips the types, so these run
 * against the same `apply` the app renders from - which matters here, because
 * what is being checked is that state survives a sequence of events rather
 * than that one function returns the right shape.
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
  // While it works the engine sends everything it knows...
  apply(log, {
    type: 'item.update', id: 'a1', at: 3, seq: 3,
    agent: { id: 'task-1', status: 'running', lastTool: 'Grep', toolUses: 11, tokens: 48210 },
  });
  // ...and when it lands, only that it landed. This frame used to replace the
  // whole object and take the tool count and tokens with it.
  apply(log, {
    type: 'item.update', id: 'a1', at: 4, seq: 4,
    agent: { id: 'task-1', status: 'completed', summary: 'Found three call sites.' },
  });

  const { agent } = card(log, 'a1');
  assert.equal(agent.status, 'completed');
  assert.equal(agent.summary, 'Found three call sites.');
  assert.equal(agent.toolUses, 11, 'the tool count outlived the run');
  assert.equal(agent.tokens, 48210, 'so did the token count');
});

test('the trail records each tool once, in order', () => {
  const log = emptyLog();
  spawn(log, 'a2');
  for (const [seq, lastTool] of [[3, 'Read'], [4, 'Read'], [5, 'Grep'], [6, 'Edit']]) {
    apply(log, { type: 'item.update', id: 'a2', at: seq, seq, agent: { status: 'running', lastTool } });
  }
  const trail = card(log, 'a2').agent.activity.map((a) => a.text);
  // Read appears once: the engine repeats the current tool on every progress
  // frame, and a trail that repeated it would be noise, not history.
  assert.deepEqual(trail, ['Read', 'Grep', 'Edit']);
});

test('the trail is bounded, keeping the most recent steps', () => {
  const log = emptyLog();
  spawn(log, 'a3');
  for (let i = 0; i < 40; i += 1) {
    apply(log, { type: 'item.update', id: 'a3', at: i, seq: i + 3, agent: { lastTool: `tool-${i}` } });
  }
  const trail = card(log, 'a3').agent.activity;
  assert.ok(trail.length <= 8, `kept ${trail.length}`);
  assert.equal(trail[trail.length - 1].text, 'tool-39', 'the newest step is the one kept');
});

test('a spawn card that describes itself starts its own trail', () => {
  const log = emptyLog();
  apply(log, { type: 'turn.start', turnId: 't1', text: 'go', at: 1, seq: 1 });
  apply(log, {
    type: 'item.start', id: 'a4', kind: 'subagent', turnId: 't1', at: 2, seq: 2,
    agent: { status: 'running', description: 'Audit the reducer' },
  });
  assert.deepEqual(card(log, 'a4').agent.activity.map((a) => a.text), ['Audit the reducer']);
});

test('folding never mutates what it was given', () => {
  const before = { status: 'running', lastTool: 'Read', activity: [{ at: 1, text: 'Read' }] };
  const after = foldAgent(before, { lastTool: 'Grep' }, 2);
  assert.equal(before.activity.length, 1, 'the previous state is untouched');
  assert.deepEqual(after.activity.map((a) => a.text), ['Read', 'Grep']);
});

/**
 * The whole path, from a real recording: the CLI's own bytes through the
 * driver and into the state the card renders from. The unit tests above can
 * only prove the reducer folds what it is handed; this proves the engine
 * hands it anything at all. Claude reports usage on `task_progress` frames,
 * and a card showing a token count no engine ever sends would be a
 * convincing piece of dead UI.
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
  assert.ok(agent.activity.some((a) => a.text === 'Glob'), 'the tool it reached for is on the trail');
});
