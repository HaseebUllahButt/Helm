import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// What the new-session picker shows - hidden accounts, the one used last,
// starred models - is kept on the machine, so a phone and a laptop open the
// same picker. These are the rules for what gets in and what a partial
// change keeps.
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-picker-prefs-'));
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));

const { pickerPrefs, savePickerPrefs, saveModelPrefs, loadSettings } = await import('../packages/connect/src/settings.js');

test('an untouched machine hides nothing and remembers nothing', () => {
  assert.deepEqual(pickerPrefs(), { hidden: [], last: null, agent: null, favs: {} });
});

test('a change keeps the fields it does not mention', () => {
  savePickerPrefs({ hidden: ['grok||', 'cursor||'] });
  savePickerPrefs({ last: 'codex|~/.codex-personal|' });
  savePickerPrefs({ favs: { codex: ['gpt-6-luna'] } });
  savePickerPrefs({ favs: { claude: ['claude-fable-5-1'] } });
  savePickerPrefs({ agent: 'claude|~/.claude-personal|' });
  savePickerPrefs({ last: 'codex|~/.codex-personal|' });
  assert.deepEqual(pickerPrefs(), {
    hidden: ['grok||', 'cursor||'],
    last: 'codex|~/.codex-personal|',
    agent: 'claude|~/.claude-personal|',
    favs: { codex: ['gpt-6-luna'], claude: ['claude-fable-5-1'] },
  });
  // It is the machine's file, read fresh: what another device sees.
  assert.deepEqual(loadSettings().picker.hidden, ['grok||', 'cursor||']);
});

test('only strings get in, once each; an empty star list removes the engine', () => {
  savePickerPrefs({ hidden: ['a', 'a', '', 3, null, ' b '], favs: { codex: [], 'bad engine!': ['x'], claude: ['m', 'm', 7] } });
  const p = pickerPrefs();
  assert.deepEqual(p.hidden, ['a', 'b']);
  assert.deepEqual(p.favs, { claude: ['m'] });
  savePickerPrefs({ last: '' });
  assert.equal(pickerPrefs().last, null);
});

test('saving picker choices leaves the model defaults alone, and the other way round', () => {
  saveModelPrefs({ engine: 'codex', env: {} }, { default: 'gpt-6-luna', approved: [] });
  savePickerPrefs({ hidden: ['x'] });
  const cfg = JSON.parse(readFileSync(join(process.env.HELM_DIR, 'config.json'), 'utf8'));
  assert.equal(Object.values(cfg.models)[0].default, 'gpt-6-luna');
  assert.deepEqual(cfg.picker.hidden, ['x']);
});
