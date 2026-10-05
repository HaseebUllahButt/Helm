import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Limits, codexReading, codexLocal, claudeChatReading, devinReading, dashboardReading, pickReading, limitAccountOf,
} from '../packages/connect/src/limits.js';

const H = 3_600_000;

test('a Codex rollout and the app-server snapshot read the same, by window length not slot', () => {
  const rollout = codexReading({
    primary: { used_percent: 8, window_minutes: 10080, resets_at: 1791787628 }, secondary: null,
    credits: { has_credits: true, unlimited: false, balance: '1894.19' }, plan_type: 'prolite',
  }, 1);
  assert.deepEqual(rollout.windows, [{ key: 'weekly', label: 'Weekly', usedPercent: 8, resetsAt: 1791787628000, durationMs: 168 * H }]);
  assert.deepEqual(rollout.credits, ['1,894 credits left']);
  assert.equal(rollout.plan, 'Pro 5x');
  const live = codexReading({
    primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1791787000 },
    secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1791787628 },
    rateLimitReachedType: 'primary',
  }, 1);
  assert.deepEqual(live.windows.map((w) => [w.key, w.usedPercent]), [['session', 30], ['weekly', 10]]);
  assert.equal(live.note, 'Limit reached');
});

test('the newest Codex rollout holding rate_limits wins, skipping ones without', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-'));
  const day = join(home, 'sessions', '2026', '10', '05');
  mkdirSync(day, { recursive: true });
  const line = (pctUsed, at) => JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: pctUsed, window_minutes: 300, resets_at: 1791787628 } } } });
  writeFileSync(join(day, 'rollout-2026-10-05T01-00-00-a.jsonl'), `${line(10, '2026-10-05T01:00:00Z')}\n${line(12, '2026-10-05T01:05:00Z')}\n`);
  writeFileSync(join(day, 'rollout-2026-10-05T02-00-00-b.jsonl'), '{"type":"session_meta"}\n');
  const r = await codexLocal(home);
  assert.equal(r.windows[0].usedPercent, 12);
  assert.equal(r.at, Date.parse('2026-10-05T01:05:00Z'));
});

test('a Claude chat event reports utilisation as a fraction', () => {
  const r = claudeChatReading({
    status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.19, resetsAt: 1789380000 }, seven_day: { utilization: 0.57, resetsAt: 1789542000 } },
  }, 5);
  assert.deepEqual(r.windows.map((w) => [w.key, w.label, w.usedPercent]), [['session', '5-hour', 19], ['weekly', 'Weekly', 57]]);
  assert.equal(claudeChatReading({ status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: 1 }).note, 'Limit reached');
});

test('Devin quota is remaining percent; a Max plan has one weekly line', () => {
  const pro = devinReading({ planStatus: { dailyQuotaRemainingPercent: 94, weeklyQuotaRemainingPercent: 97, dailyQuotaResetAtUnix: 10, weeklyQuotaResetAtUnix: 20, availablePromptCredits: 500, planInfo: { planName: 'Pro' } } });
  assert.deepEqual(pro.windows.map((w) => [w.label, w.usedPercent, w.resetsAt]), [['Daily', 6, 10_000], ['Weekly', 3, 20_000]]);
  assert.deepEqual(pro.credits, ['500 prompt credits left']);
  const max = devinReading({ planStatus: { dailyQuotaRemainingPercent: 70, weeklyQuotaResetAtUnix: 20, planInfo: { hideDailyQuota: true } } });
  assert.deepEqual(max.windows.map((w) => [w.label, w.usedPercent]), [['Weekly', 30]]);
});

test('BroMyLimits readings map onto the account home and keep saved resets', () => {
  const r = dashboardReading({ provider: 'codex', id: 'codex-default', rateLimits: {
    fetchedAtMs: 7, session: { percent: 40, resetsAt: '2026-10-05T22:00:00Z' }, weekly: null,
    credits: { balance: 12.4 }, resetsAvailable: { available: 2, expiresAt: '2026-10-20T00:00:00Z' }, planLabel: 'Pro 5x',
  } });
  assert.deepEqual(r.windows.map((w) => [w.key, w.label, w.usedPercent]), [['session', '5-hour', 40]]);
  assert.equal(r.plan, 'Pro 5x');
  assert.match(r.credits[1], /^2 limit resets saved, first expires Oct (19|20)$/);
});

test('the newest reading wins and older ones only fill in plan and credits', () => {
  const r = pickReading([
    { at: 1, windows: [{ key: 'weekly', usedPercent: 5 }], plan: 'Pro', credits: ['9 credits left'] },
    { at: 3, windows: [{ key: 'weekly', usedPercent: 9 }] },
    { at: 9, windows: [] },
  ]);
  assert.equal(r.at, 3);
  assert.equal(r.plan, 'Pro');
  assert.deepEqual(r.credits, ['9 credits left']);
});

test('accounts are one per home: aliases fold together, other engines are left out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'limits-'));
  const claudeHome = join(dir, '.claude-work');
  mkdirSync(claudeHome);
  writeFileSync(join(claudeHome, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'w@example.com' } }));
  const profiles = [
    { id: 'cw', engine: 'claude', env: { CLAUDE_CONFIG_DIR: claudeHome } },
    { id: 'cw2', engine: 'claude', env: { CLAUDE_CONFIG_DIR: claudeHome } },
    { id: 'oc', engine: 'opencode', env: {} },
    { id: 'g', engine: 'grok', env: {} },
  ];
  assert.equal(limitAccountOf(profiles[2]), null);
  const limits = new Limits({ profiles: async () => profiles, file: join(dir, 'limits.json'), dashboardUrl: async () => null });
  await limits.note('cw', { claude: { unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 1 } } } });
  // A Codex-style sparse update for a Claude profile is ignored, not merged.
  await limits.note('cw', { codex: { primary: { usedPercent: 99, windowDurationMins: 300 } } });
  const { accounts } = await limits.report();
  assert.equal(accounts.length, 1);
  assert.deepEqual(accounts[0].profileIds, ['cw', 'cw2']);
  assert.equal(accounts[0].name, 'Claude · work');
  assert.equal(accounts[0].identity, 'w@example.com');
  assert.equal(accounts[0].source, 'chat');
  assert.equal(accounts[0].windows[0].usedPercent, 50);
});

test('Check now asks upstream, backs off, and says plainly when signed out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'limits-'));
  const home = join(dir, '.claude');
  mkdirSync(home);
  writeFileSync(join(home, '.claude.json'), '{}');
  writeFileSync(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 't', expiresAt: Date.now() + 3_600_000 } }));
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: false, status: 401, json: async () => ({}) }; };
  const limits = new Limits({ profiles: async () => [{ id: 'c', engine: 'claude', env: { CLAUDE_CONFIG_DIR: home } }], file: join(dir, 'l.json'), fetchImpl, dashboardUrl: async () => null });
  assert.equal((await limits.report()).accounts[0].error, undefined);
  assert.equal(calls, 0, 'a plain read never reaches the network');
  assert.equal((await limits.report({ refresh: true })).accounts[0].error, 'signed out; sign in to Claude again');
  await limits.report({ refresh: true });
  assert.equal(calls, 1, 'a second check inside two minutes is not sent');
});

test('an expired Claude sign-in is reported without asking upstream', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'limits-'));
  const home = join(dir, '.claude');
  mkdirSync(home);
  writeFileSync(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 't', expiresAt: 0 } }));
  let calls = 0;
  const limits = new Limits({ profiles: async () => [{ id: 'c', engine: 'claude', env: { CLAUDE_CONFIG_DIR: home } }], file: join(dir, 'l.json'), fetchImpl: async () => { calls++; }, dashboardUrl: async () => null });
  assert.match((await limits.report({ refresh: true })).accounts[0].error, /sign-in expired/);
  assert.equal(calls, 0);
});
