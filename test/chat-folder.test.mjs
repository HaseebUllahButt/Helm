import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// A chat lives in its folder and must not die of it: a symlink removed, a
// folder renamed, a folder deleted, or a folder changed on purpose.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'helm-chat-folder-')));
process.env.HELM_DIR = join(root, 'helm');
process.env.HELM_NO_SERVICE = '1';
mkdirSync(process.env.HELM_DIR, { recursive: true });
test.after(() => rmSync(root, { recursive: true, force: true }));
const claudeHome = join(root, 'claude-home');
const codexHome = join(root, 'codex-home');
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({
  version: 1,
  profiles: [
    { id: 'claudea', label: 'Claude', engine: 'claude', cmd: 'claude', args: [], env: { CLAUDE_CONFIG_DIR: claudeHome }, source: 'alias' },
    { id: 'codexa', label: 'Codex', engine: 'codex', cmd: 'codex', args: [], env: { CODEX_HOME: codexHome }, source: 'alias' },
  ],
}));

const { Sessions } = await import('../packages/connect/src/sessions.js');
const { EventLog } = await import('../packages/connect/src/events.js');
const { claudeKey, waitingFolder, recordedFolder, findMovedFolder } = await import('../packages/connect/src/chat-folder.js');

class StubRuntime extends EventEmitter {
  async read() { return { text: '' }; }
  watch() {}
  async listLive() { return new Map(); }
}

class FakeDriver extends EventEmitter {
  constructor(opts) { super(); Object.assign(this, opts); this.engineSessionId ??= randomUUID(); this.pending = new Map(); this.status = 'idle'; }
  async start() { this.started = true; }
  async send(text) { this.sent = (this.sent ?? []).concat(text); }
  async kill() { this.killed = true; }
}

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

let n = 0;
/** One Helm daemon; `restart()` is the next one, reading the same records. */
function helm() {
  const events = new EventLog(join(process.env.HELM_DIR, `events-${n++}`));
  const drivers = [];
  const make = () => {
    const s = new Sessions(new StubRuntime(), {
      events,
      procHost: Object.assign(new EventEmitter(), { hasProc: () => false }),
      makeDriver: (engine, opts) => { const d = new FakeDriver({ engine, ...opts }); drivers.push(d); return d; },
    });
    // Never walk the real home in a test: look only where the test puts folders.
    s.folderCandidates = async () => [];
    return s;
  };
  return { events, drivers, make, of: (id) => drivers.filter((d) => d.env.HELM_SESSION_ID === id).at(-1) };
}

const work = () => realpathSync(mkdtempSync(join(root, 'work-')));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A Claude conversation as Claude files it: under its folder's real path. */
function claudeConversation(cwd, id) {
  const dir = join(claudeHome, 'projects', claudeKey(cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: 'user', cwd, sessionId: id, message: { content: 'hi' } })}\n`);
  return file;
}

/** A chat that has run once, so it has history to keep. */
async function ranChat(h, sessions, cwd, profileId = 'claudea') {
  const chat = await sessions.start({ cwd, profileId });
  await sessions.input(chat.id, 'first');
  await until(() => h.of(chat.id)?.sent?.length);
  finish(h, sessions, chat.id);
  const s = sessions.get(chat.id);
  assert.ok(s.engineSessionId);
  // The folder's identity is noted as the agent starts; git's part is read after.
  await until(() => s.folderStamp && (!existsSync(join(cwd, '.git')) || s.folderKeys?.length));
  sessions.flush();
  return s;
}

/** The agent ends its turn. */
function finish(h, sessions, id) {
  const d = h.of(id);
  const turnId = sessions.events.activeTurn(id)?.turnId;
  d.emit('event', { type: 'turn.done', turnId, status: 'ok' });
  d.emit('event', { type: 'status', status: 'idle' });
}

const messages = (events, id) => events.tail(id, 0).filter((e) => e.type === 'error' && e.kind === 'folder');

test('a chat started through a symlink saves the real folder', async () => {
  const h = helm();
  const sessions = h.make();
  const real = join(work(), 'project');
  mkdirSync(real);
  const link = join(root, `link-${n}`);
  symlinkSync(real, link);
  const chat = await sessions.start({ cwd: link, profileId: 'claudea' });
  assert.equal(chat.cwd, real, 'the record holds the folder, not the symlink');
  assert.equal(chat.title, link.split('/').pop(), 'the title still says what the owner typed');
  await sessions.stop();
});

test('symlink removed: an older chat moves to the folder the AI recorded, and keeps its history', async () => {
  const h = helm();
  const first = h.make();
  const real = join(work(), 'ra2-native');
  mkdirSync(real);
  const link = join(root, `ra2-link-${n}`);
  symlinkSync(real, link);
  const s = await ranChat(h, first, real);
  // As an older Helm saved it: the symlink path, not the real one.
  s.cwd = link;
  first.pin(s.id, false);
  first.flush();
  claudeConversation(real, s.engineSessionId);
  rmSync(link);

  const next = h.make();
  await next.input(s.id, 'carry on');
  await until(() => h.of(s.id)?.sent?.includes('carry on'));
  assert.equal(h.of(s.id).cwd, real, 'the agent starts in the real folder');
  assert.equal(next.get(s.id).cwd, real, 'the chat record follows');
  assert.equal(next.get(s.id).folderLost, undefined);
  const said = messages(h.events, s.id);
  assert.match(said.at(-1).message, /is missing\. Helm found it at .*ra2-native, so this chat works there now\./);
  assert.equal(said.at(-1).tone, 'note', 'news, not a failure');
  await next.stop();
  await first.stop();
});

test('folder renamed: the chat finds it by inode, and Claude resumes there from a hard link', async () => {
  const h = helm();
  const first = h.make();
  const parent = work();
  const before = join(parent, 'game');
  mkdirSync(before);
  const s = await ranChat(h, first, before);
  const old = claudeConversation(before, s.engineSessionId);
  // A second chat in a folder inside it moves along.
  const inner = join(before, 'docs');
  mkdirSync(inner);
  const other = await ranChat(h, first, inner);
  await first.stop();
  const after = join(parent, 'game-renamed');
  renameSync(before, after);

  const next = h.make();
  await next.input(s.id, 'carry on');
  await until(() => h.of(s.id)?.sent?.includes('carry on'));
  assert.equal(h.of(s.id).cwd, after);
  assert.equal(next.get(s.id).cwd, after);
  assert.equal(next.get(other.id).cwd, join(after, 'docs'), 'a chat in a folder inside it moves too');
  const moved = join(claudeHome, 'projects', claudeKey(after), `${s.engineSessionId}.jsonl`);
  assert.ok(existsSync(moved), 'Claude finds the conversation under the new folder');
  assert.equal(statSync(moved).ino, statSync(old).ino, 'one file under two names, so no turn is lost');
  await next.stop();
});

test('folder deleted: the chat still runs, in an empty folder, and says so once', async () => {
  const h = helm();
  const first = h.make();
  const gone = join(work(), 'deleted-project');
  mkdirSync(gone);
  const s = await ranChat(h, first, gone);
  claudeConversation(gone, s.engineSessionId);
  await first.stop();
  rmSync(gone, { recursive: true });

  const next = h.make();
  await next.input(s.id, 'a helper result');
  await until(() => h.of(s.id)?.sent?.includes('a helper result'));
  const waiting = waitingFolder(s.id);
  assert.equal(h.of(s.id).cwd, waiting, 'the agent starts, and the message is not lost');
  assert.ok(existsSync(join(claudeHome, 'projects', claudeKey(waiting), `${s.engineSessionId}.jsonl`)), 'with its history');
  const lost = next.get(s.id).folderLost;
  assert.ok(lost && lost.path.endsWith('deleted-project'), 'the app can show the missing folder');
  const said = messages(h.events, s.id);
  assert.equal(said.length, 1);
  assert.match(said[0].message, /deleted-project is missing, and Helm could not find where it went\./);
  assert.notEqual(said[0].tone, 'note');
  assert.ok(!h.events.tail(s.id, 0).some((e) => e.type === 'turn.done' && e.status === 'error'), 'no failed turn');

  // The folder comes back: the next start is there again.
  finish(h, next, s.id);
  mkdirSync(gone);
  await next.changeFolder(s.id, gone);
  assert.equal(next.get(s.id).folderLost, undefined);
  await next.stop();
});

test('folder deleted, repo cloned again elsewhere: found by its git identity', async () => {
  const h = helm();
  const first = h.make();
  const repo = join(work(), 'app');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'first');
  const s = await ranChat(h, first, repo, 'codexa');
  await first.stop();
  const again = join(work(), 'app-fresh');
  execFileSync('git', ['clone', '-q', repo, again], { stdio: 'ignore' });
  rmSync(repo, { recursive: true });

  const next = h.make();
  next.folderCandidates = async () => [{ path: again, repo: true }];
  await next.input(s.id, 'carry on');
  await until(() => h.of(s.id)?.sent?.includes('carry on'));
  assert.equal(h.of(s.id).cwd, again, 'Codex resumes by id, in the fresh clone');
  assert.equal(next.get(s.id).cwd, again);
  await next.stop();
});

test('git identity picks one matching repo, and leaves several for the owner', async () => {
  const one = (keys) => async (dirs) => Object.fromEntries(dirs.map((d) => [d, keys[d] ?? []]));
  const found = await findMovedFolder({
    missing: '/x/app', keys: ['root:abc'],
    folders: async () => [{ path: '/y/app-new', repo: true }, { path: '/y/other', repo: true }],
    keysOf: one({ '/y/app-new': ['root:abc'], '/y/other': ['root:def'] }),
  });
  assert.deepEqual([found.found, found.how], ['/y/app-new', 'repo']);
  const many = await findMovedFolder({
    missing: '/x/app', keys: ['root:abc'],
    folders: async () => [{ path: '/y/a', repo: true }, { path: '/y/b', repo: true }],
    keysOf: one({ '/y/a': ['root:abc'], '/y/b': ['root:abc'] }),
  });
  assert.equal(many.found, null, 'two clones: Helm does not guess');
  assert.deepEqual(many.candidates, ['/y/a', '/y/b']);
  const named = await findMovedFolder({
    missing: '/x/app', keys: ['root:abc'],
    folders: async () => [{ path: '/y/a', repo: true }, { path: '/z/app', repo: true }],
    keysOf: one({ '/y/a': ['root:abc'], '/z/app': ['root:abc'] }),
  });
  assert.equal(named.found, '/z/app', 'the one with the same name wins');
});

test('the folders Claude and Codex recorded', () => {
  const dir = work();
  const claude = join(dir, 'c.jsonl');
  writeFileSync(claude, ['{"cwd":"/old","type":"user"}', '{"cwd":"/real/path \\"q\\"","type":"assistant"}', ''].join('\n'));
  assert.equal(recordedFolder('claude', claude), '/real/path "q"', 'the last line wins');
  const codex = join(dir, 'x.jsonl');
  writeFileSync(codex, ['{"type":"session_meta","payload":{"id":"1","cwd":"/first"}}', '{"type":"turn_context","payload":{"cwd":"/later","model":"m"}}', ''].join('\n'));
  assert.equal(recordedFolder('codex', codex), '/later');
  assert.equal(recordedFolder('pi', codex), null);
});

test('change folder on purpose: one command moves the chat and its folder mates', async () => {
  const h = helm();
  const sessions = h.make();
  const from = join(work(), 'from');
  mkdirSync(from);
  const s = await ranChat(h, sessions, from);
  const mate = await ranChat(h, sessions, from);
  const old = claudeConversation(from, s.engineSessionId);
  const to = join(work(), 'to');
  mkdirSync(to);
  const ran = h.of(s.id);

  // Working: the step finishes first.
  sessions.get(s.id).status = 'working';
  await assert.rejects(sessions.changeFolder(s.id, to), /The chat is working\. Change the folder when it stops\./);
  sessions.get(s.id).status = 'idle';

  await assert.rejects(sessions.changeFolder(s.id, join(to, 'nope')), /does not exist on this machine/);
  const r = await sessions.changeFolder(s.id, to);
  assert.equal(r.session.cwd, to);
  assert.deepEqual(new Set(r.moved), new Set([s.id, mate.id]), 'the other chat in that folder moved too');
  assert.ok(ran.killed, 'the idle agent stops, so the next one starts in the new folder');
  await sessions.input(s.id, 'next');
  await until(() => h.of(s.id) !== ran && h.of(s.id)?.sent?.includes('next'));
  assert.equal(h.of(s.id).cwd, to);
  assert.equal(statSync(join(claudeHome, 'projects', claudeKey(to), `${s.engineSessionId}.jsonl`)).ino, statSync(old).ino);
  assert.match(messages(h.events, s.id).at(-1).message, /The folder of this chat is now .*\/to\. 1 other chat in that folder moved too\./);

  const only = join(work(), 'only');
  mkdirSync(only);
  const alone = await sessions.changeFolder(mate.id, only, { all: false });
  assert.deepEqual(alone.moved, [mate.id]);
  assert.equal(sessions.get(s.id).cwd, to, '--only leaves the others');
  await sessions.stop();
});
