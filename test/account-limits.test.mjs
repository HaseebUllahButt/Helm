import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountLimits } from '../packages/connect/src/account-limits.js';
import { accountKey } from '../packages/connect/src/settings.js';

const profile = { id: 'codex', engine: 'codex', env: { CODEX_HOME: '/accounts/.codex-personal' } };
const window = (used, minutes) => ({ usedPercent: used, windowDurationMins: minutes, resetsAt: 10 });

test('account reports deduplicate aliases, preserve sparse windows and survive restart', t => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-limits-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'limits.json');
  const store = new AccountLimits({ file });
  const key = accountKey(profile);
  store.record(key, { codex: { primary: window(15, 300), secondary: window(60, 10080) } }, 1000);
  store.record(key, { codex: { primary: window(20, 300), secondary: null } }, 2000);
  store.record(key, { codex: { primary: window(90, 300) } }, 500);
  store.record(key, { codex: { primary: { usedPercent: null, windowDurationMins: 300 } } }, 3000);
  const report = new AccountLimits({ file }).report([profile, { ...profile, id: 'fast' }, { id: 'pi', engine: 'pi' }]);
  assert.equal(report.accounts.length, 1);
  assert.equal(report.unsupported, 1);
  assert.equal(report.accounts[0].label, 'personal');
  assert.deepEqual(report.accounts[0].aliases, ['codex', 'fast']);
  assert.deepEqual(report.accounts[0].windows.map(w => [w.label, w.used, w.at]), [['5h', 20, 2000], ['7d', 60, 1000]]);
  // An old reset is retained as an old report, never rewritten to zero usage.
  assert.equal(report.accounts[0].windows[0].resetsAt, 10);
  const changedAccount = store.report([{ ...profile, env: { CODEX_HOME: '/different' } }]);
  assert.deepEqual(changedAccount.accounts[0].windows, []);
});

test('history migration uses event timestamps and cannot overwrite a newer live report', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-limits-seed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new AccountLimits({ file: join(dir, 'limits.json') });
  const key = accountKey(profile);
  store.record(key, { codex: { primary: window(20, 300) } }, 3000);
  writeFileSync(join(dir, 'old.jsonl'), [
    { type: 'limits', at: 1000, codex: { primary: window(10, 300), secondary: window(60, 10080) } },
    { type: 'limits', codex: { primary: window(99, 300) } },
    { type: 'text', text: 'private conversation' },
  ].map(e => JSON.stringify(e)).join('\n') + '\n{"type":"limits"');
  await store.seed([{ id: 'old', profileId: profile.id, engine: 'codex' }], [profile], dir);
  assert.deepEqual(store.report([profile]).accounts[0].windows.map(w => [w.used, w.at]), [[20, 3000], [60, 1000]]);
});

test('one account gets the same fingerprint on every machine, whatever its home folder is called', async t => {
  const { accountIdentity } = await import('../packages/connect/src/account-limits.js');
  const dir = mkdtempSync(join(tmpdir(), 'helm-identity-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const token = 'HELM_SECRET_' + 'a'.repeat(64);
  // A saved token: named by a hash of its value, so the same token is the
  // same account here and on the VM, even under another home folder.
  const laptop = { id: 'claudea', engine: 'claude', env: { CLAUDE_CONFIG_DIR: '~/.claude-personal' }, envFrom: ['CLAUDE_CODE_OAUTH_TOKEN'], secretRefs: { CLAUDE_CODE_OAUTH_TOKEN: token } };
  const vm = { ...laptop, id: 'claude', env: { CLAUDE_CONFIG_DIR: '/home/ubuntu/.claude' } };
  assert.ok(accountIdentity(laptop));
  assert.equal(accountIdentity(laptop), accountIdentity(vm));
  assert.notEqual(accountIdentity(laptop), accountIdentity({ ...laptop, secretRefs: { CLAUDE_CODE_OAUTH_TOKEN: 'HELM_SECRET_' + 'b'.repeat(64) } }));
  // A browser login: the provider's own account id, never shipped raw.
  const a = join(dir, 'a'), b = join(dir, 'b'), codex = join(dir, 'codex');
  for (const d of [a, b, codex]) mkdirSync(d);
  writeFileSync(join(a, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acct-1', emailAddress: 'me@example.com' } }));
  writeFileSync(join(b, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acct-1' } }));
  const viaA = accountIdentity({ id: 'p', engine: 'claude', env: { CLAUDE_CONFIG_DIR: a } });
  assert.equal(viaA, accountIdentity({ id: 'q', engine: 'claude', env: { CLAUDE_CONFIG_DIR: b } }));
  assert.ok(!viaA.includes('acct-1') && !viaA.includes('example'));
  writeFileSync(join(codex, 'auth.json'), JSON.stringify({ tokens: { account_id: 'chatgpt-9' } }));
  assert.ok(accountIdentity({ id: 'c', engine: 'codex', env: { CODEX_HOME: codex } }));
  // Nothing local names the account: no fingerprint, the row stays per machine.
  assert.equal(accountIdentity({ id: 'n', engine: 'codex', env: { CODEX_HOME: join(dir, 'missing') } }), null);
  const report = new AccountLimits({ file: join(dir, 'limits.json') }).report([laptop]);
  assert.equal(report.accounts[0].identity, accountIdentity(laptop));
});

test('native Claude reads the correct OAuth account, normalizes percentages and coalesces quota requests', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-native-quota-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const home = join(dir, 'account'); mkdirSync(home);
  writeFileSync(join(home, '.credentials.json'), JSON.stringify({claudeAiOauth:{accessToken:'test-only-token',expiresAt:Date.now()+86400000}}));
  const p = {id:'claude-native',engine:'claude',env:{CLAUDE_CONFIG_DIR:home}};
  const store = new AccountLimits({file:join(dir,'limits.json')});
  let calls = 0;
  const now = Date.now();
  const fetchUsage = async (url, options) => {
    calls++; assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
    assert.equal(options.headers.Authorization,'Bearer test-only-token');
    return {ok:true,json:async()=>({five_hour:{utilization:12,resets_at:new Date(now+3600000).toISOString()},seven_day:{utilization:0,resets_at:new Date(now+86400000).toISOString()}})};
  };
  await Promise.all([store.refreshClaude([p,{...p,id:'alias'}],{fetchUsage,now}),store.refreshClaude([p],{fetchUsage,now})]);
  assert.equal(calls,1);
  const report=store.report([p]);
  assert.deepEqual(report.accounts[0].windows.map(w=>[w.label,w.used]),[['5h',12],['7d',0]]);
  assert.ok(!JSON.stringify(report).includes('test-only-token'));
  await store.refreshClaude([p],{fetchUsage,now:now+120000}); assert.equal(calls,1);
  await store.refreshClaude([p],{fetchUsage:async()=>{calls++;return {ok:false,status:429}},now:now+16*60000});
  assert.equal(calls,2);
  assert.deepEqual(store.report([p]).accounts[0].windows.map(w=>w.used),[12,0]);
});

test('native Claude uses a fresh local quota cache and skips API-key accounts', async t => {
  const dir=mkdtempSync(join(tmpdir(),'helm-native-quota-cache-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const now=Date.now(), p={id:'claude',engine:'claude',env:{CLAUDE_CONFIG_DIR:dir}};
  writeFileSync(join(dir,'.claude.json'),JSON.stringify({cachedUsageUtilization:{fetchedAtMs:now,utilization:{five_hour:{utilization:25,resets_at:new Date(now+3600000).toISOString()}}}}));
  const store=new AccountLimits({file:join(dir,'limits.json')});
  let calls=0;const fetchUsage=async()=>{calls++;throw Error('should not request')};
  await store.refreshClaude([p],{fetchUsage,now});
  assert.equal(store.report([p]).accounts[0].windows[0].used,25);
  await store.refreshClaude([{...p,id:'key',envFrom:['ANTHROPIC_API_KEY'],env:{...p.env,ANTHROPIC_API_KEY:'test-api-key'}}],{fetchUsage,now:now+16*60000});
  assert.equal(calls,0);
  const tokenProfile={...p,id:'token',envFrom:['CLAUDE_CODE_OAUTH_TOKEN'],env:{...p.env,CLAUDE_CODE_OAUTH_TOKEN:'another-login'}};
  await store.refreshClaude([tokenProfile],{fetchUsage:async(_url, options)=>{
    assert.equal(options.headers.Authorization,'Bearer another-login');
    return {ok:true,json:async()=>({five_hour:{utilization:75,resets_at:new Date(now+3600000).toISOString()}})};
  },spec:p=>({env:p.env}),now});
  assert.equal(store.report([tokenProfile]).accounts[0].windows[0].used,75);
});
