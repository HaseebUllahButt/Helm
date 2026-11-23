import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'helm-pickup-')));
process.env.HELM_DIR = join(scratch, 'helm');
const { chooseChats, pickup } = await import('../packages/connect/src/pickup.js');
const { normaliseRemote, projectKeys, projectKeysFor, sameProject } = await import('../packages/connect/src/project-key.js');
const { M } = await import('@helm/protocol');
test.after(() => rmSync(scratch, { recursive: true, force: true }));

// One turn of a chat, as the event log stores it.
let seq = 0;
const turn = (ask, reply, { status = 'ok', at = Date.now() } = {}) => {
  const t = `t${++seq}`;
  return [
    { type: 'turn.start', turnId: t, text: ask, at },
    { type: 'item.start', turnId: t, id: `${t}-a`, kind: 'tool', name: 'Bash', input: { command: 'npm test' } },
    { type: 'item.done', id: `${t}-a`, status: 'ok' },
    ...(reply == null ? [] : [{ type: 'item.start', turnId: t, id: `${t}-b`, kind: 'text' }, { type: 'item.delta', id: `${t}-b`, text: reply }]),
    { type: 'turn.done', turnId: t, status },
  ];
};

test('chats are chosen from this repo: finished leads to read, anything running to avoid', () => {
  const roots = ['/r/main', '/r/wt'];
  const sessions = [
    { id: 'me', cwd: '/r/wt', status: 'working', updatedAt: 9 },
    { id: 'mine-helper', cwd: '/r/wt', status: 'working', delegation: { parentId: 'me' }, updatedAt: 9 },
    { id: 'other-helper', cwd: '/r/main/sub', status: 'working', delegation: { parentId: 'x' }, updatedAt: 8 },
    { id: 'old', cwd: '/r/main', status: 'idle', updatedAt: 1 },
    { id: 'new', cwd: '/r/wt/pkg', status: 'done', updatedAt: 5 },
    { id: 'done-helper', cwd: '/r/main', status: 'done', delegation: { parentId: 'x' }, updatedAt: 7 },
    { id: 'pane:3', cwd: '/r/main', status: 'idle', updatedAt: 6 },
    { id: 'elsewhere', cwd: '/r/mainly', status: 'idle', updatedAt: 9 },
    { id: 'team', cwd: '/r/main', status: 'idle', team: { working: true }, updatedAt: 4 },
  ];
  const { earlier, running } = chooseChats(sessions, { roots, self: 'me', limit: 3 });
  assert.deepEqual(earlier.map((s) => s.id), ['new', 'old']);
  assert.deepEqual(running.map((s) => s.id), ['other-helper', 'team']);
  assert.deepEqual(chooseChats(sessions, { roots, self: 'me', limit: 1 }).earlier.map((s) => s.id), ['new']);
});

test('pickup reads the chats and git: commits since, unmerged worktree work, uncommitted files', async () => {
  const repo = join(scratch, 'repo');
  const wt = join(scratch, 'repo-wt');
  const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  const commit = (cwd, file, msg, when) => {
    writeFileSync(join(cwd, file), msg);
    git(cwd, 'add', file);
    execFileSync('git', ['-C', cwd, 'commit', '-qm', msg], { env: { ...process.env, GIT_AUTHOR_DATE: `@${when} +0000`, GIT_COMMITTER_DATE: `@${when} +0000` } });
  };
  const now = Math.floor(Date.now() / 1000);
  commit(repo, 'a.txt', 'Before the chat', now - 7200);
  commit(repo, 'b.txt', 'Sidebar loads at once', now - 600);
  git(repo, 'worktree', 'add', '-q', '-b', 'helm/phone', wt);
  commit(wt, 'c.txt', 'Phone view, not merged', now - 300);
  writeFileSync(join(repo, 'b.txt'), 'half done');

  const started = (now - 3600) * 1000;
  const events = {
    chat1: turn('Make the sidebar faster', 'Done.\n\nWhat is left:\n- Merge helm/phone.', { at: started }),
  };
  const sessions = [
    { id: 'chat1aaaaaaa', cwd: wt, title: 'Sidebar speed', engine: 'claude', status: 'idle', createdAt: started, updatedAt: Date.now() - 60_000 },
    { id: 'busy11111111', cwd: repo, title: 'Other work', engine: 'codex', status: 'working', updatedAt: Date.now() },
    { id: 'me0000000000', cwd: repo, title: 'Me', engine: 'claude', status: 'working', updatedAt: Date.now() },
  ];
  const rpc = async (env, method) => {
    if (method === M.SESSION_LIST) return { sessions };
    if (method === M.SESSION_EVENTS) return { events: events.chat1 };
    throw new Error(method);
  };
  const page = await pickup({ cwd: repo, self: 'why', selfName: 'why', sessionId: 'me0000000000', rpc, find: null });
  assert.match(page, /^Chat chat1a on why: Sidebar speed \(claude, idle, 1m ago\) in .*repo-wt$/m);
  assert.match(page, /Commits here since then:\n {2}\w+ Sidebar loads at once\n(?!.*Before the chat)/);
  assert.doesNotMatch(page, /Before the chat/);
  assert.match(page, /This project copy \(main\) has changes without commits\. Check Running chats before editing:\n {3}M b\.txt/);
  assert.match(page, /repo-wt \(helm\/phone\) has commits not in this one:\n {2}\w+ Phone view, not merged/);
  assert.match(page, /Check Running chats before editing the same files\. Ask them with `helm say <id>`:\n {2}busy11 {2}Other work \(working\) on why in /);
  assert.doesNotMatch(page, /me0000/, 'the chat asking is not listed');
});

test('a remote names one place however it is written; a local path is no place', () => {
  for (const url of ['git@github.com:Me/Helm.git', 'https://github.com/me/helm', 'ssh://git@github.com:22/Me/Helm.git/', 'https://u:secret@github.com/Me/Helm']) {
    assert.equal(normaliseRemote(url), 'github.com/me/helm', url);
  }
  for (const url of ['/home/me/Helm', '../Helm', 'file:///home/me/Helm', 'C:\\src\\Helm', '']) assert.equal(normaliseRemote(url), null, url);
});

test('two copies of one repo at different paths are one project; another repo is not', async () => {
  const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: 'pipe' });
  const a = join(scratch, 'keys-a');
  execFileSync('git', ['init', '-q', '-b', 'main', a]);
  git(a, 'config', 'user.email', 't@t'); git(a, 'config', 'user.name', 't');
  git(a, 'commit', '-q', '--allow-empty', '-m', 'first');
  const b = join(scratch, 'elsewhere', 'keys-b');
  execFileSync('git', ['clone', '-q', a, b]);
  const other = join(scratch, 'keys-other');
  execFileSync('git', ['init', '-q', other]);
  git(other, 'config', 'user.email', 'x@x'); git(other, 'config', 'user.name', 'x');
  git(other, 'commit', '-q', '--allow-empty', '-m', 'another start');
  const [ka, kb, ko] = await Promise.all([a, b, other].map((d) => projectKeys(d)));
  assert.ok(sameProject(ka, kb), 'a clone elsewhere shares its first commit');
  assert.ok(!sameProject(ka, ko));
  assert.deepEqual(kb.filter((k) => k.startsWith('remote:')), [], 'a path remote is left out');
  git(other, 'remote', 'add', 'origin', 'git@github.com:Me/Helm.git');
  git(b, 'remote', 'set-url', 'origin', 'https://github.com/me/helm.git');
  assert.ok(sameProject(await projectKeys(other), await projectKeys(b)), 'or the same remote, written differently');
  assert.deepEqual(await projectKeys(join(scratch, 'gone')), []);
  let calls = 0;
  const counted = async (...x) => { calls++; return null; };
  await projectKeysFor([a, a, b], { run: counted, now: 1 });
  await projectKeysFor([a, b], { run: counted, now: 2 });
  assert.equal(calls, 4, 'each folder once, then from the cache');
});
