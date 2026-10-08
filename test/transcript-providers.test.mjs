import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { messages, sessionSnapshot, sessionActivity, locate } from '../packages/connect/src/transcript.js';

const root = mkdtempSync(join(tmpdir(), 'helm-provider-transcripts-'));
test.after(() => rmSync(root, { recursive: true, force: true }));

test('Codex image blocks become attachments, with captions instead of image envelopes', async () => {
  const path = join(root, 'codex-images.jsonl');
  const data = 'aGVsbG8=';
  writeFileSync(path, [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [
      { type: 'input_text', text: '<image name=[Image #1] path="/tmp/clipboard.png">' },
      { type: 'input_image', image_url: `data:image/png;base64,${data}` },
      { type: 'input_text', text: '</image>\n[Image #1] What is wrong here?' },
    ] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [
      { type: 'input_image', image_url: { url: `data:image/jpeg;base64,${data}` } },
    ] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'A literal <image> tag in a code example.' },
      { type: 'input_image', image_url: 'https://example.invalid/image.png' },
    ] } },
  ].map(x => JSON.stringify(x)).join('\n'));
  const history = await messages({ engine: 'codex', path, all: true });
  assert.equal(history[0].text, 'What is wrong here?');
  assert.deepEqual(history[0].attachments, [{ filename: 'clipboard.png', mime: 'image/png', data }]);
  assert.match(history[0].rawText, /<image name=/, 'old imported turns can be matched without rewriting their log');
  assert.equal(history[1].text, '');
  assert.equal(history[1].attachments[0].mime, 'image/jpeg');
  assert.equal(history[2].text, 'A literal <image> tag in a code example.');
  assert.equal(history[2].attachments, undefined, 'remote image references are not fetched');
});

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

test('OpenCode 2 native session history renders from session_message', async () => {
  const path = join(root, 'opencode2.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, model TEXT, tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER, cost REAL);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
  `);
  db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?)').run(
    'oc2-1', '{"id":"model-v2"}', 240, 60, 160, 0.25);
  const put = (id, type, seq, data) => db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, 'oc2-1', type, seq, seq, JSON.stringify(data));
  put('u2', 'user', 1, { content: [{ type: 'text', text: 'fix v2' }] });
  put('a2', 'assistant', 2, { content: [
    { type: 'tool', name: 'shell', state: { input: { command: 'npm test' } } },
    { type: 'text', text: 'v2 done' },
  ] });
  db.close();

  const history = await messages({ engine: 'opencode2', path, sessionId: 'oc2-1', all: true });
  assert.deepEqual(history.map((m) => [m.role, m.text]), [['user', 'fix v2'], ['assistant', 'v2 done']]);
  assert.deepEqual(history[1].tools, [{ name: 'shell', input: 'npm test' }]);
  const status = await sessionSnapshot({ engine: 'opencode2', path, sessionId: 'oc2-1', cwd: '/work' });
  assert.match(status, /\*\*Model:\*\* model-v2/);
  assert.match(status, /\*\*Input:\*\* 240/);
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

test('database-backed histories open on their latest window', async () => {
  const opencodePath = join(root, 'opencode-long.db');
  const opencode = new DatabaseSync(opencodePath);
  opencode.exec(`
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT);
  `);
  const putOpenCode = opencode.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
  const putPart = opencode.prepare('INSERT INTO part VALUES (?, ?, ?, ?)');
  for (let i = 0; i < 450; i++) {
    const id = `m-${i}`;
    putOpenCode.run(id, 'long-oc', i, JSON.stringify({ role: i % 2 ? 'assistant' : 'user' }));
    putPart.run(`p-${i}`, id, i, JSON.stringify({ type: 'text', text: `message-${i}` }));
  }
  opencode.close();
  const openCodeHistory = await messages({ engine: 'opencode', path: opencodePath, sessionId: 'long-oc' });
  assert.equal(openCodeHistory.length, 120);
  assert.equal(openCodeHistory[0].text, 'message-330');
  assert.equal(openCodeHistory.at(-1).text, 'message-449');

  const opencode2Path = join(root, 'opencode2-long.db');
  const opencode2 = new DatabaseSync(opencode2Path);
  opencode2.exec(`
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);
  `);
  const putOpenCode2 = opencode2.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 450; i++) {
    putOpenCode2.run(`m2-${i}`, 'long-oc2', i % 2 ? 'assistant' : 'user', i, i,
      JSON.stringify({ content: [{ type: 'text', text: `message-${i}` }] }));
  }
  opencode2.close();
  const openCode2History = await messages({ engine: 'opencode2', path: opencode2Path, sessionId: 'long-oc2' });
  assert.equal(openCode2History.length, 120);
  assert.equal(openCode2History[0].text, 'message-330');
  assert.equal(openCode2History.at(-1).text, 'message-449');
});

test('Pi history reads message records: text, tool calls, thinking and usage', async () => {
  const path = join(root, 'pi-session.jsonl');
  const lines = [
    { type: 'session', id: 'pi-1', cwd: '/work', timestamp: 1 },
    { type: 'message', message: { role: 'user', id: 'u1', content: [{ type: 'text', text: 'ship it' }] }, timestamp: 2 },
    { type: 'message', message: { role: 'assistant', id: 'a1', content: [
      { type: 'thinking', thinking: 'hmm' },
      { type: 'toolCall', name: 'bash', arguments: { command: 'npm test' } },
      { type: 'text', text: 'shipped' },
    ], usage: { input: 40, output: 12, cacheRead: 5, cost: { total: 0.01 } } }, timestamp: 3 },
    { type: 'model_change', modelId: 'opencode/spark-2', timestamp: 4 },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const history = await messages({ engine: 'pi', path, all: true });
  assert.deepEqual(history.map((m) => [m.role, m.text]), [['user', 'ship it'], ['assistant', 'shipped']]);
  assert.deepEqual(history[1].tools, [{ name: 'bash', input: 'npm test' }]);
  assert.equal(history[1].thinking, true);
  const status = await sessionSnapshot({ engine: 'pi', path, cwd: '/work', monitored: false });
  assert.match(status, /\*\*Model:\*\* opencode\/spark-2/);
  assert.match(status, /\*\*Input:\*\* 40/);
  assert.match(status, /\*\*Cost:\*\* \$0\.0100/);
});

test('Grok history reads flat chat_history records and summary.json model', async () => {
  const dir = join(root, 'grok-sess');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'chat_history.jsonl');
  const lines = [
    { type: 'user', content: 'fix the flaky test', id: 'u1', timestamp: 1 },
    { type: 'assistant', content: [{ type: 'text', text: 'fixed' }], tool_calls: [{ function: { name: 'bash', arguments: '{"command":"npm test"}' } }], id: 'a1', timestamp: 2 },
    { type: 'user', content: '<system-reminder>injected</system-reminder>', id: 'u2', timestamp: 3 },
  ];
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ info: { id: 'g-1', cwd: '/work' }, current_model_id: 'grok-4-fast', session_summary: 'Flaky test' }));

  const history = await messages({ engine: 'grok', path, all: true });
  assert.deepEqual(history.map((m) => [m.role, m.text]), [['user', 'fix the flaky test'], ['assistant', 'fixed']]);
  assert.deepEqual(history[1].tools, [{ name: 'bash', input: 'npm test' }]);
  const status = await sessionSnapshot({ engine: 'grok', path, cwd: '/work', monitored: false });
  assert.match(status, /\*\*Model:\*\* grok-4-fast/);
});

test('omp locate reads past a leading title record to the session header', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-omp-locate-'));
  const dir = join(home, 'sessions', '-work-proj');
  mkdirSync(dir, { recursive: true });
  // omp writes a title record ahead of the session header; locating by the
  // first line alone would never see the header's cwd.
  const path = join(dir, '2026-10-01_abc123.jsonl');
  writeFileSync(path, [
    JSON.stringify({ type: 'title', title: 'omp chat' }),
    JSON.stringify({ type: 'session', id: 'omp-1', cwd: '/work/proj' }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: 'hi' } }),
  ].join('\n') + '\n');

  assert.equal(await locate({ engine: 'omp', home, cwd: '/work/proj' }), path);
  assert.equal(await locate({ engine: 'omp', home, cwd: '/work/other' }), null);
});


test('external activity reads native completion fields while writers remain open', async () => {
  const path = join(root, 'activity-claude.jsonl');
  const write = (content, stop_reason = null) => writeFileSync(path, [
    { type: 'user', message: { role: 'user', content: 'Fix it' } },
    { type: 'assistant', message: { role: 'assistant', stop_reason, content } },
  ].map(JSON.stringify).join('\n') + '\n');
  write([{ type: 'text', text: 'Fixed it' }]);
  assert.equal((await sessionActivity({ engine: 'claude', path, active: true })).status, 'working', 'intermediate text does not complete a turn');
  write([{ type: 'text', text: 'Fixed it' }], 'end_turn');
  assert.equal((await sessionActivity({ engine: 'claude', path, active: true })).status, 'idle');
  write([{ type: 'tool_use', name: 'Bash', id: 'tool', input: {} }]);
  assert.equal((await sessionActivity({ engine: 'claude', path, active: true })).status, 'working');

  const dbPath = join(root, 'activity-open.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE session_message (session_id TEXT, type TEXT, data TEXT, seq INTEGER)');
  const put = (type, data, seq) => db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?)').run('s', type, JSON.stringify(data), seq);
  const read = () => sessionActivity({ engine: 'opencode2', path: dbPath, sessionId: 's', active: true });
  try {
    put('user', { content: [{ type: 'text', text: 'Do it' }] }, 1);
    assert.equal((await read()).status, 'working');
    put('assistant', { content: [{ type: 'text', text: 'Done' }] }, 2);
    assert.equal((await read()).status, 'working', 'streamed text stays running');
    put('assistant', { finish: 'stop', content: [{ type: 'text', text: 'Done' }] }, 3);
    assert.equal((await read()).status, 'idle');
    put('assistant', { finishReason: 'tool-calls', time: { completed: Date.now() }, content: [{ type: 'tool', name: 'shell' }] }, 4);
    assert.equal((await read()).status, 'working');
    put('idle', { outcome: 'succeeded' }, 5);
    assert.equal((await read()).status, 'idle');
  } finally { db.close(); }
});

test('Devin activity follows final-answer phase rather than intermediate text or tool results', async () => {
  const path = join(root, 'devin-activity.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE message_nodes (session_id TEXT, node_id INTEGER, chat_message TEXT)');
  const put = (node, msg) => db.prepare('INSERT INTO message_nodes VALUES (?, ?, ?)').run('devin-live', node, JSON.stringify(msg));
  const read = () => sessionActivity({ engine: 'devin', path, sessionId: 'devin-live', active: true });
  try {
    put(1, { role: 'user', content: 'Investigate' });
    assert.equal((await read()).status, 'working');
    put(2, { role: 'assistant', phase: 'commentary', content: 'Checking it' });
    assert.equal((await read()).status, 'working');
    put(3, { role: 'assistant', content: 'Running a check', tool_calls: [{ name: 'shell' }] });
    assert.equal((await read()).status, 'working');
    put(4, { role: 'tool', content: 'Check complete' });
    assert.equal((await read()).status, 'working');
    put(5, { role: 'assistant', phase: 'final_answer', content: 'Finished' });
    assert.equal((await read()).status, 'idle');
    put(6, { role: 'user', metadata: { telemetry: { source: 'cache_keepalive' } } });
    assert.equal((await read()).status, 'idle', 'cache messages do not reopen a completed turn');
    assert.equal((await sessionActivity({ engine: 'devin', path, sessionId: 'devin-live', active: false })).status, 'done');
  } finally { db.close(); }
});

test('external activity never labels an unreadable live conversation idle', async () => {
  const path = join(root, 'protobuf-conversation.db');
  writeFileSync(path, 'not a text transcript');
  assert.equal((await sessionActivity({ engine: 'agy', path, active: true })).status, 'unknown');
  assert.equal((await sessionActivity({ engine: 'agy', path, active: true, liveStatus: 'working' })).status, 'working');
  assert.equal((await sessionActivity({ engine: 'agy', path, active: true, liveStatus: 'idle' })).status, 'idle');
  assert.equal((await sessionActivity({ engine: 'agy', path, active: false, liveStatus: 'working' })).status, 'done', 'stale busy flags cannot revive dead sessions');
  const grok = join(root, 'grok-activity.jsonl');
  writeFileSync(grok, JSON.stringify({ role: 'assistant', content: 'Intermediate answer', reasoning: 'Thinking from this message' }) + '\n');
  assert.equal((await sessionActivity({ engine: 'grok', path: grok, active: true })).status, 'unknown', 'rendered text and historical thinking cannot prove completion or current work');
});
