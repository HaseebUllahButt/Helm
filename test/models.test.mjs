import test from 'node:test';
import assert from 'node:assert/strict';

test('live effort options override only the current model without mutating the shared catalog', async () => {
  const { mergeLiveModelCatalog } = await import('../packages/connect/src/models.js');
  const cached = {
    models: ['heavy', 'light', 'plain'], labels: { light: 'Light' }, default: 'heavy',
    efforts: ['low', 'high', 'max'], effortsByModel: { heavy: ['low', 'high', 'max'], light: ['low', 'max'] },
  };
  const original = structuredClone(cached);
  const { models, extra } = mergeLiveModelCatalog(cached, {
    models: ['light', 'plain'], current: 'light', effort: 'low', efforts: ['low', 'medium'],
  });
  assert.deepEqual(models.effortsByModel.light, ['low', 'medium']);
  assert.deepEqual(models.effortsByModel.heavy, ['low', 'high', 'max']);
  assert.deepEqual(extra, ['heavy']);
  assert.equal(models.effort, 'low');
  assert.deepEqual(models.efforts, [], 'current-model levels are never a fallback for other models');
  const plain = mergeLiveModelCatalog(cached, { current: 'plain', efforts: [] }).models;
  assert.deepEqual(plain.effortsByModel.plain, []);
  assert.deepEqual(plain.effortsByModel.heavy, ['low', 'high', 'max']);
  assert.deepEqual(cached, original);
});

test('OpenCode metadata keeps explicit empty efforts and never borrows another model levels', async () => {
  const { parseOpencodeModelCache } = await import('../packages/connect/src/models.js');
  const parsed = parseOpencodeModelCache({ provider: { models: {
    heavy: { reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }] },
    light: { reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'low'] }] },
    plain: { reasoning: false },
    empty: { reasoning_options: [{ type: 'effort', values: [] }] },
    unknown: { reasoning: true },
  } } });
  assert.deepEqual(parsed.effortsByModel, {
    'provider/heavy': ['low', 'high', 'max'], 'provider/light': ['low', 'medium'],
    'provider/plain': [], 'provider/empty': [],
  });
});

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

test('Codex model detection accepts provider models added after Helm ships', async () => {
  const { mergeCodexPublishedModels, parseCodexModelList } = await import('../packages/connect/src/models.js');
  const found = parseCodexModelList(mergeCodexPublishedModels({ models: [
    { model: 'gpt-6-astra', displayName: 'GPT-6-Astra' },
  ] }, ['gpt-6-luna', 'gpt-6-sol']).models.filter((m) => m.model === 'gpt-6-luna'));

  assert.deepEqual(mergeCodexPublishedModels({ models: ['gpt-6-astra'] }, ['gpt-6-luna', 'gpt-6-luna']).models, [
    'gpt-6-astra',
    { model: 'gpt-6-luna', displayName: 'GPT-6-Luna', supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], inputModalities: ['text', 'image'] },
  ]);

  const detailed = parseCodexModelList([
    {
      model: 'gpt-6-luna',
      displayName: 'GPT-6-Luna',
      isDefault: true,
      supportedReasoningEfforts: [
        { reasoningEffort: 'low' },
        { reasoningEffort: 'xhigh' },
      ],
      additionalSpeedTiers: ['fast'],
      inputModalities: ['text', 'image'],
    },
  ]);

  assert.deepEqual(found.models, ['gpt-6-luna']);
  assert.deepEqual(detailed.models, ['gpt-6-luna']);
  assert.equal(detailed.default, 'gpt-6-luna');
  assert.equal(detailed.labels['gpt-6-luna'], 'GPT-6-Luna');
  assert.deepEqual(detailed.effortsByModel['gpt-6-luna'], ['low', 'xhigh']);
  assert.deepEqual(detailed.speedByModel['gpt-6-luna'], ['fast']);
  assert.equal(detailed.imagesByModel['gpt-6-luna'], true);
});

test('Claude model detection accepts newly published catalog entries', async () => {
  const { parseModelsDevProvider } = await import('../packages/connect/src/models.js');
  const found = parseModelsDevProvider({ anthropic: { models: {
    'claude-sonnet-5': { name: 'Claude Sonnet 5', attachment: true },
    'claude-old-review': { name: 'Old review model' },
  } } }, 'anthropic');

  assert.deepEqual(found.models, ['claude-sonnet-5']);
  assert.equal(found.labels['claude-sonnet-5'], 'Claude Sonnet 5');
  assert.equal(found.imagesByModel['claude-sonnet-5'], true);
});

test('Devin model detection accepts its JSON catalog format', async () => {
  const { parseDevinModelList } = await import('../packages/connect/src/models.js');
  const found = parseDevinModelList(JSON.stringify({ families: [{ variants: [
    { model_uid: 'gpt-6-luna-medium', label: 'GPT-6 Luna Medium' },
    { id: 'swe-2-high', display_name: 'SWE-2 High' },
  ] }] }));

  assert.deepEqual(found.models, ['gpt-6-luna-medium', 'swe-2-high']);
  assert.equal(found.labels['swe-2-high'], 'SWE-2 High');
});

test('Claude and Gemini lists put the newest published model first and pinned snapshots last', async () => {
  const { newestFirst, parseModelsDevProvider } = await import('../packages/connect/src/models.js');
  const published = parseModelsDevProvider({ anthropic: { models: {
    'claude-haiku-4-5': { name: 'Claude Haiku 4.5', release_date: '2025-10-01' },
    'claude-haiku-4-5-20251001': { name: 'Claude Haiku 4.5', release_date: '2025-10-01' },
    'claude-opus-5-5': { name: 'Claude Opus 5.5', release_date: '2026-06-01' },
    'claude-haiku-5-5': { name: 'Claude Haiku 5.5', release_date: '2026-10-07' },
  } } }, 'anthropic');
  assert.equal(published.releasedAt['claude-haiku-5-5'], '2026-10-07');
  const order = newestFirst(['undated-local', ...published.models], published.releasedAt);
  assert.deepEqual(order, [
    'claude-haiku-5-5', 'claude-opus-5-5', 'claude-haiku-4-5', 'undated-local', 'claude-haiku-4-5-20251001',
  ]);
});
