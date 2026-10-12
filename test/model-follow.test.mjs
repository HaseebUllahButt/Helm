import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// New models join an account by themselves, and the default follows the
// newest of its line. Nothing here touches a real ~/.helm.
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-model-follow-'));
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));

const { modelLine, modelPrefs, modelWatch, saveModelPrefs, syncNewModels, dismissModelNews } =
  await import('../packages/connect/src/settings.js');
const { followNewModels } = await import('../packages/connect/src/models.js');

// One account per test, so each starts from an unseen catalog.
let n = 0;
const account = (engine = 'claude') => ({ id: `a${++n}`, engine, cmd: engine, args: [], env: { HOME_DIR: `~/acct-${n}` } });
const start = (profile, ids, prefs) => {
  syncNewModels(profile, ids);
  if (prefs) saveModelPrefs(profile, prefs);
};

test('model ids read as a line and a version, or not at all', () => {
  assert.deepEqual(modelLine('claude-opus-5-5'), { line: 'claude-opus', version: [5, 5], pin: false });
  assert.deepEqual(modelLine('claude-opus-5'), { line: 'claude-opus', version: [5], pin: false });
  assert.deepEqual(modelLine('claude-haiku-4-5-20251001'), { line: 'claude-haiku', version: [4, 5], pin: true });
  assert.deepEqual(modelLine('claude-3-5-sonnet-20241022'), { line: 'claude-sonnet', version: [3, 5], pin: true });
  assert.deepEqual(modelLine('gpt-5.3-codex'), { line: 'gpt-codex', version: [5, 3], pin: false });
  assert.deepEqual(modelLine('gpt-5.1-codex-max'), { line: 'gpt-codex-max', version: [5, 1], pin: false });
  assert.deepEqual(modelLine('gpt-5.5'), { line: 'gpt', version: [5, 5], pin: false });
  assert.equal(modelLine('gpt-5.5').line === modelLine('gpt-5.5-codex').line, false, 'codex and plain gpt are separate lines');
  assert.deepEqual(modelLine('gemini-3-pro-preview'), { line: 'gemini-pro', version: [3], pin: false });
  // Aliases, effort-suffixed ids and provider-prefixed ids are left alone.
  for (const odd of ['opus', 'sonnet', 'default', 'claude-opus-5-5-high', 'anthropic/claude-opus-4-5', 'o3', '', null]) {
    assert.equal(modelLine(odd), null, String(odd));
  }
});

test('the first look records what is there and changes nothing', () => {
  const a = account();
  saveModelPrefs(a, { default: 'claude-opus-5-5', approved: ['claude-opus-5-5'] });
  assert.deepEqual(syncNewModels(a, ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5-6']), []);
  assert.deepEqual(modelPrefs(a), { default: 'claude-opus-5-5', approved: ['claude-opus-5-5'] });
  assert.deepEqual(modelWatch(a), { auto: true, news: [] });
  // Same catalog again: still nothing.
  assert.deepEqual(syncNewModels(a, ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5-6']), []);
});

test('a never-seen model joins the approved list, with a note', () => {
  const a = account();
  start(a, ['claude-opus-5-5', 'claude-sonnet-5-5'], { default: null, approved: ['claude-sonnet-5-5'] });
  const notes = syncNewModels(a, ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-6'], { 'claude-sonnet-5-6': 'Claude Sonnet 5.6' });
  assert.deepEqual(notes, [{ id: 'claude-sonnet-5-6', label: 'Claude Sonnet 5.6', isDefault: false }]);
  assert.deepEqual(modelPrefs(a).approved, ['claude-sonnet-5-5', 'claude-sonnet-5-6']);
  assert.deepEqual(modelWatch(a).news, notes);
  // Seen now: it is not added a second time, and the owner's removal sticks.
  saveModelPrefs(a, { default: null, approved: ['claude-sonnet-5-5'] });
  syncNewModels(a, ['claude-sonnet-5-5', 'claude-sonnet-5-6']);
  assert.deepEqual(modelPrefs(a).approved, ['claude-sonnet-5-5']);
});

test('a model the owner took off the list is never put back', () => {
  const a = account();
  // Approved before sync ever saw it (it was in the list, not in the catalog).
  saveModelPrefs(a, { default: null, approved: ['claude-sonnet-5-5', 'claude-opus-5-6'] });
  syncNewModels(a, ['claude-sonnet-5-5']);
  saveModelPrefs(a, { default: null, approved: ['claude-sonnet-5-5'] });
  syncNewModels(a, ['claude-sonnet-5-5', 'claude-opus-5-6']);
  assert.deepEqual(modelPrefs(a).approved, ['claude-sonnet-5-5']);
  // Clearing the whole list is "offer everything", not a choice about each model.
  saveModelPrefs(a, { default: null, approved: ['claude-sonnet-5-5', 'claude-haiku-5-5'] });
  saveModelPrefs(a, { default: 'claude-sonnet-5-5', approved: [] });
  saveModelPrefs(a, { default: null, approved: ['claude-sonnet-5-5'] });
  assert.equal(JSON.stringify(modelWatch(a)).includes('haiku'), false);
});

test('the default follows the newest of its own line only', () => {
  const a = account();
  start(a, ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    { default: 'claude-opus-5-5', approved: ['claude-opus-5-5', 'claude-sonnet-5-5'] });
  const notes = syncNewModels(a, ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-6', 'claude-haiku-5-6']);
  assert.equal(modelPrefs(a).default, 'claude-opus-5-5', 'a newer sonnet or haiku does not move an opus default');
  assert.equal(notes.every((x) => !x.isDefault), true);

  const more = syncNewModels(a, ['claude-opus-5-5', 'claude-opus-5-6', 'claude-opus-6'], { 'claude-opus-6': 'Claude Opus 6' });
  assert.equal(modelPrefs(a).default, 'claude-opus-6', 'the highest new opus wins');
  assert.equal(more.find((x) => x.isDefault).label, 'Claude Opus 6');
  assert.ok(modelPrefs(a).approved.includes('claude-opus-6'), 'and it is offered in the picker too');
});

test('codex variants follow their own line', () => {
  const a = account('codex');
  start(a, ['gpt-5.3-codex', 'gpt-5.2'], { default: 'gpt-5.3-codex', approved: ['gpt-5.3-codex', 'gpt-5.2'] });
  syncNewModels(a, ['gpt-5.3-codex', 'gpt-5.2', 'gpt-5.5']);
  assert.equal(modelPrefs(a).default, 'gpt-5.3-codex', 'plain gpt is not a codex successor');
  syncNewModels(a, ['gpt-5.3-codex', 'gpt-5.2', 'gpt-5.5', 'gpt-5.4-codex']);
  assert.equal(modelPrefs(a).default, 'gpt-5.4-codex');
});

test('a default that was not the newest when chosen stays put', () => {
  const a = account();
  start(a, ['claude-opus-5-5', 'claude-opus-5-6'], { default: 'claude-opus-5-5', approved: ['claude-opus-5-5'] });
  syncNewModels(a, ['claude-opus-5-5', 'claude-opus-5-6', 'claude-opus-6']);
  assert.equal(modelPrefs(a).default, 'claude-opus-5-5', 'the owner picked an older one on purpose');
});

test('aliases and dated pins are left alone', () => {
  const alias = account();
  start(alias, ['claude-opus-5-5'], { default: 'opus', approved: ['opus', 'claude-opus-5-5'] });
  syncNewModels(alias, ['claude-opus-5-5', 'claude-opus-6']);
  assert.equal(modelPrefs(alias).default, 'opus', 'opus already tracks the newest');
  assert.ok(modelPrefs(alias).approved.includes('claude-opus-6'));

  const pin = account();
  start(pin, ['claude-haiku-4-5-20251001'], { default: 'claude-haiku-4-5-20251001', approved: ['claude-haiku-4-5-20251001'] });
  syncNewModels(pin, ['claude-haiku-4-5-20251001', 'claude-haiku-5-5', 'claude-haiku-5-5-20260601']);
  assert.equal(modelPrefs(pin).default, 'claude-haiku-4-5-20251001', 'a pinned snapshot is a choice to stay');
  assert.deepEqual(modelPrefs(pin).approved, ['claude-haiku-4-5-20251001', 'claude-haiku-5-5'], 'new snapshots are not offered');
});

test('an old model that only now shows up is not news', () => {
  const a = account();
  start(a, ['claude-opus-5-5'], { default: null, approved: ['claude-opus-5-5'] });
  syncNewModels(a, ['claude-opus-5-5', 'claude-opus-4-1', 'claude-opus-4-5']);
  assert.deepEqual(modelPrefs(a).approved, ['claude-opus-5-5']);
});

test('with no short list, new models just show; the default can still move', () => {
  const a = account();
  start(a, ['claude-opus-5-5'], { default: 'claude-opus-5-5', approved: [] });
  const notes = syncNewModels(a, ['claude-opus-5-5', 'claude-sonnet-5-6', 'claude-opus-5-6']);
  assert.deepEqual(modelPrefs(a), { default: 'claude-opus-5-6', approved: [] });
  assert.deepEqual(notes.map((x) => x.id), ['claude-opus-5-6']);

  const none = account();
  start(none, ['claude-opus-5-5']);
  assert.deepEqual(syncNewModels(none, ['claude-opus-5-5', 'claude-opus-6']), [], 'no prefs, nothing to change');
  assert.equal(modelPrefs(none), null);
});

test('switched off, nothing changes - but the model counts as seen', () => {
  const a = account();
  start(a, ['claude-opus-5-5'], { default: 'claude-opus-5-5', approved: ['claude-opus-5-5'] });
  saveModelPrefs(a, { default: 'claude-opus-5-5', approved: ['claude-opus-5-5'], auto: false });
  assert.equal(modelWatch(a).auto, false);
  assert.deepEqual(syncNewModels(a, ['claude-opus-5-5', 'claude-opus-6']), []);
  assert.deepEqual(modelPrefs(a), { default: 'claude-opus-5-5', approved: ['claude-opus-5-5'] });
  // Switching back on does not dump what arrived meanwhile.
  saveModelPrefs(a, { default: 'claude-opus-5-5', approved: ['claude-opus-5-5'], auto: true });
  assert.equal(modelWatch(a).auto, true);
  assert.deepEqual(syncNewModels(a, ['claude-opus-5-5', 'claude-opus-6']), []);
});

test('saving other prefs keeps the switch, and a note clears once seen', () => {
  const a = account();
  start(a, ['claude-opus-5-5'], { default: 'claude-opus-5-5', approved: ['claude-opus-5-5'] });
  saveModelPrefs(a, { default: 'claude-opus-5-5', approved: ['claude-opus-5-5'], auto: false });
  saveModelPrefs(a, { default: 'claude-opus-5-5', approved: ['claude-opus-5-5'] }); // e.g. the chat picker's "set default"
  assert.equal(modelWatch(a).auto, false, 'left out means kept');
  saveModelPrefs(a, { default: 'claude-opus-5-5', approved: ['claude-opus-5-5'], auto: true });
  syncNewModels(a, ['claude-opus-5-5', 'claude-opus-5-6']);
  assert.equal(modelWatch(a).news.length, 1);
  dismissModelNews(a);
  assert.deepEqual(modelWatch(a).news, []);
});

test('a screen with an old copy of the list cannot undo a joined model', () => {
  const a = account();
  start(a, ['claude-opus-5-5'], { default: 'claude-opus-5-5', approved: ['claude-opus-5-5'] });
  syncNewModels(a, ['claude-opus-5-5', 'claude-sonnet-5-6']);
  // The chat picker still holds [opus-5-5] and only wants to change the default.
  saveModelPrefs(a, { default: 'claude-opus-5-5', approved: ['claude-opus-5-5'], keepApproved: true });
  assert.deepEqual(modelPrefs(a).approved, ['claude-opus-5-5', 'claude-sonnet-5-6']);
  assert.deepEqual(modelWatch(a).news.map((x) => x.id), ['claude-sonnet-5-6']);
});

test('only CLIs with readable names are followed, and not while the list is still arriving', () => {
  const claude = account();
  start(claude, ['claude-opus-5-5'], { default: 'claude-opus-5-5', approved: ['claude-opus-5-5'] });
  followNewModels(claude, { models: ['claude-opus-5-5', 'claude-opus-6'], refreshing: true });
  assert.equal(modelPrefs(claude).default, 'claude-opus-5-5', 'a half-loaded list waits');
  followNewModels(claude, { models: ['claude-opus-5-5', 'claude-opus-6'], refreshing: false });
  assert.equal(modelPrefs(claude).default, 'claude-opus-6');

  const oc = account('opencode');
  saveModelPrefs(oc, { default: null, approved: ['zen/a'] });
  followNewModels(oc, { models: ['zen/a'] });
  followNewModels(oc, { models: ['zen/a', 'zen/b'] });
  assert.deepEqual(modelPrefs(oc).approved, ['zen/a']);
});
