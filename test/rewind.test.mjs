import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, symlinkSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolation is established BEFORE importing any Helm module, including drivers.
const home = mkdtempSync(join(tmpdir(), 'helm-rewind-'));
Object.assign(process.env, { HELM_DIR: home, HELM_DB: join(home, 'db'), HELM_SSH_DIR: join(home, 'ssh'),
  HELM_PROCS_SOCKET: join(home, 'procs.sock'), HELM_TERMINALS_SOCKET: join(home, 'terminals.sock'),
  HELM_NATIVE_SOCKET: join(home, 'native.sock'), HELM_NO_SERVICE: '1',
  CODEX_HOME: join(home, 'codex'), CLAUDE_CONFIG_DIR: join(home, 'claude') });
const { Sessions, wire } = await import('../packages/connect/src/sessions.js');
const { EventLog } = await import('../packages/connect/src/events.js');
const { captureFiles, restoreFiles } = await import('../packages/connect/src/checkpoints/files.js');
const { Checkpoints } = await import('../packages/connect/src/checkpoints/store.js');
const { stageCodexRewind } = await import('../packages/connect/src/drivers/rewind.js');
const { CodexDriver } = await import('../packages/connect/src/drivers/codex.js');
const { ClaudeDriver } = await import('../packages/connect/src/drivers/claude.js');
const { apply, emptyLog } = await import('../apps/web/src/session/types.ts');

writeFileSync(join(home, 'profiles.json'), JSON.stringify({ version: 1, profiles: [
  { id: 'claude', label: 'test', engine: 'claude', cmd: 'fake', args: [], env: { CLAUDE_CONFIG_DIR: join(home, 'claude') }, source: 'alias' },
  { id: 'codex', label: 'test', engine: 'codex', cmd: 'fake', args: [], env: { CODEX_HOME: join(home, 'codex') }, source: 'alias' },
  { id: 'pi', label: 'test', engine: 'pi', cmd: 'fake', args: [], env: {}, source: 'alias' },
] }));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
let fixture = 0;
function repo() {
  const main = join(home, `repo-${++fixture}`), cwd = join(home, `tree-${fixture}`);
  mkdirSync(main); git(main, 'init', '-q'); git(main, 'config', 'user.email', 'test@example.invalid'); git(main, 'config', 'user.name', 'Test');
  writeFileSync(join(main, 'file'), 'base'); writeFileSync(join(main, '.gitignore'), 'ignored\n');
  git(main, 'add', '.'); git(main, 'commit', '-qm', 'base'); git(main, 'worktree', 'add', '-qb', `test-${fixture}`, cwd);
  return { main, cwd };
}
class Runtime extends EventEmitter { async listLive() { return new Map(); } async read() { return { text: '' }; } watch() {} }
class Host extends EventEmitter { hasProc() { return false; } async list() { return []; } nativeSessions() { return []; } async ensure() { return false; } has() { return false; } }
class FakeDriver extends EventEmitter {
  static made = [];
  constructor(opts) { super(); Object.assign(this, opts); this.engineSessionId ??= `provider-${FakeDriver.made.length}`; this.status = 'idle'; this.pending = new Map(); FakeDriver.made.push(this); }
  async start() {}
  push(type, payload) { if (type === 'status') this.status = payload.status; this.emit('event', { type, ...payload }); }
  async send(text) {
    this.push('status', { status: 'working' });
    this.turnId = `turn-${FakeDriver.made.indexOf(this)}-${(this.count = (this.count ?? 0) + 1)}`;
    this.push('turn.start', { turnId: this.turnId, text });
    this.push('turn.done', { turnId: this.turnId, status: 'ok', resumeAt: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    this.push('status', { status: 'idle' });
  }
  async sendWithAttachments(text) { return this.send(text); }
  async prepareRewind(boundary) { this.boundary = boundary; if (this.fail) throw new Error('provider failed'); await this.pause; return { engineSessionId: `rewound-${this.engineSessionId}`, transcript: null, unsent: boundary.first }; }
  async validateRewind() { if (FakeDriver.failValidation) throw new Error('candidate failed'); }
  async kill() { this.killed = true; }
}
const managers = [];
test.after(async () => { await Promise.all(managers.map(s => s.stop())); rmSync(home, { recursive: true, force: true }); });
function manager() {
  if (managers.length) return managers[0];
  const sessions = new Sessions(new Runtime(), { events: new EventLog(join(home, `events-${++fixture}`)), procHost: new Host(), terminals: new Host(), nativeHost: new Host(), nativeDiscovery: false,
    makeDriver: (_engine, opts) => new FakeDriver(opts) });
  managers.push(sessions); return sessions;
}
async function conversation(cwd, engine = 'claude') {
  const sessions = manager(), s = await sessions.start({ cwd, profileId: engine });
  await sessions.input(s.id, 'first', { attachments: [{ filename: 'photo.png', mime: 'image/png', data: Buffer.from('photo').toString('base64') }] });
  const d = FakeDriver.made.at(-1), first = d.turnId;
  writeFileSync(join(cwd, 'file'), 'after first');
  await sessions.input(s.id, 'second');
  const second = d.turnId;
  writeFileSync(join(cwd, 'file'), 'after second'); writeFileSync(join(cwd, 'new'), 'new');
  return { sessions, s, d, first, second };
}

test('capture and restore preserve staged/unstaged bytes, untracked files, symlinks, modes and ignored files', () => {
  const { cwd } = repo(), snapshot = join(home, 'raw');
  writeFileSync(join(cwd, 'file'), 'staged'); git(cwd, 'add', 'file'); writeFileSync(join(cwd, 'file'), 'unstaged');
  writeFileSync(join(cwd, 'untracked'), 'before', { mode: 0o755 }); symlinkSync('file', join(cwd, 'link'));
  writeFileSync(join(cwd, 'ignored'), 'secret'); const status = git(cwd, 'status', '--porcelain');
  captureFiles(cwd, snapshot);
  writeFileSync(join(cwd, 'file'), 'later'); git(cwd, 'add', 'file'); rmSync(join(cwd, 'untracked')); writeFileSync(join(cwd, 'added'), 'later');
  restoreFiles(cwd, snapshot);
  assert.equal(readFileSync(join(cwd, 'file'), 'utf8'), 'unstaged'); assert.equal(git(cwd, 'show', ':file'), 'staged');
  assert.equal(readFileSync(join(cwd, 'ignored'), 'utf8'), 'secret'); assert.equal(git(cwd, 'status', '--porcelain'), status);
  assert.equal(statSync(join(cwd, 'untracked')).mode & 0o777, 0o755); assert.equal(existsSync(join(cwd, 'added')), false);
});

test('main checkout, changed HEAD, symlink parents and ignored collisions are refused before mutation', () => {
  const { main, cwd } = repo(), snapshot = join(home, 'refusals');
  assert.throws(() => captureFiles(main, snapshot), /main checkout/);
  mkdirSync(join(cwd, 'dir')); writeFileSync(join(cwd, 'dir', 'child'), 'safe'); captureFiles(cwd, snapshot);
  rmSync(join(cwd, 'dir'), { recursive: true }); const outside = join(home, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'child'), 'untouched'); symlinkSync(outside, join(cwd, 'dir'));
  assert.throws(() => restoreFiles(cwd, snapshot), /Unsafe checkpoint parent/); assert.equal(readFileSync(join(outside, 'child'), 'utf8'), 'untouched');
  rmSync(join(cwd, 'dir')); mkdirSync(join(cwd, 'dir')); writeFileSync(join(cwd, 'dir', 'child'), 'other');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'new head'); assert.throws(() => restoreFiles(cwd, snapshot), /HEAD changed/);
});

test('conversation-only rewind leaves files intact, restores exact draft attachments, and clears stale clients', async () => {
  const { cwd } = repo(), { sessions, s, d, first } = await conversation(cwd);
  const old = sessions.events.since(s.id), cached = emptyLog(); old.forEach(e => apply(cached, e));
  const result = await sessions.rewind(s.id, first);
  assert.equal(readFileSync(join(cwd, 'file'), 'utf8'), 'after second'); assert.equal(result.draft.text, 'first');
  assert.equal(Buffer.from(result.draft.attachments[0].data, 'base64').toString(), 'photo'); assert.equal(d.boundary.first, true);
  assert.notEqual(result.session.engineSessionId, d.engineSessionId); assert.equal(d.killed, true);
  const current = sessions.events.since(s.id); current.forEach(e => apply(cached, e)); assert.equal(cached.turns.length, 0);
  assert.ok(current[0].seq > old.at(-1).seq); assert.equal(current[0].type, 'history.reset');
  assert.ok(sessions.events.window(s.id, { since: old.at(-1).seq }).logFirst > old.at(-1).seq + 1, 'older cached clients must reload a fresh history window');
  const archive = join(sessions.checkpoints.path(result.recoveryId), 'recovery.json');
  assert.equal(statSync(archive).mode & 0o777, 0o600); assert.equal(statSync(sessions.checkpoints.path(result.recoveryId)).mode & 0o777, 0o700);
  assert.ok(JSON.parse(readFileSync(archive)).events.some(e => e.text === 'second'));
});

test('file rewind restores the checkpoint BEFORE the selected turn and keeps earlier conversation', async () => {
  const { cwd } = repo(), { sessions, s, d, second } = await conversation(cwd);
  assert.equal((await sessions.rewindCheck(s.id, second)).restoreFiles, true);
  const result = await sessions.rewind(s.id, second, { restoreFiles: true });
  assert.equal(readFileSync(join(cwd, 'file'), 'utf8'), 'after first'); assert.equal(existsSync(join(cwd, 'new')), false);
  assert.equal(result.draft.text, 'second'); assert.equal(d.boundary.resumeAt, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const log = emptyLog(); sessions.events.since(s.id).forEach(e => apply(log, e)); assert.equal(log.turns.length, 1); assert.equal(log.turns[0].text, 'first');
  await sessions.rewind(s.id, log.turns[0].id, { restoreFiles: true }); assert.equal(readFileSync(join(cwd, 'file'), 'utf8'), 'base');
});

test('shared workspaces, alias paths, descendants, busy sessions and unsupported providers refuse rewind safely', async () => {
  const { cwd } = repo(), { sessions, s, d, second } = await conversation(cwd);
  const nested = join(cwd, 'nested'); mkdirSync(nested); const alias = join(home, `alias-${fixture}`); symlinkSync(nested, alias);
  await sessions.start({ cwd: alias, profileId: 'claude' });
  await assert.rejects(sessions.rewind(s.id, second, { restoreFiles: true }), /shared/);
  assert.equal((await sessions.rewindCheck(s.id, second)).restoreFiles, false); assert.equal(d.boundary, undefined);
  d.push('status', { status: 'working' }); await assert.rejects(sessions.rewind(s.id, second), /finish/); d.push('status', { status: 'idle' });
  s.nativeAgents = { child: 'working' }; await assert.rejects(sessions.rewind(s.id, second), /descendants/); delete s.nativeAgents;
  const pi = await sessions.start({ cwd, profileId: 'pi' }); assert.equal(wire(pi).rewindSupported, false);
  await assert.rejects(sessions.rewind(pi.id, 'missing'), /does not support/);
  await sessions.rewind(s.id, second); // shared files do not block conversation-only rewind
});

test('provider preparation and candidate validation failures leave files, history and session unchanged', async () => {
  const { cwd } = repo(), { sessions, s, d, second } = await conversation(cwd);
  const state = JSON.stringify(s), events = JSON.stringify(sessions.events.tail(s.id, 0));
  d.fail = true; await assert.rejects(sessions.rewind(s.id, second, { restoreFiles: true }), /provider failed/); d.fail = false;
  FakeDriver.failValidation = true;
  try { await assert.rejects(sessions.rewind(s.id, second, { restoreFiles: true }), /candidate failed/); } finally { FakeDriver.failValidation = false; }
  assert.equal(JSON.stringify(s), state); assert.equal(JSON.stringify(sessions.events.tail(s.id, 0)), events); assert.equal(readFileSync(join(cwd, 'file'), 'utf8'), 'after second'); assert.equal(d.killed, undefined);
});

test('publication failure rolls files and history back, retaining the original provider', async () => {
  const { cwd } = repo(), { sessions, s, d, second } = await conversation(cwd);
  const state = JSON.stringify(s), history = JSON.stringify(sessions.events.tail(s.id, 0));
  const rewind = sessions.events.rewind; sessions.events.rewind = () => { throw new Error('disk failed'); };
  await assert.rejects(sessions.rewind(s.id, second, { restoreFiles: true }), /disk failed/); sessions.events.rewind = rewind;
  assert.equal(readFileSync(join(cwd, 'file'), 'utf8'), 'after second'); assert.equal(readFileSync(join(cwd, 'new'), 'utf8'), 'new');
  assert.equal(JSON.stringify(s), state); assert.equal(JSON.stringify(sessions.events.tail(s.id, 0)), history); assert.equal(d.killed, undefined);
});

test('workspace lock blocks new turns and sessions while provider preparation awaits', async () => {
  const { cwd } = repo(), { sessions, s, d, second } = await conversation(cwd);
  let release; d.pause = new Promise(resolve => { release = resolve; });
  const rewinding = sessions.rewind(s.id, second, { restoreFiles: true });
  await new Promise(setImmediate);
  await assert.rejects(sessions.input(s.id, 'race'), /being rewound/);
  await assert.rejects(sessions.start({ cwd, profileId: 'claude' }), /being restored/);
  await assert.rejects(sessions.rewind(s.id, second), /being rewound/);
  release(); await rewinding;
});

test('applying journal recovers files, provider identity and history before restart reconnects', async () => {
  const { cwd } = repo(), { sessions, s } = await conversation(cwd);
  const state = JSON.parse(JSON.stringify(s)), history = JSON.parse(JSON.stringify(sessions.events.tail(s.id, 0)));
  const id = await sessions.checkpoints.archive(s, sessions.events, true), path = sessions.checkpoints.path(id);
  const recovery = JSON.parse(readFileSync(join(path, 'recovery.json')));
  sessions.checkpoints.write(id, 'recovery.json', { ...recovery, phase: 'applying' });
  writeFileSync(join(cwd, 'file'), 'partial rewind'); sessions.events.replace(s.id, [{ type: 'history.reset', seq: 1000, at: 1 }]);
  const index = new Map([[s.id, { ...s, engineSessionId: 'wrong' }]]);
  const store = new Checkpoints();
  assert.deepEqual(store.recover(sessions.events, index), [id]);
  assert.equal(readFileSync(join(cwd, 'file'), 'utf8'), 'after second'); assert.deepEqual(index.get(s.id), state); assert.deepEqual(sessions.events.tail(s.id, 0), history);
  store.finishRecovery([id]); assert.deepEqual(store.recover(sessions.events, index), []);
});

test('Codex stages fork/resume/revert on the copy, with an explicit legacy fallback and no timeout retry', async () => {
  const calls = []; const call = async (method, params) => { calls.push({ method, params }); return method === 'thread/fork' ? { thread: { id: 'copy' } } : {}; };
  assert.equal((await stageCodexRewind(call, 'original', 'turn-2')).engineSessionId, 'copy');
  assert.deepEqual(calls.map(c => c.method), ['thread/fork', 'thread/resume', 'thread/revert']); assert.equal(calls.at(-1).params.threadId, 'copy');
  const legacy = [];
  await stageCodexRewind(async (method, params) => { legacy.push(method); if (method === 'thread/fork') return { thread: { id: 'copy' } }; if (method === 'thread/revert') throw Object.assign(new Error('unknown'), { code: -32601 }); if (method === 'thread/read') return { thread: { turns: [{ id: 'one' }, { id: 'two' }] } }; if (method === 'thread/rollback') assert.equal(params.numTurns, 1); return {}; }, 'original', 'two');
  assert.ok(legacy.includes('thread/rollback'));
  const timeout = [];
  await assert.rejects(stageCodexRewind(async method => { timeout.push(method); if (method === 'thread/fork') return { thread: { id: 'copy' } }; if (method === 'thread/revert') throw new Error('timed out'); return {}; }, 'original', 'two'), /timed out/);
  assert.deepEqual(timeout, ['thread/fork', 'thread/resume', 'thread/revert']);
});

test('Claude adapter forks at a validated assistant boundary and starts fresh before the first turn', async () => {
  const d = new ClaudeDriver({ engineSessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', cmd: 'fake', cwd: home, env: {}, args: [] });
  const options = await d.prepareRewind({ first: false, resumeAt: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  const candidate = new ClaudeDriver({ ...d, args: [], ...options });
  assert.ok(candidate.args.includes('--fork-session')); assert.ok(candidate.args.includes('--resume-session-at=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
  assert.notEqual(candidate.engineSessionId, d.engineSessionId);
  assert.equal((await d.prepareRewind({ first: true })).forkFrom, null); await assert.rejects(d.prepareRewind({ first: false, resumeAt: 'bad' }), /boundary/);
});

test('partial file restore failure rolls back actual files and index and leaves provider conversation selected', async () => {
  const { cwd } = repo(), { sessions, s, d, second } = await conversation(cwd);
  writeFileSync(join(cwd, 'file'), 'staged later'); git(cwd, 'add', 'file'); writeFileSync(join(cwd, 'file'), 'unstaged later');
  const identity = s.engineSessionId, status = git(cwd, 'status', '--porcelain'), history = JSON.stringify(sessions.events.tail(s.id, 0));
  const restore = sessions.checkpoints.restore.bind(sessions.checkpoints);
  let fail = true;
  sessions.checkpoints.restore = (cwd, directory, options) => {
    restore(cwd, directory, options);
    if (fail) { fail = false; throw new Error('file restore failed after writes'); }
  };
  try { await assert.rejects(sessions.rewind(s.id, second, { restoreFiles: true }), /file restore failed/); }
  finally { sessions.checkpoints.restore = restore; }
  assert.equal(s.engineSessionId, identity); assert.equal(d.killed, undefined); assert.equal(JSON.stringify(sessions.events.tail(s.id, 0)), history);
  assert.equal(readFileSync(join(cwd, 'file'), 'utf8'), 'unstaged later'); assert.equal(git(cwd, 'show', ':file'), 'staged later');
  assert.equal(git(cwd, 'status', '--porcelain'), status);
  await sessions.input(s.id, 'continue'); assert.equal(s.engineSessionId, identity);
});

test('provider activity during rewind preparation aborts without losing new history', async () => {
  const { cwd } = repo(), { sessions, s, d, second } = await conversation(cwd);
  let release; d.pause = new Promise(resolve => { release = resolve; });
  const rewinding = sessions.rewind(s.id, second, { restoreFiles: true }); await new Promise(setImmediate);
  d.push('turn.start', { turnId: 'wake-up', text: '', wake: true }); d.push('turn.done', { turnId: 'wake-up', status: 'ok' });
  release(); await assert.rejects(rewinding, /conversation changed/);
  assert.equal(readFileSync(join(cwd, 'file'), 'utf8'), 'after second'); assert.ok(sessions.events.tail(s.id, 0).some(e => e.turnId === 'wake-up'));
});

test('ignored collision and Git index lock are refused without deleting any workspace bytes', () => {
  const { cwd } = repo(), snapshot = join(home, 'ignored-check');
  writeFileSync(join(cwd, 'hidden'), 'snapshot'); captureFiles(cwd, snapshot);
  writeFileSync(join(cwd, '.gitignore'), 'hidden\nignored\n'); writeFileSync(join(cwd, 'hidden'), 'owner ignored edit');
  assert.throws(() => restoreFiles(cwd, snapshot), /ignored file/); assert.equal(readFileSync(join(cwd, 'hidden'), 'utf8'), 'owner ignored edit');
  writeFileSync(join(cwd, '.gitignore'), 'ignored\n');
  const dir = git(cwd, 'rev-parse', '--absolute-git-dir'); writeFileSync(join(dir, 'index.lock'), 'owner git lock');
  assert.throws(() => restoreFiles(cwd, snapshot), /Git is updating/); assert.equal(readFileSync(join(dir, 'index.lock'), 'utf8'), 'owner git lock'); rmSync(join(dir, 'index.lock'));
});

test('real Codex driver RPC rewinds only a forked provider conversation and preserves its source on revert failure', async () => {
  const directory = join(home, 'codex-rewind-rpc'); mkdirSync(directory);
  const state = join(directory, 'state.json'), command = join(directory, 'codex');
  writeFileSync(command, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-cli 0.156.0'); process.exit(0); }
const threads = { source: { id: 'source', turns: [{ id: 'one', status: 'completed', items: [{ type: 'userMessage', text: 'keep' }] }, { id: 'two', status: 'completed', items: [{ type: 'userMessage', text: 'discard' }] }], status: { type: 'idle' } } };
let copies = 0;
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line), p = request.params || {}; if (!request.id) return;
  let result = {}, error;
  if (request.method === 'thread/fork') { const thread = structuredClone(threads[p.threadId]); thread.id = 'copy-' + (++copies); threads[thread.id] = thread; result = { thread }; }
  else if (request.method === 'thread/resume' || request.method === 'thread/read') result = { thread: threads[p.threadId], model: 'test' };
  else if (request.method === 'thread/revert') { const thread = threads[p.threadId]; thread.turns = thread.turns.slice(0, thread.turns.findIndex(t => t.id === p.beforeTurnId)); if (p.beforeTurnId === 'fail') error = { message: 'provider failed after mutation' }; else result = { thread }; }
  fs.writeFileSync(process.env.TEST_REWIND_STATE, JSON.stringify(threads));
  console.log(JSON.stringify({ id: request.id, ...(error ? { error } : { result }) }));
});
`); chmodSync(command, 0o755);
  const opts = { cmd: command, env: { CODEX_HOME: directory, TEST_REWIND_STATE: state }, args: [], cwd: directory, mode: 'ask', engineSessionId: 'source' };
  const source = new CodexDriver(opts); let candidate;
  try {
    await source.start();
    const options = await source.prepareRewind({ turnId: 'two' }); candidate = new CodexDriver({ ...opts, ...options }); await candidate.validateRewind();
    const provider = JSON.parse(readFileSync(state));
    assert.deepEqual(provider.source.turns.map(t => t.id), ['one', 'two']);
    assert.deepEqual(provider[options.engineSessionId].turns.map(t => t.id), ['one']);
    await assert.rejects(source.prepareRewind({ turnId: 'fail' }), /failed after mutation/);
    assert.deepEqual(JSON.parse(readFileSync(state)).source.turns.map(t => t.id), ['one', 'two']);
    assert.equal(source.engineSessionId, 'source');
  } finally { await candidate?.kill(); await source.kill(); }
});

test('real Claude driver validates a forked conversation boundary before selecting it', async () => {
  const directory = join(home, 'claude-rewind-rpc'); mkdirSync(directory);
  const command = join(directory, 'claude'), state = join(directory, 'state.json');
  const sourceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', answer = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  writeFileSync(state, JSON.stringify({ [sourceId]: [{ text: 'keep', answer }, { text: 'discard', answer: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }] }));
  writeFileSync(command, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('2.1.260 (Claude Code)'); process.exit(0); }
const arg = key => process.argv.find(x => x.startsWith(key + '='))?.slice(key.length + 1);
const id = arg('--session-id'), source = arg('--resume'), boundary = arg('--resume-session-at');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.type !== 'control_request') return;
  const threads = JSON.parse(fs.readFileSync(process.env.TEST_REWIND_STATE));
  const index = (threads[source] || []).findIndex(turn => turn.answer === boundary);
  const error = source && index < 0 ? 'resume boundary missing' : null;
  if (!error) { threads[id] = source ? threads[source].slice(0, index + 1) : []; fs.writeFileSync(process.env.TEST_REWIND_STATE, JSON.stringify(threads)); }
  console.log(JSON.stringify({ type: 'control_response', response: { request_id: message.request_id, subtype: error ? 'error' : 'success', ...(error ? { error } : { response: {} }) } }));
});
process.stdin.on('end', () => process.exit(0));
`); chmodSync(command, 0o755);
  const opts = { cmd: command, env: { CLAUDE_CONFIG_DIR: directory, TEST_REWIND_STATE: state }, args: [], cwd: directory, mode: 'ask', engineSessionId: sourceId };
  const source = new ClaudeDriver(opts);
  const options = await source.prepareRewind({ first: false, resumeAt: answer });
  const candidate = new ClaudeDriver({ ...opts, ...options });
  try {
    await candidate.validateRewind(); const threads = JSON.parse(readFileSync(state));
    assert.deepEqual(threads[sourceId].map(t => t.text), ['keep', 'discard']); assert.deepEqual(threads[candidate.engineSessionId].map(t => t.text), ['keep']);
  } finally { await candidate.kill(); }
  const bad = new ClaudeDriver({ ...opts, ...(await source.prepareRewind({ first: false, resumeAt: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' })) });
  try { await assert.rejects(bad.validateRewind(), /boundary missing/); }
  finally { await bad.kill(); }
  assert.deepEqual(JSON.parse(readFileSync(state))[sourceId].map(t => t.text), ['keep', 'discard']);
});

test('damaged checkpoint bytes fail preflight without changing any worktree file', () => {
  const { cwd } = repo(), directory = join(home, 'damaged'); const snapshot = captureFiles(cwd, directory);
  const file = snapshot.files.find(file => file.name === 'file'); writeFileSync(join(directory, file.blob), 'damaged');
  writeFileSync(join(cwd, 'file'), 'owner edit');
  assert.throws(() => restoreFiles(cwd, directory), /damaged/); assert.equal(readFileSync(join(cwd, 'file'), 'utf8'), 'owner edit');
});

test('file recovery preserves edits made while provider preparation is pending', async () => {
  const { cwd } = repo(), { sessions, s, d, second } = await conversation(cwd);
  let release; d.pause = new Promise(resolve => { release = resolve; });
  const restore = sessions.checkpoints.restore.bind(sessions.checkpoints); let fail = true;
  sessions.checkpoints.restore = (cwd, directory, options) => {
    restore(cwd, directory, options);
    if (fail) { fail = false; throw new Error('partial restore failure'); }
  };
  try {
    const rewind = sessions.rewind(s.id, second, { restoreFiles: true });
    await new Promise(setImmediate);
    writeFileSync(join(cwd, 'file'), 'edit during preparation');
    release(); await assert.rejects(rewind, /partial restore failure/);
    assert.equal(readFileSync(join(cwd, 'file'), 'utf8'), 'edit during preparation');
  } finally { sessions.checkpoints.restore = restore; }
});

test('failed compensation closes the provider and blocks further workspace writes', async () => {
  const { cwd } = repo(), { sessions, s, d, second } = await conversation(cwd);
  const restore = sessions.checkpoints.restore;
  sessions.checkpoints.restore = () => { throw new Error('disk unavailable'); };
  try {
    await assert.rejects(sessions.rewind(s.id, second, { restoreFiles: true }), /recovery is required/);
    assert.equal(d.killed, true);
    await assert.rejects(sessions.input(s.id, 'unsafe continue'), /recovery must finish/);
    await assert.rejects(sessions.start({ cwd, profileId: 'claude' }), /being restored/);
    assert.equal(wire(s).rewindSupported, false);
  } finally {
    sessions.checkpoints.restore = restore;
    const index = new Map(); const recovered = sessions.checkpoints.recover(sessions.events, index);
    sessions.checkpoints.finishRecovery(recovered);
  }
});

test('worker file capture leaves the daemon event loop responsive and stores a stable snapshot', async () => {
  const { captureFilesAsync } = await import('../packages/connect/src/checkpoints/capture.js');
  const { cwd } = repo(), directory = join(home, 'worker-responsive');
  let responsive = false;
  const tick = new Promise(resolve => setTimeout(() => { responsive = true; resolve(); }, 0));
  const snapshot = await captureFilesAsync(cwd, directory);
  assert.equal(responsive, true); await tick;
  assert.equal(snapshot.root, cwd); assert.ok(snapshot.files >= 2);
  writeFileSync(join(cwd, 'file'), 'after capture'); restoreFiles(cwd, directory);
  assert.equal(readFileSync(join(cwd, 'file'), 'utf8'), 'base');
});

test('worker timeout falls back to conversation rewind without delaying or losing delivery', async () => {
  const { cwd } = repo(), sessions = manager(), s = await sessions.start({ cwd, profileId: 'claude' });
  const timeout = sessions.checkpoints.captureTimeoutMs;
  sessions.checkpoints.captureTimeoutMs = 0;
  const begin = Date.now();
  try { await sessions.input(s.id, 'capture timeout'); }
  finally { sessions.checkpoints.captureTimeoutMs = timeout; }
  const d = FakeDriver.made.at(-1), turn = sessions.events.tail(s.id, 0).findLast(e => e.type === 'turn.start' && e.checkpoint);
  assert.ok(Date.now() - begin < 2000);
  assert.equal(sessions.checkpoints.get(turn.checkpoint, s.id).files, false);
  const availability = await sessions.rewindCheck(s.id, d.turnId);
  assert.equal(availability.restoreFiles, false); assert.match(availability.reason, /timed out/);
  const result = await sessions.rewind(s.id, d.turnId);
  assert.equal(result.draft.text, 'capture timeout'); assert.equal(readFileSync(join(cwd, 'file'), 'utf8'), 'base');
});

test('provider changes during async capture prevent sending against a stale checkpoint', async () => {
  const { cwd } = repo(), sessions = manager(), s = await sessions.start({ cwd, profileId: 'claude' });
  const d = FakeDriver.made.at(-1), capture = sessions.checkpoints.capture.bind(sessions.checkpoints);
  let release; const gate = new Promise(resolve => { release = resolve; });
  sessions.checkpoints.capture = async (...args) => { await gate; return capture(...args); };
  const sending = sessions.input(s.id, 'stale capture'); await new Promise(setImmediate);
  d.push('turn.start', { turnId: 'wake-during-capture', text: '', wake: true });
  d.push('turn.done', { turnId: 'wake-during-capture', status: 'ok' });
  release();
  try { await assert.rejects(sending, /changed while checkpointing/); assert.equal(d.count, undefined); }
  finally { sessions.checkpoints.capture = capture; }
});

test('async capture blocks overlapping sessions and deleting its owner cannot resurrect history', async () => {
  const { cwd } = repo(), sessions = manager(), s = await sessions.start({ cwd, profileId: 'claude' });
  const capture = sessions.checkpoints.capture.bind(sessions.checkpoints);
  let release; const gate = new Promise(resolve => { release = resolve; });
  sessions.checkpoints.capture = async (...args) => { await gate; return capture(...args); };
  const sending = sessions.input(s.id, 'capture then delete'); await new Promise(setImmediate);
  await assert.rejects(sessions.start({ cwd, profileId: 'claude' }), /being checkpointed/);
  await sessions.kill(s.id); release();
  try { await assert.rejects(sending, /changed while checkpointing/); }
  finally { sessions.checkpoints.capture = capture; }
  assert.equal(existsSync(join(sessions.events.dir, `${s.id}.jsonl`)), false);
});

test('session constructor recovers an interrupted rewind before binding a provider', async () => {
  const { cwd } = repo(), { sessions, s } = await conversation(cwd);
  const original = JSON.parse(JSON.stringify(s));
  const recoveryId = await sessions.checkpoints.archive(s, sessions.events, true);
  const recovery = JSON.parse(readFileSync(join(sessions.checkpoints.path(recoveryId), 'recovery.json')));
  sessions.checkpoints.write(recoveryId, 'recovery.json', { ...recovery, phase: 'applying' });
  sessions.events.replace(s.id, [{ type: 'history.reset', seq: 10000, at: 1 }]);
  writeFileSync(join(cwd, 'file'), 'partially restored');
  const gitDir = git(cwd, 'rev-parse', '--absolute-git-dir');
  writeFileSync(join(gitDir, 'index.lock'), `helm-rewind:${recoveryId}\n`);
  await sessions.stop();
  managers.splice(managers.indexOf(sessions), 1);
  writeFileSync(join(home, 'sessions.json'), JSON.stringify({ version: 1, sessions: [{ ...s, engineSessionId: 'candidate-wrong' }] }));
  const before = FakeDriver.made.length;
  const restarted = new Sessions(new Runtime(), { events: new EventLog(sessions.events.dir), procHost: new Host(), terminals: new Host(), nativeHost: new Host(), nativeDiscovery: false,
    makeDriver: (_engine, opts) => new FakeDriver(opts) });
  managers.push(restarted);
  await restarted.hooks;
  assert.equal(FakeDriver.made.length, before, 'recovery runs without reconnecting any provider');
  assert.equal(restarted.get(s.id).engineSessionId, original.engineSessionId);
  assert.equal(JSON.parse(readFileSync(join(home, 'sessions.json'))).sessions[0].engineSessionId, original.engineSessionId);
  assert.equal(readFileSync(join(cwd, 'file'), 'utf8'), 'after second');
  assert.equal(existsSync(join(gitDir, 'index.lock')), false);
  assert.equal(JSON.parse(readFileSync(join(restarted.checkpoints.path(recoveryId), 'recovery.json'))).phase, 'recovered');
});
