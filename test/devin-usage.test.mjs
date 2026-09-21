import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const {
  devinAccountDir, devinCredentials, fetchDevinUserStatus,
  devinSessionConsumption, formatDevinUsage, devinUsageReport,
} = await import('../packages/connect/src/devin-usage.js');
const { quotaBar, formatReset, windowLabel, planName } = await import('../packages/connect/src/quota.js');

const tmp = () => mkdtempSync(join(tmpdir(), 'helm-devin-usage-'));

/** An account dir: credentials.toml plus a sessions.db holding `sessionId`. */
function account(root, name, sessionId, dims = null) {
  const dir = join(root, name);
  mkdirSync(join(dir, 'cli'), { recursive: true });
  writeFileSync(join(dir, 'credentials.toml'),
    'windsurf_api_key = "devin-session-token$x"\napi_server_url = "https://server.codeium.com"\n');
  const conn = new DatabaseSync(join(dir, 'cli', 'sessions.db'));
  conn.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT)');
  conn.exec('CREATE TABLE message_nodes (session_id TEXT, chat_message TEXT)');
  conn.prepare('INSERT INTO sessions (id, title) VALUES (?, ?)').run(sessionId, 'test');
  if (dims) {
    const msg = JSON.stringify({
      message_id: 'm1', role: 'assistant',
      metadata: { response_dimensions: dims },
    });
    conn.prepare('INSERT INTO message_nodes (session_id, chat_message) VALUES (?, ?)').run(sessionId, msg);
  }
  conn.close();
  return dir;
}

// ------------------------------------------------------------------ quota.js

test('quotaBar fills to the percent used', () => {
  assert.equal(quotaBar(0), '`' + '░'.repeat(20) + '`');
  assert.equal(quotaBar(50), '`' + '█'.repeat(10) + '░'.repeat(10) + '`');
  assert.equal(quotaBar(100), '`' + '█'.repeat(20) + '`');
  assert.equal(quotaBar(-3), quotaBar(0), 'clamped');
  assert.equal(quotaBar(150), quotaBar(100), 'clamped');
});

test('formatReset is relative within two days and absolute past it', () => {
  const now = Date.UTC(2026, 8, 27, 0, 0, 0);
  assert.equal(formatReset(now / 1000 + 20 * 3600 + 23 * 60, now), 'in 20h 23m');
  assert.equal(formatReset(now / 1000 + 45 * 60, now), 'in 45m');
  assert.equal(formatReset(now / 1000 - 60, now), 'soon');
  const far = formatReset(now / 1000 + 5 * 86400, now);
  assert.match(far, /^\w{3} \d{1,2}, \d{1,2}:\d{2} [AP]M \(UTC[+-][\d:]+\)$/);
  assert.equal(formatReset(undefined, now), '');
});

test('windowLabel names codex\'s buckets the way the TUI does', () => {
  assert.equal(windowLabel({ windowDurationMins: 300 }), '5h limit');
  assert.equal(windowLabel({ windowDurationMins: 10080 }), 'Weekly limit');
  assert.equal(windowLabel({ windowDurationMins: 2880 }), '2d limit');
  assert.equal(windowLabel({ windowDurationMins: 45 }), '45m limit');
  assert.equal(windowLabel({}, 'Primary limit'), 'Primary limit');
});

test('planName title-cases the plan codex reports', () => {
  assert.equal(planName('pro'), 'Pro');
  assert.equal(planName('prolite'), 'Pro Lite');
  assert.equal(planName('business'), 'Business');
  assert.equal(planName('somethingnew'), 'Somethingnew');
});

// ------------------------------------------------------------- devin-usage.js

test('devinAccountDir prefers the transcript\'s own account dir', () => {
  const root = tmp();
  const a = account(root, 'devin', 'sess-a');
  const b = account(root, 'devin-work', 'sess-b');
  assert.equal(devinAccountDir({ transcript: join(b, 'cli', 'sessions.db'), env: { XDG_DATA_HOME: root } }), b);
  // No transcript: the dir whose database holds the session wins.
  assert.equal(devinAccountDir({ engineSessionId: 'sess-b', env: { XDG_DATA_HOME: root } }), b);
  // Unknown session: the default devin dir wins over alternates.
  assert.equal(devinAccountDir({ engineSessionId: 'nobody', env: { XDG_DATA_HOME: root } }), a);
  assert.equal(devinAccountDir({ env: { XDG_DATA_HOME: root } }), a);
});

test('devinCredentials reads the session token without printing it', () => {
  const root = tmp();
  const dir = account(root, 'devin', 's');
  const creds = devinCredentials(dir);
  assert.equal(creds.apiKey, 'devin-session-token$x');
  assert.equal(creds.apiServerUrl, 'https://server.codeium.com');
  assert.throws(() => devinCredentials(join(root, 'nope')), /credentials not found/);
});

test('fetchDevinUserStatus posts the Connect JSON shape the binary sends', async () => {
  const seen = {};
  const fetchImpl = async (url, init) => {
    Object.assign(seen, { url, init });
    return { ok: true, json: async () => ({ userStatus: { pro: true, planStatus: { dailyQuotaRemainingPercent: 95 } } }) };
  };
  const out = await fetchDevinUserStatus(
    { apiKey: 'devin-session-token$x', apiServerUrl: 'https://server.codeium.com' },
    { fetchImpl },
  );
  assert.equal(out.planStatus.dailyQuotaRemainingPercent, 95);
  assert.equal(seen.url, 'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['Connect-Protocol-Version'], '1');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.metadata.apiKey, 'devin-session-token$x');
  assert.equal(body.metadata.ideName, 'devin');
});

test('fetchDevinUserStatus turns a Connect error into a readable failure', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ code: 'unauthenticated', message: 'bad token' }) });
  await assert.rejects(
    fetchDevinUserStatus({ apiKey: 'x', apiServerUrl: 'https://x' }, { fetchImpl }),
    /Failed to fetch quota: bad token/,
  );
});

test('formatDevinUsage draws the quota card the TUI draws', () => {
  const now = Date.now();
  const status = {
    planStatus: {
      planInfo: {
        planName: 'Pro', billingStrategy: 'BILLING_STRATEGY_QUOTA',
        devinInfo: { accountDisplayName: 'My Team' },
      },
      dailyQuotaRemainingPercent: 95,
      weeklyQuotaRemainingPercent: 79,
      dailyQuotaResetAtUnix: String(now / 1000 + 20 * 3600),
      weeklyQuotaResetAtUnix: String(now / 1000 + 5 * 86400),
    },
  };
  const card = formatDevinUsage(status, [], { now });
  assert.match(card, /^### Usage/m);
  assert.match(card, /\*\*Daily\*\* `█░{19}` 5% used · resets in \d+h \d+m/);
  assert.match(card, /\*\*Weekly\*\* `████░{16}` 21% used · resets \w{3} \d+, \d+:\d{2} [AP]M \(UTC[+-][\d:]+\)/);
  assert.match(card, /\*\*Plan:\*\* Pro/);
  assert.match(card, /\*\*Org:\*\* My Team/);
  assert.match(card, /\*No quota consumed yet in this session\.\*/);
});

test('a Devin Max plan shows its one number as the weekly line', () => {
  const now = Date.now();
  const card = formatDevinUsage({
    planStatus: {
      planInfo: { planName: 'Devin Max', hideDailyQuota: true, billingStrategy: 'BILLING_STRATEGY_QUOTA' },
      dailyQuotaRemainingPercent: 40,
      weeklyQuotaResetAtUnix: String(now / 1000 + 3 * 86400),
    },
  }, [], { now });
  assert.doesNotMatch(card, /\*\*Daily\*\*/);
  assert.match(card, /\*\*Weekly\*\* `█{12}░{8}` 60% used/);
});

test('session consumption names the spend when dimensions carry it', () => {
  const now = Date.now();
  const card = formatDevinUsage({
    planStatus: {
      planInfo: { planName: 'Pro', billingStrategy: 'BILLING_STRATEGY_QUOTA' },
      dailyQuotaRemainingPercent: 95,
      dailyQuotaResetAtUnix: String(now / 1000 + 3600),
    },
  }, ['1.5 credits', '2 ACUs'], { now });
  assert.match(card, /\*\*Consumed this session:\*\* 1\\\.5 credits · 2 ACUs/);
});

test('no quota fields and no plan is the CLI\'s own empty answer', () => {
  assert.equal(formatDevinUsage({}), '*No quota data available.*');
});

test('devinSessionConsumption sums cost dimensions per message, once', () => {
  const root = tmp();
  const dir = join(root, 'devin');
  mkdirSync(join(dir, 'cli'), { recursive: true });
  const db = join(dir, 'cli', 'sessions.db');
  const conn = new DatabaseSync(db);
  conn.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
  conn.exec('CREATE TABLE message_nodes (session_id TEXT, chat_message TEXT)');
  const dim = (v) => ({ uid: 'credits', group_title: 'Cost', kind: { CumulativeMetric: { label: 'Credits', value: v, tail: ' credit', plural_tail: ' credits', prefix: '' } } });
  const tok = { uid: 'input_tokens', group_title: 'Token Usage', kind: { CumulativeMetric: { label: 'Input tokens', value: 100, tail: ' token', plural_tail: ' tokens', prefix: '' } } };
  const msg = (id, dims) => JSON.stringify({ message_id: id, role: 'assistant', metadata: { response_dimensions: dims } });
  // Two messages, the second rewritten once - the rewrite must not double.
  conn.prepare('INSERT INTO message_nodes VALUES (?, ?)').run('s', msg('m1', [dim(0.5), tok]));
  conn.prepare('INSERT INTO message_nodes VALUES (?, ?)').run('s', msg('m2', [dim(0.25), tok]));
  conn.prepare('INSERT INTO message_nodes VALUES (?, ?)').run('s', msg('m2', [dim(0.75), tok]));
  conn.close();
  assert.deepEqual(devinSessionConsumption(db, 's'), ['1.25 credits']);
});

test('devinUsageReport ties credentials, quota and session spend together', async () => {
  const root = tmp();
  const dir = account(root, 'devin', 'sess-1', [
    { uid: 'acu', group_title: 'Cost', kind: { CumulativeMetric: { label: 'ACUs', value: 3, tail: ' ACU', plural_tail: ' ACUs', prefix: '' } } },
  ]);
  const card = await devinUsageReport({
    transcript: join(dir, 'cli', 'sessions.db'),
    engineSessionId: 'sess-1',
    env: { XDG_DATA_HOME: root },
    fetchStatus: async () => ({
      planStatus: {
        planInfo: { planName: 'Pro', billingStrategy: 'BILLING_STRATEGY_QUOTA' },
        weeklyQuotaRemainingPercent: 79,
        weeklyQuotaResetAtUnix: String(Math.floor(Date.now() / 1000) + 5 * 86400),
      },
    }),
  });
  assert.match(card, /\*\*Weekly\*\* `████░{16}` 21% used/);
  assert.match(card, /\*\*Consumed this session:\*\* 3 ACUs/);
});
