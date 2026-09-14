import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODES, modesFor, defaultMode, modeFor, modeFromAuto } from '../packages/connect/src/modes.js';

test('every mode the app can show has a label, a one-word short and a hint', () => {
  for (const [engine, list] of Object.entries(MODES)) {
    assert.ok(list.length >= 2, `${engine} needs modes to pick between`);
    const shorts = new Set();
    for (const m of list) {
      assert.ok(m.id && m.label && m.hint, `${engine}/${m.id} is missing copy`);
      assert.match(m.short, /^[a-z]{3,5}$/, `${engine}/${m.id} short is not a chip word`);
      assert.ok(!shorts.has(m.short), `${engine} repeats the short "${m.short}"`);
      shorts.add(m.short);
    }
    // The first is the default, and it is never the dangerous one.
    assert.equal(defaultMode(engine), list[0].id);
    assert.ok(!list[0].danger);
    // Something to cycle through with shift+tab without arming anything.
    assert.ok(list.filter((m) => !m.danger).length >= 2, `${engine} has nothing safe to cycle`);
  }
});

test('claude modes carry the CLI flag; the bypass is the dangerous one', () => {
  assert.equal(modeFor('claude', 'acceptEdits').cli, 'acceptEdits');
  assert.equal(modeFor('claude', 'bypassPermissions').danger, true);
  assert.equal(modesFor('claude').filter((m) => m.danger).length, 1);
  // An unknown id falls back to the default rather than throwing at a phone.
  assert.equal(modeFor('claude', 'nonsense').id, 'default');
  assert.equal(modeFor('nonsense', 'default'), null);
});

test('codex sandbox spellings agree: thread/start takes a string, turn/start an object', () => {
  const SHAPE = {
    'read-only': 'readOnly',
    'workspace-write': 'workspaceWrite',
    'danger-full-access': 'dangerFullAccess',
  };
  for (const m of modesFor('codex')) {
    assert.ok(SHAPE[m.sandbox], `${m.id} has an unknown sandbox ${m.sandbox}`);
    assert.deepEqual(m.sandboxPolicy, { type: SHAPE[m.sandbox] }, `${m.id} disagrees with itself`);
    assert.ok(['untrusted', 'on-request', 'never'].includes(m.approvalPolicy));
  }
  // Only the mode that drops the sandbox is marked dangerous.
  for (const m of modesFor('codex')) assert.equal(!!m.danger, m.sandbox === 'danger-full-access');
});

test('the old auto toggle still lands on each engine dangerous-enough mode', () => {
  assert.equal(modeFromAuto('claude', true), 'auto');
  assert.equal(modeFromAuto('claude', false), 'default');
  assert.equal(modeFromAuto('codex', true), 'full');
  assert.equal(modeFromAuto('codex', false), 'ask');
});
