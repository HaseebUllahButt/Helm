import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { messages, sessionSnapshot } from '../packages/connect/src/transcript.js';

const root = mkdtempSync(join(tmpdir(), 'helm-provider-transcripts-'));
test.after(() => rmSync(root, { recursive: true, force: true }));

test('OpenCode 2 JSON-column history renders text, tools, and usage', async () => {
  const path = join(root, 'opencode.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, model TEXT, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER, cost REAL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT);
  `);
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run('oc-1', '{"id":"model-x"}', 120, 30, 80, 0.125);
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('u1', 'oc-1', 1, JSON.stringify({ role: 'user' }));
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run('p1', 'u1', 1, JSON.stringify({ type: 'text', text: 'fix it' }));
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('a1', 'oc-1', 2, JSON.stringify({ role: 'assistant' }));
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run('p2', 'a1', 2, JSON.stringify({ type: 'tool', tool: 'bash', state: { input: { command: 'npm test' } } }));
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run('p3', 'a1', 3, JSON.stringify({ type: 'text', text: 'done' }));
  db.close();

  const history = await messages({ engine: 'opencode', path, sessionId: 'oc-1', all: true });
  assert.deepEqual(history.map((m) => [m.role, m.text]), [['user', 'fix it'], ['assistant', 'done']]);
  assert.deepEqual(history[1].tools, [{ name: 'bash', input: 'npm test' }]);
  const status = await sessionSnapshot({ engine: 'opencode', path, sessionId: 'oc-1', cwd: '/work', monitored: false });
  assert.match(status, /### Session status/);
  assert.match(status, /\*\*Model:\*\* model-x/);
  assert.match(status, /### Session usage/);
  assert.match(status, /\*\*Input:\*\* 120/);
  assert.match(status, /\*\*Cost:\*\* \$0\.1250/);
  assert.match(status, /\*\*State:\*\* resumed in Helm/);
});

test('Devin history keeps the final streaming snapshot and session statistics', async () => {
  const path = join(root, 'sessions.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, agent_mode TEXT);
    CREATE TABLE message_nodes (node_id INTEGER, session_id TEXT, chat_message TEXT, created_at INTEGER);
  `);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('dv-1', 'swe-test', 'code');
  const put = (node, message) => db.prepare('INSERT INTO message_nodes VALUES (?, ?, ?, ?)').run(node, 'dv-1', JSON.stringify(message), node);
  put(1, { message_id: 'u1', role: 'user', content: 'build it' });
  put(2, { message_id: 'a1', role: 'assistant', content: 'bui', metadata: { metrics: { input_tokens: 2 } } });
  put(3, { message_id: 'a1', role: 'assistant', content: 'built', tool_calls: [{ name: 'exec', arguments: { command: 'npm test' } }], metadata: { metrics: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 20 } } });
  db.close();

  const history = await messages({ engine: 'devin', path, sessionId: 'dv-1', all: true });
  assert.deepEqual(history.map((m) => [m.role, m.text]), [['user', 'build it'], ['assistant', 'built']]);
  assert.deepEqual(history[1].tools, [{ name: 'exec', input: 'npm test' }]);
  const status = await sessionSnapshot({ engine: 'devin', path, sessionId: 'dv-1', cwd: '/work' });
  assert.match(status, /### Session status/);
  assert.match(status, /\*\*Model:\*\* swe-test/);
  assert.match(status, /\*\*Mode:\*\* code/);
  assert.match(status, /\*\*Input:\*\* 10/);
  assert.match(status, /\*\*Cached input:\*\* 20/);
  assert.match(status, /\*\*Output:\*\* 5/);
});
