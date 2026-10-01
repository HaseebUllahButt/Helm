import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-alias-accounts-'));
const { discoverAliasProfiles } = await import('../packages/connect/src/discover.js');
const { HELM_DIR } = await import('../packages/connect/src/paths.js');
assert.equal(HELM_DIR, process.env.HELM_DIR, 'account fixtures must use isolated storage');
const { materialize, saveSecrets } = await import('../packages/connect/src/profiles.js');
const { accountKey, modelPrefs, startPrefs, saveModelPrefs, saveStartPrefs, migrateProfileSettings } = await import('../packages/connect/src/settings.js');
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));

const symbols = new Map([
  ['claude-p', { kind: 'alias', body: 'CLAUDE_CONFIG_DIR=/tmp/test-claude claude' }],
  ['claudea', { kind: 'alias', body: 'CLAUDE_CODE_OAUTH_TOKEN=fake-account-a claude-p' }],
  ['claudeaa', { kind: 'alias', body: 'CLAUDE_CODE_OAUTH_TOKEN=fake-account-a claude-p --permission-mode auto' }],
  ['claudes', { kind: 'alias', body: 'CLAUDE_CODE_OAUTH_TOKEN=fake-account-s claude-p' }],
  ['same-alias', { kind: 'alias', body: 'CLAUDE_CODE_OAUTH_TOKEN=fake-account-s claude-p' }],
]);

test('token aliases stay discoverable and materialize their own credential', async () => {
  const { profiles, secrets } = await discoverAliasProfiles(symbols, { claude: 'claude' });
  assert.deepEqual(profiles.map((p) => p.id), [...symbols.keys()]);
  assert.equal(Object.keys(secrets).length, 2, 'distinct tokens have distinct local slots');
  assert.equal(JSON.stringify(profiles).includes('fake-account-'), false, 'profiles contain references only');
  saveSecrets(secrets);
  const byId = Object.fromEntries(profiles.map((p) => [p.id, p]));
  assert.equal(materialize(byId.claudea).env.CLAUDE_CODE_OAUTH_TOKEN, 'fake-account-a');
  assert.equal(materialize(byId.claudes).env.CLAUDE_CODE_OAUTH_TOKEN, 'fake-account-s');
  assert.equal(accountKey(byId.claudea), accountKey(byId.claudeaa));
  assert.notEqual(accountKey(byId.claudea), accountKey(byId.claudes));
  assert.equal(accountKey(byId.claudes), accountKey(byId['same-alias']));
});

test('legacy credential profiles still launch and saved account choices survive migration', async () => {
  saveSecrets({ CLAUDE_CODE_OAUTH_TOKEN: 'fake-legacy' });
  const old = { id: 'claudea', engine: 'claude', env: { CLAUDE_CONFIG_DIR: '/tmp/test-claude' }, envFrom: ['CLAUDE_CODE_OAUTH_TOKEN'] };
  assert.equal(materialize(old).env.CLAUDE_CODE_OAUTH_TOKEN, 'fake-legacy');
  saveModelPrefs(old, { default: 'claude-opus-5-5', approved: ['claude-opus-5-5'] });
  saveStartPrefs(old, { effort: 'high' });
  const { profiles } = await discoverAliasProfiles(symbols, { claude: 'claude' });
  const current = profiles.find((p) => p.id === old.id);
  migrateProfileSettings([old], profiles);
  assert.equal(modelPrefs(current).default, 'claude-opus-5-5');
  assert.equal(startPrefs(current).effort, 'high');
  saveModelPrefs(current, { default: null, approved: [] });
  migrateProfileSettings(profiles, profiles);
  assert.equal(modelPrefs(current), null, 'cleared preferences do not return on rediscovery');
});
