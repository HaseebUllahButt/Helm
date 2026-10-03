import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialScan, formatCredential, CREDENTIAL_ENV_NAMES } from '../packages/connect/src/credentials.js';

// Credential scan: where an account's tokens live and whether they are
// expired - metadata only, never values.

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-01T12:00:00Z');

const jwt = (payload) =>
  `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;

const homes = [];
const tmpHome = () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-creds-'));
  homes.push(dir);
  return dir;
};
after(() => homes.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const write = (dir, rel, body) => {
  const path = join(dir, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
};

const profile = (engine, env = {}, extra = {}) =>
  ({ id: engine, engine, cmd: engine, args: [], env, envFrom: [], unset: [], ...extra });

test('claude oauth credentials report expiry and a dead refresh grant', () => {
  const home = tmpHome();
  write(home, '.credentials.json', JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-' + 'x'.repeat(80),
      refreshToken: 'r'.repeat(60),
      expiresAt: 0,
      refreshTokenExpiresAt: NOW - DAY,
      subscriptionType: 'pro',
    },
  }));
  const [c] = credentialScan(profile('claude', { CLAUDE_CONFIG_DIR: home }), { now: NOW, environ: {} });
  assert.equal(c.kind, 'file');
  assert.equal(c.detail, 'oauth pro');
  assert.equal(c.expired, true);
  assert.equal(c.refreshExpired, true);
  assert.ok(!JSON.stringify(c).includes('sk-ant'), 'no token material in the report');
});

test('a credentials file holding only mcp grants is not a login', () => {
  const home = tmpHome();
  write(home, '.credentials.json', JSON.stringify({
    mcpOAuth: { 'Neon|abc': { serverName: 'Neon', accessToken: 'x'.repeat(60) } },
  }));
  const [c] = credentialScan(profile('claude', { CLAUDE_CONFIG_DIR: home }), { now: NOW, environ: {} });
  assert.equal(c.state, 'empty');
  assert.match(c.detail, /mcp server tokens only/);
});

test('codex auth.json reads the jwt expiry and account id', () => {
  const home = tmpHome();
  write(home, 'auth.json', JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      account_id: 'acct-123',
      access_token: jwt({ exp: (NOW + 6 * DAY) / 1000 }),
      refresh_token: 'r'.repeat(60),
    },
    last_refresh: '2026-09-27T18:33:20Z',
  }));
  const [c] = credentialScan(profile('codex', { CODEX_HOME: home }), { now: NOW, environ: {} });
  assert.equal(c.detail, 'chatgpt oauth');
  assert.equal(c.account, 'acct-123');
  assert.equal(c.expired, false);
  assert.equal(c.refresh, true);
});

test('opencode reports each provider credential in the shared auth.json', () => {
  const data = tmpHome();
  write(data, 'opencode/auth.json', JSON.stringify({
    'opencode-go': { type: 'api', key: 'k'.repeat(40) },
    openai: { type: 'oauth', access: 'a'.repeat(40), refresh: 'r'.repeat(40), expires: NOW + DAY, accountId: 'acct' },
  }));
  const creds = credentialScan(
    profile('opencode', { XDG_CONFIG_HOME: tmpHome(), XDG_DATA_HOME: data }),
    { now: NOW, environ: {} });
  assert.equal(creds.length, 2);
  assert.deepEqual(creds.map((c) => c.detail).sort(), ['openai oauth', 'opencode-go api']);
  assert.ok(!JSON.stringify(creds).includes('kkkk'), 'provider keys never reported');
});

test('devin credentials.toml lists credential key names only', () => {
  const data = tmpHome();
  write(data, 'devin/credentials.toml', [
    'windsurf_api_key = "secret-' + 'x'.repeat(40) + '"',
    'api_server_url = "https://server.codeium.com"',
  ].join('\n'));
  const [c] = credentialScan(
    profile('devin', { XDG_DATA_HOME: data }),
    { now: NOW, environ: {} });
  assert.match(c.detail, /windsurf_api_key/);
  assert.ok(!c.detail.includes('secret-'), 'values stay out of the report');
});

test('agy oauth token reports the google expiry and id_token email', () => {
  const home = tmpHome();
  write(home, 'antigravity-cli/antigravity-oauth-token', JSON.stringify({
    token: {
      access_token: 'ya29.' + 'x'.repeat(80),
      refresh_token: 'r'.repeat(50),
      expiry: '2026-10-01T14:22:34Z',
    },
    auth_method: 'consumer',
    id_token: jwt({ email: 'person@example.com' }),
  }));
  const [c] = credentialScan(profile('agy', { GEMINI_CLI_HOME: home }), { now: NOW, environ: {} });
  assert.equal(c.account, 'person@example.com');
  assert.equal(c.expired, false);
  assert.equal(c.refresh, true);
});

test('env tokens are attributed to resolved profile secrets or daemon', () => {
  const home = tmpHome();
  const viaProfile = credentialScan(
    profile('claude', { CLAUDE_CONFIG_DIR: home }, { envFrom: ['CLAUDE_CODE_OAUTH_TOKEN'] }),
    { now: NOW, environ: {}, secrets: { CLAUDE_CODE_OAUTH_TOKEN: 'test-token' } });
  assert.deepEqual(viaProfile, [{ kind: 'env', where: 'CLAUDE_CODE_OAUTH_TOKEN', via: 'profile' }]);

  const viaDaemon = credentialScan(profile('claude', { CLAUDE_CONFIG_DIR: home }),
    { now: NOW, environ: { ANTHROPIC_AUTH_TOKEN: 'x' } });
  assert.deepEqual(viaDaemon, [{ kind: 'env', where: 'ANTHROPIC_AUTH_TOKEN', via: 'daemon' }]);
});

test('an unset variable wins over inherited and profile sources', () => {
  const home = tmpHome();
  const creds = credentialScan(
    profile('claude', { CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: 'profile-key' }, { unset: ['ANTHROPIC_API_KEY'] }),
    { now: NOW, environ: { ANTHROPIC_API_KEY: 'x' } });
  assert.equal(creds.length, 0);
});

test('wrapped profiles skip the shared home - the script picks the login', () => {
  const home = tmpHome();
  write(home, 'auth.json', JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: jwt({ exp: NOW / 1000 + 99 }) } }));
  const creds = credentialScan(
    profile('codex', {}, { wraps: 'codex' }),
    { now: NOW, environ: {} });
  assert.equal(creds.length, 0, 'a wrapped profile must not claim the default home files');
});

test('engines with no known layout still report credential-named files', () => {
  const home = tmpHome();
  write(home, 'auth-token.json', '{"access_token":"x"}');
  write(home, 'settings.json', '{}');
  const creds = credentialScan(profile('grok', { GROK_HOME: home }), { now: NOW, environ: {} });
  assert.deepEqual(creds.map((c) => c.where), [join(home, 'auth-token.json')]);
  assert.equal(creds[0].detail, 'credential file');
});

test('multiple sources for one account are all reported', () => {
  const home = tmpHome();
  write(home, '.credentials.json', JSON.stringify({
    claudeAiOauth: { accessToken: 't'.repeat(60), expiresAt: NOW + DAY, refreshTokenExpiresAt: NOW + 30 * DAY },
  }));
  const creds = credentialScan(
    profile('claude', { CLAUDE_CONFIG_DIR: home }, { envFrom: ['CLAUDE_CODE_OAUTH_TOKEN'] }),
    { now: NOW, environ: {}, secrets: { CLAUDE_CODE_OAUTH_TOKEN: 'test-token' } });
  assert.equal(creds.length, 2, 'the file token and the env token both show');
  assert.deepEqual(creds.map((c) => c.kind), ['file', 'env']);
});

test('formatCredential renders location and health, never values', () => {
  assert.equal(
    formatCredential({ kind: 'file', where: '~/.codex/auth.json', detail: 'chatgpt oauth', account: 'a1', expiresAt: NOW + DAY, expired: false }),
    `~/.codex/auth.json (chatgpt oauth, a1, expires ${new Date(NOW + DAY).toISOString().slice(0, 10)})`);
  assert.equal(
    formatCredential({ kind: 'env', where: 'CLAUDE_CODE_OAUTH_TOKEN', via: 'profile' }),
    'CLAUDE_CODE_OAUTH_TOKEN (env, profile)');
});

test('inherited account directories and saved secret references are respected', () => {
  const home = tmpHome();
  write(home, 'auth.json', JSON.stringify({ OPENAI_API_KEY: 'file-secret' }));
  const creds = credentialScan(profile('codex', {}, {
    envFrom: ['OPENAI_API_KEY'], secretRefs: { OPENAI_API_KEY: 'account_two' },
  }), { environ: { CODEX_HOME: home }, secrets: { account_two: 'profile-secret' } });
  assert.equal(creds[0].where, join(home, 'auth.json'));
  assert.deepEqual(creds[1], { kind: 'env', where: 'OPENAI_API_KEY', via: 'profile' });
  assert.doesNotMatch(JSON.stringify(creds), /file-secret|profile-secret/);
});

test('missing secret references and blank overrides are not reported as usable tokens', () => {
  const p = profile('codex', { CODEX_HOME: tmpHome(), OPENAI_API_KEY: '' }, {
    envFrom: ['CODEX_API_KEY'], secretRefs: { CODEX_API_KEY: 'missing' },
  });
  assert.deepEqual(credentialScan(p, { environ: { OPENAI_API_KEY: 'inherited' }, secrets: {} }), []);
});

test('null expiry is unknown, epoch expiry is expired, invalid metadata cannot leak objects', () => {
  const home = tmpHome();
  write(home, '.credentials.json', JSON.stringify({ claudeAiOauth: {
    accessToken: 'secret-token', expiresAt: null, refreshTokenExpiresAt: '',
    emailAddress: { accessToken: 'nested-secret' },
  } }));
  const [unknown] = credentialScan(profile('claude', { CLAUDE_CONFIG_DIR: home }), { environ: {}, now: NOW });
  assert.equal(unknown.expiresAt, null);
  assert.equal(unknown.expired, false);
  assert.equal(unknown.refreshExpired, false);
  assert.equal(unknown.account, null);
  assert.doesNotMatch(JSON.stringify(unknown), /secret-token|nested-secret/);
  write(home, 'auth.json', JSON.stringify({ tokens: { access_token: jwt({ exp: 0 }) } }));
  const [epoch] = credentialScan(profile('codex', { CODEX_HOME: home }), { environ: {}, now: NOW });
  assert.equal(epoch.expired, true);
  assert.doesNotThrow(() => formatCredential({ kind: 'file', expiresAt: 1e100 }));
});

test('known engines do not scan unrelated files, and oversized stores are bounded', () => {
  const home = tmpHome();
  write(home, 'unrelated-secret.json', '{}');
  const p = profile('codex', { CODEX_HOME: home });
  assert.deepEqual(credentialScan(p, { environ: {} }), []);
  write(home, 'auth.json', 'x'.repeat(300_000));
  const [c] = credentialScan(p, { environ: {} });
  assert.equal(c.detail, 'unreadable file');
});

test('every env name we probe is unique', () => {
  assert.equal(new Set(CREDENTIAL_ENV_NAMES).size, CREDENTIAL_ENV_NAMES.length);
});
