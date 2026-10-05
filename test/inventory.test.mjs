import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Inventory reads real stores under HELM_DIR/XDG_DATA_HOME; point both at
// scratch before the modules that resolve them load.
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-inv-'));
const XDG = mkdtempSync(join(tmpdir(), 'helm-xdg-'));
process.env.XDG_DATA_HOME = XDG;

const SECONDS = Math.floor(Date.now() / 1000);

test('Codex native subagent rollouts stay out of recent history without hiding user forks', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-codex-inventory-'));
  const dir = join(home, 'sessions');
  mkdirSync(dir);
  const entries = [
    { id: 'root', source: 'cli' },
    { id: 'child', source: { subagent: { thread_spawn: { parent_thread_id: 'root', depth: 1 } } } },
    { id: 'review', source: { subagent: 'review' } },
    { id: 'fork', source: 'vscode', forked_from_id: 'root' },
  ];
  for (const p of entries) writeFileSync(join(dir, `${p.id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { ...p, cwd: '/tmp/project' } }) + '\n');
  const { inventory } = await import('../packages/connect/src/inventory.js');
  const rows = await inventory([{ id: 'test-codex', engine: 'codex', env: { CODEX_HOME: home } }]);
  assert.deepEqual(rows.filter((r) => r.engine === 'codex').map((r) => r.id).sort(), ['fork', 'root']);
});

function devinStore(accountDir, { hiddenColumn = true } = {}) {
  const dir = join(XDG, accountDir, 'cli');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'sessions.db'));
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, title TEXT, working_directory TEXT, model TEXT,
    created_at INTEGER, last_activity_at INTEGER${hiddenColumn ? ', hidden INTEGER' : ''})`);
  return db;
}

test('devin inventory: sqlite store, seconds become ms, hidden stays out', async () => {
  const db = devinStore('devin');
  const ins = db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)');
  ins.run('slug-one', 'Fix the grey bar', '/tmp/proj-a', 'devin-1', SECONDS - 500, SECONDS - 50, 0);
  ins.run('slug-two', 'Second thread', '/tmp/proj-b', 'devin-1', SECONDS - 400, SECONDS - 10, 1);
  db.close();

  const { inventory } = await import('../packages/connect/src/inventory.js');
  const rows = await inventory([{ id: 'devin', engine: 'devin', env: {} }]);
  const found = rows.filter((r) => r.engine === 'devin');

  assert.deepEqual(found.map((r) => r.id), ['slug-one']);
  assert.equal(found[0].title, 'Fix the grey bar');
  assert.equal(found[0].cwd, '/tmp/proj-a');
  assert.equal(found[0].updatedAt, (SECONDS - 50) * 1000, 'devin stores seconds; the app speaks ms');
  assert.equal(found[0].model, 'devin-1');
  // Newest-first ordering came from the query, not the table.
});

test('a devin store old enough to lack `hidden` is still read', async () => {
  const db = devinStore('devin-legacy', { hiddenColumn: false });
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(
    'old-one', 'Ancient thread', '/tmp/proj-c', 'devin-1', SECONDS - 900, SECONDS - 800);
  db.close();

  const { inventory } = await import('../packages/connect/src/inventory.js');
  const rows = await inventory([{ id: 'devin', engine: 'devin', env: {} }]);
  assert.ok(rows.some((r) => r.id === 'old-one'), 'a missing column must not skip the store');
});

test('two devin profiles do not double-count the shared store', async () => {
  const { inventory } = await import('../packages/connect/src/inventory.js');
  const rows = await inventory([
    { id: 'devin', engine: 'devin', env: {} },
    { id: 'devin-work', engine: 'devin', env: { XDG_CONFIG_HOME: '~/.config-work' } },
  ]);
  const ids = rows.filter((r) => r.engine === 'devin').map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'same sqlite rows, one profile each - no dupes');
});

test('a profiles file fresh from join answers; an old one is stale', async () => {
  const { saveProfiles, profilesStale, currentProfiles } =
    await import('../packages/connect/src/profiles.js');

  saveProfiles([{ id: 'kept', engine: 'codex', cmd: 'codex', source: 'custom' }]);
  assert.equal(profilesStale(), false);
  // A fresh file is trusted: currentProfiles must not rediscover over it.
  assert.deepEqual((await currentProfiles()).map((p) => p.id), ['kept']);

  const file = join(process.env.HELM_DIR, 'profiles.json');
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(file, old, old);
  assert.equal(profilesStale(), true);
});

test('opencode inventory: the model is a JSON object, not a name', async () => {
  const { inventory } = await import('../packages/connect/src/inventory.js');
  const dir = join(XDG, 'opencode-test');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'opencode.db'));
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_updated INTEGER,
    agent TEXT, model TEXT)`);
  const ins = db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)');
  // What opencode really writes, and what the row filled up with before.
  ins.run('oc-1', 'A thread', '/tmp/oc', Date.now(), 'build',
    '{"id":"muse-spark-1.2","providerID":"opencode","variant":"xhigh"}');
  // A plain name, in case a version ever writes one, and a broken value.
  ins.run('oc-2', 'Another', '/tmp/oc', Date.now() - 1000, 'build', 'plain-model-name');
  ins.run('oc-3', 'Third', '/tmp/oc', Date.now() - 2000, 'build', '{not json');
  db.close();

  const found = await inventory([
    { id: 'oc', engine: 'opencode', env: { XDG_CONFIG_HOME: '~/.config' } },
  ]);
  const by = (id) => found.find((s) => s.id === id);
  assert.equal(by('oc-1').model, 'muse-spark-1.2', 'the name out of the object');
  assert.equal(by('oc-2').model, 'plain-model-name', 'a plain name is left alone');
  assert.equal(by('oc-3').model, null, 'nonsense becomes nothing, not JSON on screen');
});

test('OpenCode 2 inventory reads only native v2 sessions', async () => {
  const { inventory } = await import('../packages/connect/src/inventory.js');
  const dir = join(XDG, 'opencode-v2-test');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'opencode.db'));
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_updated INTEGER,
      agent TEXT, model TEXT);
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_updated INTEGER,
      agent TEXT, model TEXT);
  `);
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run(
    'v1-shared', 'V1 thread', '/tmp/v1', Date.now() - 1000, 'build', 'old-model');
  db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?)').run(
    'v1-shared', 'V1 thread', '/tmp/v1', Date.now() - 1000, 'build', 'old-model');
  db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?)').run(
    'v2-only', 'V2 thread', '/tmp/v2', Date.now(), 'build', '{"id":"new-model"}');
  db.close();

  const found = await inventory([
    { id: 'oc2', engine: 'opencode2', env: { XDG_CONFIG_HOME: '~/.config' } },
  ]);
  const rows = found.filter((r) => r.engine === 'opencode2');
  assert.ok(rows.some((r) => r.id === 'v2-only' && r.model === 'new-model'));
  assert.ok(!rows.some((r) => r.id === 'v1-shared'), 'the V1 backfill is not listed twice');
});

test('pi inventory trusts each log\'s own session header, not its folder name', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-pi-home-'));
  const dir = join(home, 'sessions', '--tmp-oddly-named--');
  mkdirSync(dir, { recursive: true });
  const log = join(dir, '2026-09-20_abc123.jsonl');
  writeFileSync(log, [
    { type: 'session', id: 'pi-1', cwd: '/work/real-folder', timestamp: SECONDS - 100 },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'rebuild the cache layer' }] }, timestamp: SECONDS - 90 },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, timestamp: SECONDS - 80 },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  // A file without a session header is skipped, not guessed.
  writeFileSync(join(dir, 'stray.jsonl'), '{"type":"message"}\n');

  const { inventory } = await import('../packages/connect/src/inventory.js');
  const rows = await inventory([{ id: 'pi', engine: 'pi', env: { PI_CODING_AGENT_DIR: home } }]);
  const found = rows.find((r) => r.id === 'pi-1');
  assert.ok(found, 'the session is listed');
  assert.equal(found.cwd, '/work/real-folder');
  assert.equal(found.title, 'rebuild the cache layer');
  assert.equal(found.transcript, log);
  assert.equal(found.active, false);
});

test('agy inventory reads conversation_summaries.db under the gemini home', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-agy-home-'));
  const root = join(home, 'antigravity-cli');
  mkdirSync(join(root, 'conversations'), { recursive: true });
  const db = new DatabaseSync(join(root, 'conversation_summaries.db'));
  db.exec(`CREATE TABLE conversation_summaries (
    conversation_id TEXT PRIMARY KEY, title TEXT, preview TEXT, step_count INTEGER,
    last_modified_time TEXT, workspace_uris TEXT, status TEXT, source TEXT,
    project_id TEXT, agent_name TEXT, parent_conversation_id TEXT, nesting_depth INTEGER,
    battle_id TEXT, winning_conversation_id TEXT, not_fully_idle INTEGER,
    killed INTEGER, last_user_input_time TEXT, last_user_input_step_index INTEGER,
    app_data_dir TEXT, raw_summary BLOB, group_id TEXT)`);
  db.prepare('INSERT INTO conversation_summaries (conversation_id, title, preview, workspace_uris, last_modified_time, not_fully_idle, killed) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'conv-agy-1', 'Add Antigravity IDE Integration', 'a preview',
    '["file:///work/space%20dir"]', '2026-09-25 10:40:44.358828343+00:00', 0, 0);
  db.prepare('INSERT INTO conversation_summaries (conversation_id, title, preview, workspace_uris, last_modified_time, not_fully_idle, killed) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'conv-agy-2', '', '', '["file:///tmp"]', '2026-09-25 09:00:00+00:00', 0, 0);
  db.close();
  writeFileSync(join(root, 'conversations', 'conv-agy-1.db'), '');

  const { inventory } = await import('../packages/connect/src/inventory.js');
  const rows = await inventory([{ id: 'agy', engine: 'agy', env: { GEMINI_CLI_HOME: home } }]);
  const found = rows.find((r) => r.id === 'conv-agy-1');
  assert.ok(found, 'the conversation is listed');
  assert.equal(found.title, 'Add Antigravity IDE Integration');
  assert.equal(found.cwd, '/work/space dir', 'file:// URI decoded');
  assert.ok(found.updatedAt > 0, 'nanosecond timestamp parsed');
  assert.equal(found.transcript, join(root, 'conversations', 'conv-agy-1.db'));
  assert.equal(found.active, false, 'no live writer means not active');
  const bare = rows.find((r) => r.id === 'conv-agy-2');
  assert.equal(bare.title, 'tmp', 'falls back to the folder name');
});

test('grok inventory reads summary.json; no live writer means not active', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-grok-home-'));
  const dir = join(home, 'sessions', '%2Fwork%2Fproj', 'uuid-1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({
    info: { id: 'grok-1', cwd: '/work/proj' },
    session_summary: 'Fixing the pipeline',
    current_model_id: 'grok-4',
    updated_at: new Date((SECONDS - 60) * 1000).toISOString(),
  }));
  writeFileSync(join(dir, 'chat_history.jsonl'), '{"type":"user","content":"hey"}\n');
  // The registry claims a live session, but no process owns it - the id
  // alone must not light the row up as running.
  writeFileSync(join(home, 'active_sessions.json'), JSON.stringify([{ id: 'grok-1' }]));

  const { inventory } = await import('../packages/connect/src/inventory.js');
  const rows = await inventory([{ id: 'grok', engine: 'grok', env: { GROK_HOME: home } }]);
  const found = rows.find((r) => r.id === 'grok-1');
  assert.ok(found, 'the session is listed');
  assert.equal(found.title, 'Fixing the pipeline');
  assert.equal(found.cwd, '/work/proj');
  assert.equal(found.model, 'grok-4');
  assert.equal(found.active, false, 'a registry id without a process is not active');
});

test('antigravity inventory sorts before it caps: the newest db survives a crowded folder', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-agy-managed-'));
  const dir = join(home, 'antigravity-acp', 'conversations');
  mkdirSync(dir, { recursive: true });
  const total = 90; // past the PER_ENGINE*2 scan window
  const base = SECONDS * 1000 - total * 60_000;
  for (let i = 0; i < total; i++) {
    const id = `conv-${String(i).padStart(3, '0')}`;
    writeFileSync(join(dir, `${id}.meta`), JSON.stringify({ cwd: `/work/${id}` }));
    const db = join(dir, `${id}.db`);
    writeFileSync(db, '');
    const at = new Date(base + i * 60_000);
    utimesSync(db, at, at);
  }

  const { inventory } = await import('../packages/connect/src/inventory.js');
  const rows = (await inventory([{ id: 'agym', engine: 'antigravity', env: { GEMINI_HOME: home } }]))
    .filter((r) => r.engine === 'antigravity');
  assert.equal(rows.length, 40, 'only PER_ENGINE conversations are listed');
  assert.equal(rows[0].id, 'conv-089', 'the newest conversation leads the list');
  assert.equal(rows.at(-1).id, 'conv-050', 'the cut keeps the newest 40');
  assert.ok(!rows.some((r) => r.id === 'conv-049'), 'older conversations stay out');
});

test('a Claude chat helm started is named for what the owner typed, not helm\'s note', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-claude-home-'));
  const dir = join(home, 'projects', '-work-app');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '11111111-1111-4111-8111-111111111111.jsonl'), [
    { type: 'user', cwd: '/work/app', message: { role: 'user', content: '[helm delegation: CLI accounts: claudea (claude, authenticated).]\n\nFix the settings icon' } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  const { inventory } = await import('../packages/connect/src/inventory.js');
  const rows = await inventory([{ id: 'claudex', engine: 'claude', env: { CLAUDE_CONFIG_DIR: home } }]);
  assert.equal(rows.find((r) => r.cwd === '/work/app')?.title, 'Fix the settings icon');
});

// ------------------------------------------------------------ CLI titles

test('a Claude session is named by the title the CLI wrote, and a /rename outranks it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-claude-title-'));
  const dir = join(home, 'projects', '-work-app');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, '22222222-2222-4222-8222-222222222222.jsonl');
  const line = (o) => JSON.stringify(o) + '\n';
  // The title comes after the whole first turn, well past the head lines
  // inventory reads for the folder and the opening prompt.
  let body = line({ type: 'user', cwd: '/work/app', message: { role: 'user', content: 'make the settings icon bigger please' } });
  for (let i = 0; i < 60; i++) {
    body += line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: `echo ${i}` } }] } });
    body += line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } });
  }
  writeFileSync(file, body);
  const { inventory } = await import('../packages/connect/src/inventory.js');
  const profiles = [{ id: 'claudex', engine: 'claude', env: { CLAUDE_CONFIG_DIR: home } }];
  const before = (await inventory(profiles)).find((r) => r.cwd === '/work/app');
  assert.equal(before.title, 'make the settings icon bigger please');
  assert.equal(before.named, false);

  // The CLI names it after the first reply; only the new bytes are read.
  writeFileSync(file, body + line({ type: 'ai-title', aiTitle: 'Bigger settings icon', sessionId: '22222222-2222-4222-8222-222222222222' }), { flag: 'a' });
  const named = (await inventory(profiles)).find((r) => r.cwd === '/work/app');
  assert.equal(named.title, 'Bigger settings icon');
  assert.equal(named.named, true);

  writeFileSync(file, line({ type: 'custom-title', customTitle: 'Settings icon work', sessionId: '22222222-2222-4222-8222-222222222222' }), { flag: 'a' });
  const renamed = (await inventory(profiles)).find((r) => r.cwd === '/work/app');
  assert.equal(renamed.title, 'Settings icon work');
});

test('Codex threads take the name from the state database, else a title made of the opening prompt', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-codex-names-'));
  const dir = join(home, 'sessions', '2026', '10', '05');
  mkdirSync(dir, { recursive: true });
  const rollout = (id) => {
    writeFileSync(join(dir, `rollout-${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/work/app', thread_source: 'user' } }) + '\n');
  };
  rollout('01a0ffff-0000-7000-8000-000000000001');
  rollout('01a0ffff-0000-7000-8000-000000000002');
  rollout('01a0ffff-0000-7000-8000-000000000003');
  rollout('01a0ffff-0000-7000-8000-000000000004');
  // The old index names one thread; the database names another and holds
  // the opening prompt of a third. The fourth has neither.
  writeFileSync(join(home, 'session_index.jsonl'),
    JSON.stringify({ id: '01a0ffff-0000-7000-8000-000000000001', thread_name: 'Index name' }) + '\n');
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT NOT NULL DEFAULT '', first_user_message TEXT NOT NULL DEFAULT '')`);
  const ins = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)');
  ins.run('01a0ffff-0000-7000-8000-000000000002', 'Database name', 'can you rename the branch', 'can you rename the branch');
  ins.run('01a0ffff-0000-7000-8000-000000000003', null, 'hey, could you please fix the login redirect loop', 'hey, could you please fix the login redirect loop');
  db.close();
  const { inventory } = await import('../packages/connect/src/inventory.js');
  const rows = await inventory([{ id: 'codexx', engine: 'codex', env: { CODEX_HOME: home } }]);
  const by = (id) => rows.find((r) => r.id === id);
  assert.equal(by('01a0ffff-0000-7000-8000-000000000001').title, 'Index name');
  assert.equal(by('01a0ffff-0000-7000-8000-000000000001').named, true);
  assert.equal(by('01a0ffff-0000-7000-8000-000000000002').title, 'Database name');
  assert.equal(by('01a0ffff-0000-7000-8000-000000000003').title, 'fix the login redirect loop');
  assert.equal(by('01a0ffff-0000-7000-8000-000000000003').named, false);
  assert.equal(by('01a0ffff-0000-7000-8000-000000000004').title, 'app');
});

test('scratch folders are the temp dir and folders named as scratch pads', async () => {
  const { isScratch } = await import('../packages/connect/src/inventory.js');
  assert.equal(isScratch(join(tmpdir(), 'clsteer')), true);
  assert.equal(isScratch('/tmp'), true);
  assert.equal(isScratch('~/helm-limits-scratch'), true);
  assert.equal(isScratch('~/hsb-scratch'), true);
  assert.equal(isScratch('~/sandbox/thing'), true);
  assert.equal(isScratch('~/dev/me/github/helm'), false);
  assert.equal(isScratch('~/dev/raza/riverside/Riverside-Park-Capital'), false);
  assert.equal(isScratch('~/dev/temp-monitor'), false);
  assert.equal(isScratch(''), false);
});
