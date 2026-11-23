import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const {
  devinAccountDir, devinCredentials, devinSessionConsumption,
} = await import('../packages/connect/src/devin-usage.js');

const tmp = () => mkdtempSync(join(tmpdir(), 'helm-devin-usage-'));

/** An account dir: credentials.toml plus a sessions.db holding `sessionId`. */
function account(root, name, sessionId) {
  const dir = join(root, name);
  mkdirSync(join(dir, 'cli'), { recursive: true });
  writeFileSync(join(dir, 'credentials.toml'),
    'windsurf_api_key = "devin-session-token$x"\napi_server_url = "https://server.codeium.com"\n');
  const conn = new DatabaseSync(join(dir, 'cli', 'sessions.db'));
  conn.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT)');
  conn.exec('CREATE TABLE message_nodes (session_id TEXT, chat_message TEXT)');
  conn.prepare('INSERT INTO sessions (id, title) VALUES (?, ?)').run(sessionId, 'test');
  conn.close();
  return dir;
}

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
