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
    // Dispatch without an approval phase by default; restrictions remain available.
    assert.equal(defaultMode(engine), list.find((m) => m.short === 'yolo').id);
    assert.ok(!list.some((m) => m.id === 'plan'));
    assert.ok(!list[0].danger);
    // More than one safe mode, so the ring is not just "on" and "bypass".
    assert.ok(list.filter((m) => !m.danger).length >= 2, `${engine} has nothing safe to cycle`);
  }
});

test('claude modes carry the CLI flag; the bypass is the dangerous one', () => {
  assert.equal(modeFor('claude', 'acceptEdits').cli, 'acceptEdits');
  assert.equal(modeFor('claude', 'bypassPermissions').danger, true);
  assert.equal(modesFor('claude').filter((m) => m.danger).length, 1);
  // An unknown id falls back to the default rather than throwing at a phone.
  assert.equal(modeFor('claude', 'nonsense').id, 'bypassPermissions');
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


test('Codex alone offers auto-review without changing any default', () => {
  const mode = modeFor('codex', 'auto-review');
  assert.equal(mode.label, 'Codex reviews');
  assert.equal(mode.approvalsReviewer, 'auto_review');
  assert.equal(mode.approvalPolicy, modeFor('codex', 'ask').approvalPolicy);
  assert.deepEqual(mode.sandboxPolicy, modeFor('codex', 'ask').sandboxPolicy);
  assert.equal(defaultMode('codex'), 'full');
  for (const [engine, modes] of Object.entries(MODES)) {
    if (engine !== 'codex') assert.equal(modes.some(m => m.id === 'auto-review'), false);
  }
});
