import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-auth-home-'));
const { probeAuth, usableProfiles, _resetAuthCache } = await import('../packages/connect/src/auth.js');

const dir = mkdtempSync(join(tmpdir(), 'helm-auth-'));
const cli = (name, body) => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};

// Signed in only when FAKE_LOGIN is set, or when the wrapper passes profile "1".
const claude = cli('claude', `if [ -n "$FAKE_LOGIN" ]; then echo '{"loggedIn":true}'; else echo '{"loggedIn":false}'; exit 1; fi`);
const codex = cli('codex', `if [ -n "$FAKE_LOGIN" ]; then echo "Logged in using ChatGPT"; else echo "Not logged in" >&2; exit 1; fi`);
const agyProfile = cli('agy-profile', `if [ "$1" = 1 ]; then printf 'gemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\n'; else echo "Error: Please sign in to view available models."; fi`);
const agy = cli('agy', `echo "Fetching available models..."; echo "Error: Please sign in to view available models. Launch the CLI without arguments to sign in."`);
const slow = cli('slow-codex', 'sleep 5; echo "Logged in"');

const profile = (id, engine, cmd, extra = {}) => ({ id, label: id, engine, cmd, args: [], env: {}, source: 'alias', ...extra });

test('each CLI is asked the way the profile runs it', async () => {
  assert.equal(await probeAuth(profile('c', 'claude', claude, { env: { FAKE_LOGIN: '1' } })), 'authenticated');
  assert.equal(await probeAuth(profile('c0', 'claude', claude)), 'unauthenticated');
  assert.equal(await probeAuth(profile('x', 'codex', codex, { env: { FAKE_LOGIN: '1' } })), 'authenticated');
  assert.equal(await probeAuth(profile('x0', 'codex', codex)), 'unauthenticated');
  assert.equal(await probeAuth(profile('agy', 'agy', agy)), 'unauthenticated');
});

test('a wrapper account is probed through its script and arguments', async () => {
  assert.equal(await probeAuth(profile('a1', 'agy', agyProfile, { args: ['1'], wraps: 'agy' })), 'authenticated');
  assert.equal(await probeAuth(profile('a2', 'agy', agyProfile, { args: ['2'], wraps: 'agy' })), 'unauthenticated');
});

test('engines without a probe, and CLIs that are missing, are unknown', async () => {
  assert.equal(await probeAuth(profile('o', 'opencode', '/bin/true')), 'unknown');
  assert.equal(await probeAuth(profile('gone', 'claude', join(dir, 'nope'))), 'unknown');
});

test('only signed-out profiles are left out of the list', async () => {
  _resetAuthCache();
  const list = await usableProfiles([
    profile('agy', 'agy', agy),
    profile('a1', 'agy', agyProfile, { args: ['1'], wraps: 'agy' }),
    profile('opencode', 'opencode', '/bin/true'),
    profile('shell', 'shell', '/bin/sh'),
  ]);
  assert.deepEqual(list.map((p) => [p.id, p.auth]), [['a1', 'authenticated'], ['opencode', 'unknown'], ['shell', 'unknown']]);
});

test('a slow probe never holds the list up or hides the account', async () => {
  _resetAuthCache();
  const started = Date.now();
  const list = await usableProfiles([profile('slow', 'codex', slow)], { waitMs: 200 });
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(list.map((p) => [p.id, p.auth]), [['slow', 'unknown']]);
});

test('a known answer comes back at once, even when due for a re-check', async () => {
  _resetAuthCache();
  const counter = join(dir, 'slow-count');
  const slowAgy = cli('slow-agy', `echo x >> ${counter}; sleep 2; echo "Please sign in"`);
  const p = profile('slowagy', 'agy', slowAgy);
  const { authStatuses } = await import('../packages/connect/src/auth.js');
  // First sight waits (bounded) and learns the answer.
  assert.equal((await authStatuses([p], { waitMs: 5000 })).get('slowagy'), 'unauthenticated');
  // Known now: a second ask is answered from memory without waiting.
  const started = Date.now();
  assert.equal((await authStatuses([p])).get('slowagy'), 'unauthenticated');
  assert.ok(Date.now() - started < 500);
});

test("the agy check hands its model list to the picker, so it isn't fetched twice", async () => {
  _resetAuthCache();
  const count = join(dir, 'agy-count');
  const counted = cli('agy-counted', `echo x >> ${count}; printf 'gemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\n'`);
  const p = profile('a9', 'agy', counted, { args: ['9'], wraps: 'agy' });
  assert.equal(await probeAuth(p), 'authenticated');
  const { listModels } = await import('../packages/connect/src/models.js');
  const { readFileSync } = await import('node:fs');
  const models = await listModels('agy', '~/.gemini', {}, { cmd: counted, args: ['9'] });
  // (settings.json in the real ~/.gemini may add custom models; the listed one must be there.)
  assert.ok(models.models.includes('gemini-3.8-flash-high'));
  assert.equal(readFileSync(count, 'utf8').trim().split('\n').length, 1, 'agy ran once, for the check');
});
