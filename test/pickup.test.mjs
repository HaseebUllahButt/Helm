import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'helm-pickup-')));
process.env.HELM_DIR = join(scratch, 'helm');
const { chatSummary, chooseChats, pickup } = await import('../packages/connect/src/pickup.js');
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
  assert.match(page, /This checkout \(main\), uncommitted \(may belong to a running chat\):\n {3}M b\.txt/);
  assert.match(page, /repo-wt \(helm\/phone\) has commits not in this one:\n {2}\w+ Phone view, not merged/);
  assert.match(page, /Running here now.*\n {2}busy11 {2}Other work \(working\)/);
  assert.doesNotMatch(page, /me0000/, 'the chat asking is not listed');
  assert.ok(page.split('\n').length < 25, 'short enough to land in an agent\'s context');

  const named = await pickup({ id: 'busy11', cwd: repo, self: 'why', sessionId: 'me0000000000', rpc,
    find: async () => ({ env: 'vm', machine: 'VM', session: sessions[1] }) });
  assert.match(named, /^Chat busy11 on VM: Other work/);
});
