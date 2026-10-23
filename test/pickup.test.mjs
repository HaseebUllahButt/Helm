import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'helm-pickup-')));
process.env.HELM_DIR = join(scratch, 'helm');
const { chatSummary, chooseChats, pickup } = await import('../packages/connect/src/pickup.js');
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

test('the final reply\'s "left" part is the handover, and wrapped asks read plainly', () => {
  const head = turn('[Helm: notes for the agent]\n\nMake the sidebar faster', 'Started.');
  const tail = [
    ...head,
    ...turn('[Helm agent message abc]\nFrom codex agent Brain (vm/123).\nThis is a message.\nIf a reply is needed, send it with: helm reply abc "x".\n\nAre you done?',
      'Done: the list loads at once.\n\nNext, I ran the tests.\n\n## What is left\n- The phone view is not checked.\n- Rollout to the VM.'),
  ];
  const s = chatSummary(head, tail);
  assert.equal(s.asked, 'Make the sidebar faster');
  assert.equal(s.lastAsked, '(message from codex agent Brain) Are you done?');
  assert.equal(s.found, true);
  assert.equal(s.left, '## What is left\n- The phone view is not checked.\n- Rollout to the VM.');
  assert.equal(s.ended, null);
});

test('a reply without a "left" heading gives its last lines; prose "Next," is not a heading', () => {
  const reply = ['Line one.', 'Next, I looked at the cache.', 'Line three.', 'Line four.', 'Line five.', 'Line six.'].join('\n');
  const events = turn('Fix it', reply, { status: 'interrupted' });
  const s = chatSummary(events, events);
  assert.equal(s.found, false);
  assert.equal(s.left, 'Line three.\nLine four.\nLine five.\nLine six.');
  assert.equal(s.ended, 'interrupted');
  assert.equal(s.lastAsked, null, 'one ask is not repeated as the last ask');
  for (const line of ['**What to build next:** the phone loop', 'Not checked: Windows', 'Still open:']) {
    assert.equal(chatSummary(events, turn('x', `Done.\n${line}\nmore`)).found, true, line);
  }
});

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

test('a chat elsewhere whose helpers worked in this repo is earlier work here, even after their checkout is gone', () => {
  const roots = ['/r/main'];
  const sessions = [
    { id: 'quick', cwd: '/home/quick', status: 'idle', updatedAt: 9 },
    { id: 'helper', cwd: '/r/main-build-it', status: 'done', updatedAt: 8, delegation: { parentId: 'quick', worktree: { path: '/r/main-build-it', branch: 'helm/build-it' } } },
    { id: 'quick2', cwd: '/home/quick2', status: 'idle', updatedAt: 7 },
    { id: 'helper2', cwd: '/x/wt', status: 'done', updatedAt: 6, delegation: { parentId: 'quick2', worktree: { path: '/x/wt', repo: '/r/main' } } },
    { id: 'unrelated', cwd: '/home/other', status: 'idle', updatedAt: 9 },
  ];
  const { earlier, running } = chooseChats(sessions, { roots, limit: 3 });
  assert.deepEqual(earlier.map((s) => s.id), ['quick', 'quick2']);
  assert.deepEqual(running, []);
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
  const calls = [];
  const rpc = async (env, method, params) => {
    calls.push(method);
    if (method === M.SESSION_LIST) return { sessions };
    if (method === M.SESSION_EVENTS) return { events: events.chat1 };
    throw new Error(method);
  };
  const page = await pickup({ cwd: repo, self: 'why', selfName: 'why', sessionId: 'me0000000000', rpc, find: null });
  assert.match(page, /^Chat chat1a on why: Sidebar speed \(claude, idle, 1m ago\) in .*repo-wt$/m);
  assert.match(page, /Asked: Make the sidebar faster/);
  assert.match(page, /Its final reply says what is left:\n {4}What is left:\n {4}- Merge helm\/phone\./);
  assert.match(page, /Commits here since then:\n {2}\w+ Sidebar loads at once\n(?!.*Before the chat)/);
  assert.doesNotMatch(page, /Before the chat/);
  assert.match(page, /This project copy \(main\) has changes without commits\. Check Running chats before editing:\n {3}M b\.txt/);
  assert.match(page, /repo-wt \(helm\/phone\) has commits not in this one:\n {2}\w+ Phone view, not merged/);
  assert.match(page, /Check Running chats before editing the same files\. Ask them with `helm say <id>`:\n {2}busy11 {2}Other work \(working\) on why in /);
  assert.doesNotMatch(page, /Not shown|Not checked/, 'one machine: nothing on others to warn about');
  assert.doesNotMatch(page, /me0000/, 'the chat asking is not listed');
  assert.ok(page.split('\n').length < 25, 'short enough to land in an agent\'s context');

  const named = await pickup({ id: 'busy11', cwd: repo, self: 'why', sessionId: 'me0000000000', rpc,
    find: async () => ({ env: 'vm', machine: 'VM', session: sessions[1] }) });
  assert.match(named, /^Chat busy11 on VM: Other work/);
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

test('pickup reads every machine by project: other paths, busy chats, offline snapshots, older Helms', async () => {
  const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: 'pipe' });
  const repo = join(scratch, 'net-repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'first');
  const keys = await projectKeys(repo);
  const now = Date.now();
  const lists = {
    why: { sessions: [], projects: {} },
    laptop: {
      sessions: [
        { id: 'lapdone00000', cwd: '/home/u/code/helm', title: 'Phone view', engine: 'codex', status: 'idle', updatedAt: now - 120_000 },
        { id: 'lapbusy00000', cwd: '/home/u/code/helm', title: 'Sidebar', engine: 'claude', status: 'working', updatedAt: now },
        { id: 'lapother0000', cwd: '/home/u/notes', title: 'Notes', engine: 'claude', status: 'idle', updatedAt: now },
      ],
      projects: { '/home/u/code/helm': keys, '/home/u/notes': ['root:0000'] },
    },
    pc: { sessions: [{ id: 'pcchat000000', cwd: '/x', title: 'X', engine: 'claude', status: 'idle', updatedAt: now }] },
  };
  const snapshot = { machines: {
    home: { at: now - 3 * 3600_000, sessions: [
      { id: 'homedone0000', cwd: 'D:/helm', title: 'Windows build', engine: 'claude', status: 'idle', updatedAt: now - 4 * 3600_000, project: keys, last: 'Built the installer' },
      { id: 'homebusy0000', cwd: 'D:/helm', title: 'Long run', engine: 'codex', status: 'working', updatedAt: now - 4 * 3600_000, project: keys },
      { id: 'homenot00000', cwd: 'D:/else', title: 'Else', engine: 'codex', status: 'idle', updatedAt: now, project: ['root:0000'] },
    ] },
    slow: { at: now - 30_000, sessions: [{ id: 'slowbusy0000', cwd: '/srv/helm', title: 'Quick fix', engine: 'pi', status: 'working', updatedAt: now - 60_000, project: keys }] },
  } };
  const events = turn('Make the phone view', 'Done.\n\nWhat is left:\n- Check it on a real phone.');
  const asked = [];
  const rpc = async (env, method, params) => {
    asked.push(`${env} ${method}`);
    if (method === M.SESSION_LIST) {
      assert.equal(params.projects, true);
      if (env === 'home' || env === 'gone' || env === 'slow') throw Object.assign(new Error('unreachable'), { code: 'unreachable' });
      return lists[env];
    }
    if (method === M.SESSION_EVENTS && env === 'laptop') return { events };
    throw new Error(`${env} ${method}`);
  };
  const machines = { why: { name: 'why' }, laptop: { name: 'Laptop' }, pc: { name: 'HomePC' }, home: { name: 'haseeb' }, gone: { name: 'VM' }, slow: { name: 'Pi' } };
  const page = await pickup({ cwd: repo, self: 'why', selfName: 'why', machines, rpc, find: null, snapshots: [snapshot, Promise.resolve(null)], now });
  assert.match(page, /^Chat lapdon on Laptop: Phone view \(codex, idle, 2m ago\) in \/home\/u\/code\/helm$/m, 'matched by project, not path');
  assert.match(page, /Its final reply says what is left:\n {4}What is left:\n {4}- Check it on a real phone\./);
  assert.match(page, /^Chat homedo on haseeb \(offline, last seen 3h ago\): Windows build \(claude, idle, 4h ago\) in D:\/helm\n {2}Last seen doing: Built the installer\n {2}Read replies with `helm pickup homedo` when haseeb is online\./m);
  assert.match(page, /Check Running chats before editing the same files\. Ask them with `helm say <id>`:\n {2}lapbus {2}Sidebar \(working\) on Laptop in \/home\/u\/code\/helm\n {2}slowbu {2}Quick fix \(working when last seen\) on Pi \(not answering, last seen 30s ago\) in \/srv\/helm\n {2}homebu {2}Long run \(working when last seen\) on haseeb \(offline, last seen 3h ago\) in D:\/helm\n/);
  assert.match(page, /^Helm does not show commits without pushes or files without commits on Laptop, haseeb, Pi\. Run `helm exec <machine> --cwd <folder> -- git status` to check them\.$/m);
  assert.match(page, /^Not checked, the older Helm cannot identify the project in each folder: HomePC\.$/m);
  assert.match(page, /^Not checked, not answering and nothing saved: VM\.$/m);
  assert.doesNotMatch(page, /Notes|homenot|Else|pcchat/);
  assert.doesNotMatch(page, /\/home\/u\/code\/helm \(/, 'no git state read for another machine\'s path');
  assert.ok(!asked.includes('home session.events'), 'an offline chat is not asked for its log');
});
