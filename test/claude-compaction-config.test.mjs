import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureCompaction } from '../scripts/configure-claude-compaction.mjs';

test('compaction deployment preserves existing account settings and is idempotent', t => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-compaction-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'settings.json');
  const before = JSON.stringify({ model: 'opus', env: { ACCOUNT_SETTING: 'keep' }, hooks: { Stop: [] },
    modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' }, 'claude-fable-5-1': { effortLevel: 'medium' } } });
  writeFileSync(file, before);
  const result = configureCompaction(dir);
  assert.equal(readFileSync(result.backup, 'utf8'), before);
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(settings.autoCompactEnabled, true);
  assert.equal(settings.modelSettings['claude-opus-5-5'].autoCompactWindow, 383_000);
  assert.equal(settings.modelSettings['claude-sonnet-5-5'].autoCompactWindow, 283_000);
  assert.equal(settings.modelSettings['claude-haiku-5-5'].autoCompactWindow, 132_000);
  assert.equal(settings.modelSettings['claude-opus-5-5'].effortLevel, 'high');
  assert.deepEqual(settings.modelSettings['claude-fable-5-1'], { effortLevel: 'medium' });
  assert.deepEqual(settings.env, { ACCOUNT_SETTING: 'keep' });
  assert.deepEqual(settings.hooks, { Stop: [] });
  assert.equal(settings.model, 'opus');
  assert.equal(configureCompaction(dir).changed, false);
});
