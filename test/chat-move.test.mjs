import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = mkdtempSync(join(process.cwd(), '.helm-chat-move-'));
process.env.HELM_DIR = join(root, 'helm');
test.after(() => rmSync(root, { recursive: true, force: true }));

const { ChatMoves, claudeKey, moveRecord } = await import('../packages/connect/src/chat-move.js');
const { M } = await import('@helm/protocol');

const sourceId = 'aa11';
const targetId = 'bb22';
const machines = { [sourceId]: { id: sourceId, name: 'Laptop' }, [targetId]: { id: targetId, name: 'VM' } };
const OLD = '11111111-2222-4333-8444-555555555555';
let sequence = 0;

/** A send engine that copies at once, and fails the sends a test asks it to. */
function fakeSend({ fail = () => false } = {}) {
  const jobs = new Map();
  const engine = {
    started: [],
    prior: () => null,
    start({ path, destination, internal }) {
      const id = String(++sequence).padStart(24, '0');
      engine.started.push({ path, destination, internal });
      const job = { id, phase: 'done', error: null, target: { path: destination }, bytes: { sent: 1, total: 1 } };
      if (fail({ path, destination })) Object.assign(job, { phase: 'failed', error: 'link lost' });
      else cpSync(path, destination, { recursive: true });
      jobs.set(id, { job, path, destination });
      return { job };
    },
    status: ({ jobId }) => { if (!jobs.has(jobId)) throw new Error('send job not found'); return { job: jobs.get(jobId).job }; },
    retry({ jobId }) {
      const r = jobs.get(jobId);
      cpSync(r.path, r.destination, { recursive: true });
      Object.assign(r.job, { phase: 'done', error: null });
      return { job: r.job };
    },
    wait: async (id) => jobs.get(id).job,
  };
  return engine;
}

function fakeSessions(list) {
  const index = new Map(list.map((s) => [s.id, s]));
  return {
    index, resumed: [],
    get(id) { if (!index.has(id)) throw new Error('no such session'); return index.get(id); },
    setMove(id, fields) { Object.assign(this.get(id), fields); for (const k of Object.keys(fields)) if (!fields[k]) delete index.get(id)[k]; },
    archive(id) { this.get(id).archived = true; },
    async resumeExternal(options) {
      this.resumed.push(options);
      const s = { ...options, engineSessionId: options.id, id: `moved${this.resumed.length}` };
      index.set(s.id, s);
      return s;
    },
  };
}

function fixture({ engine = 'claude', fail } = {}) {
  const dir = join(root, `case-${++sequence}`);
  const project = join(dir, 'laptop', 'work', 'app');
  const sourceHome = join(dir, 'laptop', engine);
  const targetHome = join(dir, 'vm', engine);
  const targetFolder = join(dir, 'vm', 'work', 'app');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'main.js'), 'console.log(1)\n');
  const records = engine === 'claude'
    ? [{ type: 'user', sessionId: OLD, cwd: project, message: { content: `look at ${project}/main.js` } },
      { type: 'assistant', sessionId: OLD, cwd: project, message: { content: [{ type: 'thinking', thinking: `${project} is the app`, signature: 'sig' }] } }]
    : [{ type: 'session_meta', payload: { id: OLD, session_id: OLD, cwd: project, runtime_workspace_roots: [project] } },
      { type: 'turn_context', payload: { cwd: project } }];
  let conversation;
  if (engine === 'claude') {
    const folder = join(sourceHome, 'projects', claudeKey(project));
    mkdirSync(join(folder, OLD, 'subagents'), { recursive: true });
    conversation = join(folder, `${OLD}.jsonl`);
    writeFileSync(join(folder, OLD, 'subagents', 'agent-1.jsonl'), `${JSON.stringify({ sessionId: OLD, cwd: project })}\n`);
  } else {
    const folder = join(sourceHome, 'sessions', '2026', '10', '30');
    mkdirSync(folder, { recursive: true });
    conversation = join(folder, `rollout-2026-10-30T00-36-37-${OLD}.jsonl`);
  }
  writeFileSync(conversation, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  const homeEnv = engine === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  const source = fakeSessions([{ id: 'chat1', engine, engineSessionId: OLD, cwd: project, title: '#1-40', status: 'idle', profileId: 'mine' }]);
  const target = fakeSessions([]);
  const targetMoves = new ChatMoves({ sessions: target, sendEngine: fakeSend(), directory: join(dir, 'vm-moves'),
    network: () => ({ self: targetId, machines, revoked: {}, devices: {} }),
    profiles: async () => [{ id: 'theirs', engine, env: { [homeEnv]: targetHome } }],
    rpc: async () => { throw new Error('the target calls nobody'); } });
  const calls = [];
  const rpc = async (env, method, params) => {
    calls.push(method);
    assert.equal(env, targetId);
    if (method === M.AGENT_LIST) return { agents: [{ id: 'theirs', engine, available: true }] };
    if (method === M.FS_LIST) throw new Error('ENOENT: no such file or directory');
    if (method === M.CHAT_ADOPT) return targetMoves.adopt(params, sourceId);
    throw new Error(`unexpected ${method}`);
  };
  const sendEngine = fakeSend({ fail });
  const options = { sessions: source, sendEngine, rpc, directory: join(dir, 'laptop-moves'),
    network: () => ({ self: sourceId, machines, revoked: {}, devices: { phone: {} } }),
    profiles: async () => [{ id: 'mine', engine, env: { [homeEnv]: sourceHome } }] };
  const moves = new ChatMoves(options);
  const params = { moveId: (++sequence).toString(16).padStart(24, 'a'), sessionId: 'chat1', targetMachineId: targetId,
    profileId: 'theirs', targetFolder };
  return { moves, options, params, source, target, project, targetFolder, targetHome, sendEngine, calls };
}

const lines = (file) => readFileSync(file, 'utf8').trim().split('\n').map((x) => JSON.parse(x));

test('a moved record gets the new id and folder, and its words stay byte for byte', () => {
  const text = JSON.stringify({ sessionId: 'old', cwd: '/a/app/src', message: { text: 'old /a/app' }, roots: ['/a/app'], workspace_roots: ['/a/app', '/elsewhere'] });
  const moved = JSON.parse(moveRecord(text, { oldId: 'old', newId: 'new', from: '/a/app', to: '/b/app' }));
  assert.deepEqual(moved, { sessionId: 'new', cwd: '/b/app/src', message: { text: 'old /a/app' }, roots: ['/b/app'], workspace_roots: ['/b/app', '/elsewhere'] });
  assert.equal(moveRecord('not json', { oldId: 'old', newId: 'new', from: '/a', to: '/b' }), 'not json');
  // A sibling folder that only starts with the same letters is not inside it.
  assert.equal(JSON.parse(moveRecord(JSON.stringify({ cwd: '/a/app2' }), { oldId: 'x', newId: 'y', from: '/a/app', to: '/b' })).cwd, '/a/app2');
});

test('a Claude chat moves with its whole conversation and the old chat closes', async () => {
  const f = fixture();
  const started = await f.moves.move(f.params, 'phone');
  assert.equal(started.phase, 'copying-project');
  assert.equal(f.source.get('chat1').moving.machineName, 'VM');
  await f.moves.running.get(f.params.moveId);
  const done = f.moves.status({ moveId: f.params.moveId }, 'phone');
  assert.equal(done.phase, 'done', done.error);
  assert.equal(done.sessionId, 'moved1');
  assert.equal(readFileSync(join(f.targetFolder, 'main.js'), 'utf8'), 'console.log(1)\n');
  // Both copies are steps of the move, not Sends of their own in the app.
  assert.deepEqual(f.sendEngine.started.map((x) => x.internal), [true, true]);

  const [opened] = f.target.resumed;
  assert.deepEqual({ ...opened, id: undefined }, { engine: 'claude', account: 'theirs', id: undefined, cwd: f.targetFolder, title: '#1-40' });
  assert.notEqual(opened.id, OLD);
  const folder = join(f.targetHome, 'projects', claudeKey(f.targetFolder));
  const [said, thought] = lines(join(folder, `${opened.id}.jsonl`));
  assert.equal(said.sessionId, opened.id);
  assert.equal(said.cwd, f.targetFolder);
  assert.equal(said.message.content, `look at ${f.project}/main.js`);
  assert.equal(thought.message.content[0].thinking, `${f.project} is the app`);
  assert.equal(lines(join(folder, opened.id, 'subagents', 'agent-1.jsonl'))[0].sessionId, opened.id);
  assert.equal(f.target.get('moved1').movedFrom.machineName, 'Laptop');

  const old = f.source.get('chat1');
  assert.equal(old.moving, undefined);
  assert.deepEqual({ ...old.movedAway, at: 0 }, { machineId: targetId, machineName: 'VM', sessionId: 'moved1', at: 0 });
  assert.equal(old.archived, true);
  assert.equal(existsSync(join(process.env.HELM_DIR, 'incoming-chats', f.params.moveId)), false, 'the staging folder is cleaned up');
  await assert.rejects(f.moves.move({ ...f.params, moveId: 'f'.repeat(24) }, 'phone'), /already moved to VM/);
});

test('a Codex chat keeps its date folders under the new id', async () => {
  const f = fixture({ engine: 'codex' });
  await f.moves.move(f.params, 'phone');
  await f.moves.running.get(f.params.moveId);
  const { id } = f.target.resumed[0];
  const file = join(f.targetHome, 'sessions', '2026', '10', '30', `rollout-2026-10-30T00-36-37-${id}.jsonl`);
  const [meta, context] = lines(file);
  assert.deepEqual(meta.payload, { id, session_id: id, cwd: f.targetFolder, runtime_workspace_roots: [f.targetFolder] });
  assert.equal(context.payload.cwd, f.targetFolder);
});

test('a move waits for the reply to end and refuses what cannot move', async () => {
  const f = fixture();
  f.source.get('chat1').status = 'working';
  await assert.rejects(f.moves.move(f.params, 'phone'), /Wait for the reply to finish/);
  f.source.get('chat1').status = 'idle';
  await assert.rejects(f.moves.move(f.params, 'stranger'), /paired device/);
  await assert.rejects(f.moves.move({ ...f.params, targetMachineId: sourceId }, 'phone'), /another machine/);
  await assert.rejects(f.moves.move({ ...f.params, profileId: 'nobody' }, 'phone'), /signed-in Claude Code account on VM/);
  f.source.get('chat1').engine = 'devin';
  await assert.rejects(f.moves.move(f.params, 'phone'), /Only Claude and Codex/);
  await assert.rejects(f.moves.adopt({ moveId: f.params.moveId, step: 'prepare' }, 'phone'), /another machine in this network/);
  assert.deepEqual(f.calls.filter((m) => m === M.CHAT_ADOPT), []);
});

test('a failed copy leaves the chat usable, and a retry finishes the move', async () => {
  let failures = 1;
  const f = fixture({ fail: ({ destination }) => destination.includes('incoming-chats') && failures-- > 0 });
  await f.moves.move(f.params, 'phone');
  await f.moves.running.get(f.params.moveId);
  const failed = f.moves.status({ moveId: f.params.moveId }, 'phone');
  assert.equal(failed.phase, 'failed');
  assert.match(failed.error, /link lost/);
  assert.equal(f.source.get('chat1').moving, undefined, 'the owner can keep chatting here');

  const again = await f.moves.move({ ...f.params, retry: true }, 'phone');
  assert.equal(again.phase, 'copying-project');
  await f.moves.running.get(f.params.moveId);
  assert.equal(f.moves.status({ moveId: f.params.moveId }, 'phone').phase, 'done');
  assert.equal(f.source.get('chat1').movedAway.machineName, 'VM');
  assert.equal(f.target.resumed.length, 1);
});

test('a restart finishes a move that was opening', async () => {
  const f = fixture();
  await f.moves.move(f.params, 'phone');
  await f.moves.running.get(f.params.moveId);
  // As if the daemon stopped after the target opened the chat but before the
  // old one was marked: the saved record is done, the old chat is not.
  f.source.setMove('chat1', { movedAway: null });
  f.source.get('chat1').archived = false;
  const restarted = new ChatMoves(f.options);
  restarted.start();
  await restarted.running.get(f.params.moveId);
  assert.equal(f.source.get('chat1').movedAway.sessionId, 'moved1');
  assert.equal(f.source.get('chat1').archived, true);
});
