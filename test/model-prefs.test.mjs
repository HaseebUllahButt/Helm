import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Per-account model prefs: an approved list trims the picker to what the
// owner actually uses, and a default is what a new session starts with.
// Aliases of one login share the entry because the key is the account, not
// the profile.
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-model-prefs-'));
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));

writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({
  version: 1,
  profiles: [
    { id: 'oc', label: 'opencode', engine: 'opencode', cmd: 'opencode', args: [], env: { XDG_CONFIG_HOME: '~/.config' }, source: 'detected' },
    { id: 'oc-work', label: 'oc work', engine: 'opencode', cmd: 'opencode', args: ['--verbose'], env: { XDG_CONFIG_HOME: '~/.config' }, source: 'alias' },
    { id: 'dv', label: 'Devin', engine: 'devin', cmd: 'devin', args: [], env: { XDG_CONFIG_HOME: '~/.config' }, envFrom: ['DEVIN_TOKEN'], source: 'alias' },
  ],
}));

class StubRuntime extends EventEmitter {
  async read() { return { text: '' }; }
  watch() {}
  async listLive() { return new Map(); }
}

class FakeDriver extends EventEmitter {
  static made = [];
  constructor(opts) {
    super();
    Object.assign(this, opts);
    this.status = 'idle';
    this.pending = new Map();
    FakeDriver.made.push(this);
  }
  push(type, payload) {
    if (type === 'status') this.status = payload.status;
    this.emit('event', { type, ...payload });
  }
  async start() { this.started = true; }
  async kill() { this.push('status', { status: 'exited' }); }
}

test('the account key is the login, not the alias', async () => {
  const { accountKey } = await import('../packages/connect/src/settings.js');
  const { getProfiles } = await import('../packages/connect/src/profiles.js');
  const [oc, ocWork, dv] = await getProfiles();
  assert.equal(accountKey(oc), 'opencode|~/.config|');
  assert.equal(accountKey(ocWork), accountKey(oc), 'two aliases, one account');
  assert.equal(accountKey(dv), 'devin|~/.config|DEVIN_TOKEN', 'a different credential is a different account');
});

test('prefs save, read back, and clear', async () => {
  const { modelPrefs, saveModelPrefs } = await import('../packages/connect/src/settings.js');
  const { getProfiles } = await import('../packages/connect/src/profiles.js');
  const [oc, ocWork] = await getProfiles();
  assert.equal(modelPrefs(oc), null);
  saveModelPrefs(oc, { default: 'zen/kimi', approved: ['zen/kimi', 'zen/glm'] });
  assert.deepEqual(modelPrefs(oc), { default: 'zen/kimi', approved: ['zen/kimi', 'zen/glm'] });
  assert.deepEqual(modelPrefs(ocWork), modelPrefs(oc), 'the other alias sees the same prefs');
  saveModelPrefs(ocWork, { default: null, approved: [] });
  assert.equal(modelPrefs(oc), null, 'an empty list and no default stores nothing');
});

test('applyModelPrefs trims the picker but keeps the tail in reach', async () => {
  const { applyModelPrefs } = await import('../packages/connect/src/settings.js');
  const list = { default: 'cli-def', models: ['a', 'b', 'c', 'd'] };

  const out = applyModelPrefs(list, { default: 'c', approved: ['a', 'c'] });
  assert.deepEqual(out.models, ['a', 'c']);
  assert.deepEqual(out.more, ['b', 'd']);
  assert.equal(out.default, 'c', 'the configured default outranks the CLI one');

  // `all` is what the settings editor asks for: everything, unsplit.
  assert.deepEqual(applyModelPrefs(list, { default: 'c', approved: ['a'] }, { all: true }).models, ['a', 'b', 'c', 'd']);

  // A default that is not approved still lands in the picker.
  assert.deepEqual(applyModelPrefs(list, { default: 'd', approved: ['a'] }).models, ['a', 'd']);

  // An approved set that matched nothing is stale; a long list beats an empty one.
  assert.deepEqual(applyModelPrefs(list, { default: null, approved: ['zzz'] }).models, ['a', 'b', 'c', 'd']);

  // No prefs at all leaves the list untouched.
  assert.equal(applyModelPrefs(list, null), list);
});

test('a new session starts with the account default; a pick always wins', async () => {
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const { saveModelPrefs } = await import('../packages/connect/src/settings.js');
  const { getProfiles } = await import('../packages/connect/src/profiles.js');
  const sessions = new Sessions(new StubRuntime(), { makeDriver: (engine, opts) => new FakeDriver({ engine, ...opts }) });
  const [oc, , dv] = await getProfiles();

  saveModelPrefs(oc, { default: 'zen/kimi', approved: ['zen/kimi'] });
  const s1 = await sessions.start({ cwd: '/tmp', profileId: 'oc' });
  assert.equal(s1.model, 'zen/kimi');
  assert.equal(FakeDriver.made.at(-1).model, 'zen/kimi');

  const s2 = await sessions.start({ cwd: '/tmp', profileId: 'oc', model: 'other/model' });
  assert.equal(s2.model, 'other/model', 'an explicit pick beats the default');

  const s3 = await sessions.start({ cwd: '/tmp', profileId: 'dv' });
  assert.equal(s3.model, null, 'an account with no prefs starts as before');
});
