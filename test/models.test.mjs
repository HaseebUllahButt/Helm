import test from 'node:test';
import assert from 'node:assert/strict';

test('Devin model detection accepts newly added model families', async () => {
  const { parseDevinModelList } = await import('../packages/connect/src/models.js');
  const found = parseDevinModelList(`
Claude Opus 5.5 (claude-opus-5-5)
  aliases: opus
  claude-opus-5-5-medium       Claude Opus 5.5 Medium       [1M context, $5 / 1M Input]
  claude-opus-5-5-high         Claude Opus 5.5 High         [1M context, $5 / 1M Input]
`);

  assert.deepEqual(found.models, ['claude-opus-5-5-medium', 'claude-opus-5-5-high']);
  assert.equal(found.labels['claude-opus-5-5-medium'], 'Claude Opus 5.5 Medium');
});
