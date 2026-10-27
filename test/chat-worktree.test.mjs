import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Every chat in a repo whose helm.json says "per-chat" works in its own git
// worktree: made before the agent starts, usable at once without an install,
// named after the chat, and removed once its branch is merged back.
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-chat-worktree-'));
process.env.HELM_NO_SERVICE = '1';
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({
  version: 1,
  profiles: [{ id: 'claudea', label: 'Claude · personal', engine: 'claude', cmd: 'claude', args: [], env: {}, source: 'alias' }],
}));

const { linkCheckout, worktreePlan, worktreeNote, keepReason } = await import('../packages/connect/src/chat-worktree.js');
const { Sessions } = await import('../packages/connect/src/sessions.js');
const { UNUSED_MS } = await import('../packages/connect/src/session-worktrees.js');
const { EventLog } = await import('../packages/connect/src/events.js');

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const real = (p) => realpathSync(p);

/** A repo with a workspace package, its dependencies installed, and a .env. */
function repo({ config = { worktrees: 'per-chat' } } = {}) {
  const dir = join(mkdtempSync(join(process.env.HELM_DIR, 'work-')), 'proj');
  mkdirSync(join(dir, 'packages', 'core'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.env\n');
  writeFileSync(join(dir, 'packages', 'core', 'index.js'), 'export default 1;\n');
  writeFileSync(join(dir, 'packages', 'core', 'cli.js'), '');
  if (config) writeFileSync(join(dir, 'helm.json'), JSON.stringify(config));
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'first');
  // What an install leaves: a dependency, the workspace package linked in
  // under its scope, a bin pointing through it, a cache, and a package's
  // own nested node_modules.
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), '');
  mkdirSync(join(dir, 'node_modules', '@me'));
  symlinkSync('../../packages/core', join(dir, 'node_modules', '@me', 'core'));
  mkdirSync(join(dir, 'node_modules', '.bin'));
  symlinkSync('../@me/core/cli.js', join(dir, 'node_modules', '.bin', 'core'));
  symlinkSync('../dep/index.js', join(dir, 'node_modules', '.bin', 'dep'));
  mkdirSync(join(dir, 'node_modules', '.vite'));
  mkdirSync(join(dir, 'packages', 'core', 'node_modules', 'inner'), { recursive: true });
  writeFileSync(join(dir, '.env'), 'SECRET=1\n');
  return dir;
}

class StubRuntime extends EventEmitter {
  async read() { return { text: '' }; }
  watch() {}
  async listLive() { return new Map(); }
}

class FakeDriver extends EventEmitter {
  constructor(opts) { super(); Object.assign(this, opts); this.engineSessionId = `engine-${Math.random().toString(36).slice(2, 8)}`; this.pending = new Map(); this.status = 'idle'; }
  async start() { this.started = true; }
  async send(text) { this.sent = (this.sent ?? []).concat(text); }
  async kill() { this.killed = true; }
}

let n = 0;
function sessions() {
  const drivers = [];
  const s = new Sessions(new StubRuntime(), {
    events: new EventLog(join(process.env.HELM_DIR, `events-${n++}`)),
    procHost: Object.assign(new EventEmitter(), { hasProc: () => false }),
    makeDriver: (engine, opts) => { const d = new FakeDriver({ engine, ...opts }); drivers.push(d); return d; },
  });
  return { sessions: s, drivers };
}
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('only a repo whose helm.json says per-chat, and never inside a worktree', async () => {
  assert.equal(await worktreePlan(repo({ config: null })), null, 'off without helm.json');
  assert.equal(await worktreePlan(repo({ config: { worktrees: 'shared' } })), null);
  const dir = repo({ config: { worktrees: 'per-chat', setup: 'true' } });
  const plan = await worktreePlan(join(dir, 'packages'));
  assert.equal(real(plan.root), real(dir));
  assert.equal(plan.rel, 'packages');
  assert.equal(plan.setup, 'true');
  git(dir, 'worktree', 'add', '-q', '-b', 'other', `${dir}-other`);
  assert.equal(await worktreePlan(`${dir}-other`), null, 'a linked worktree is already its own');
});

test('a worktree gets the main checkout\'s packages linked in, its own workspace packages its own', () => {
  const dir = repo();
  const wt = `${dir}-linked`;
  git(dir, 'worktree', 'add', '-q', '-b', 'linked', wt);
  linkCheckout(dir, wt);
  const nm = join(wt, 'node_modules');
  assert.ok(lstatSync(nm).isDirectory() && !lstatSync(nm).isSymbolicLink(), 'a real node_modules folder');
  assert.equal(real(join(nm, 'dep')), real(join(dir, 'node_modules', 'dep')), 'a dependency links to the main checkout');
  assert.equal(real(join(nm, '@me', 'core')), real(join(wt, 'packages', 'core')), 'the workspace package is this worktree\'s');
  assert.equal(real(join(nm, '.bin', 'core')), real(join(wt, 'packages', 'core', 'cli.js')), 'a bin through it too');
  assert.equal(real(join(nm, '.bin', 'dep')), real(join(dir, 'node_modules', 'dep', 'index.js')));
  assert.ok(!existsSync(join(nm, '.vite')), 'build caches are not shared');
  assert.equal(real(join(wt, 'packages', 'core', 'node_modules', 'inner')), real(join(dir, 'packages', 'core', 'node_modules', 'inner')), 'nested node_modules');
  assert.ok(lstatSync(join(wt, '.env')).isSymbolicLink(), '.env is linked, not copied');
  assert.equal(real(join(wt, '.env')), real(join(dir, '.env')));
  // Running it again touches nothing that is there.
  assert.deepEqual(linkCheckout(dir, wt), []);
});

test('a new chat starts in its own worktree; quick chats and plain repos do not', async () => {
  const dir = repo();
  const { sessions: s, drivers } = sessions();
  const chat = await s.start({ cwd: dir, profileId: 'claudea' });
  const w = chat.chatWorktree;
  assert.equal(w.branch, `helm/chat-${chat.id}`);
  assert.equal(w.base, 'main');
  assert.equal(real(chat.cwd), real(`${dir}-chat-${chat.id}`));
  assert.equal(drivers[0].cwd, chat.cwd, 'the agent starts in the worktree');
  assert.equal(chat.title, 'proj', 'named after the repo, not the generated folder');
  assert.equal(git(chat.cwd, 'branch', '--show-current'), w.branch);
  assert.ok(existsSync(join(chat.cwd, 'node_modules', 'dep')), 'usable at once');
  assert.match(worktreeNote(chat), /made from main\. .*merge it into main/);
  assert.equal(worktreeNote({}), '');

  const sub = await s.start({ cwd: join(dir, 'packages'), profileId: 'claudea' });
  assert.equal(real(sub.cwd), real(join(`${dir}-chat-${sub.id}`, 'packages')), 'a subfolder stays a subfolder');

  const helper = await s.start({ cwd: dir, profileId: 'claudea', delegation: { parentId: null, task: 'look', status: 'starting' } });
  assert.ok(helper.chatWorktree, 'a helper in the main checkout gets one too');
  const inside = await s.start({ cwd: chat.cwd, profileId: 'claudea', delegation: { parentId: chat.id, task: 'help', status: 'starting' } });
  assert.equal(inside.chatWorktree, undefined, 'a helper already in a worktree stays there');
  assert.equal(inside.cwd, chat.cwd);
  const hidden = await s.start({ cwd: dir, profileId: 'claudea', delegation: { parentId: null, task: 'ask', status: 'starting', hidden: true } });
  assert.equal(hidden.chatWorktree, undefined);

  const quick = await s.start({ quick: true, profileId: 'claudea' });
  assert.equal(quick.chatWorktree, undefined);
  const plain = repo({ config: null });
  const other = await s.start({ cwd: plain, profileId: 'claudea' });
  assert.equal(other.chatWorktree, undefined);
  assert.equal(other.cwd, plain);
  await s.stop();
});

test('the setup command runs before the agent; a failed one shows in the chat', async () => {
  const dir = repo({ config: { worktrees: 'per-chat', setup: 'sleep 0.3; echo ran > setup.txt' } });
  const { sessions: s, drivers } = sessions();
  const chat = await s.start({ cwd: dir, profileId: 'claudea' });
  assert.equal(chat.status, 'starting');
  assert.equal(chat.chatWorktree.setup, 'running');
  assert.equal(drivers.length, 0, 'no agent while setup runs');
  await until(() => drivers.length === 1 && s.get(chat.id).status === 'idle');
  assert.ok(existsSync(join(chat.cwd, 'setup.txt')));
  assert.equal(s.get(chat.id).chatWorktree.setup, undefined);

  const bad = repo({ config: { worktrees: 'per-chat', setup: 'echo no npm here >&2; exit 3' } });
  const failed = await s.start({ cwd: bad, profileId: 'claudea' });
  await until(() => drivers.length === 2 && s.get(failed.id).status === 'idle');
  const error = s.events.tail(failed.id).find((e) => e.type === 'error');
  assert.match(error.message, /setup command in helm\.json failed[\s\S]*no npm here/);
  assert.equal(drivers[1].cwd, failed.cwd, 'the agent starts anyway');
  await s.stop();
});

test('the branch takes the chat\'s name while it has no commits and the name is free', async () => {
  const dir = repo();
  const { sessions: s } = sessions();
  const a = await s.start({ cwd: dir, profileId: 'claudea' });
  s.rename(a.id, 'Fix the login page');
  await until(() => s.get(a.id).chatWorktree.branch === 'helm/fix-the-login-page');
  assert.equal(git(a.cwd, 'branch', '--show-current'), 'helm/fix-the-login-page');
  assert.ok(existsSync(a.cwd), 'the folder stays where the agent runs');

  const b = await s.start({ cwd: dir, profileId: 'claudea' });
  s.rename(b.id, 'Fix the login page');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.get(b.id).chatWorktree.branch, `helm/chat-${b.id}`, 'the name is taken');

  const c = await s.start({ cwd: dir, profileId: 'claudea' });
  writeFileSync(join(c.cwd, 'x.txt'), 'x');
  git(c.cwd, 'add', 'x.txt');
  git(c.cwd, 'commit', '-qm', 'work');
  s.rename(c.id, 'Something new');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.get(c.id).chatWorktree.branch, `helm/chat-${c.id}`, 'a branch with commits keeps its name');
  await s.stop();
});

test('a merged, idle chat loses its worktree; unmerged or uncommitted work keeps it', async () => {
  const dir = repo();
  const { sessions: s, drivers } = sessions();
  const chat = await s.start({ cwd: dir, profileId: 'claudea' });
  const w = () => s.get(chat.id).chatWorktree;
  assert.equal(await keepReason(w()), 'no commits', 'nothing done yet');

  writeFileSync(join(chat.cwd, 'feature.txt'), 'new\n');
  assert.equal(await keepReason(w()), 'no commits');
  git(chat.cwd, 'add', 'feature.txt');
  git(chat.cwd, 'commit', '-qm', 'feature');
  assert.equal(await keepReason(w()), 'unmerged');
  git(dir, 'merge', '-q', '--no-edit', w().branch);
  writeFileSync(join(chat.cwd, 'draft.txt'), 'half done\n');
  assert.equal(await keepReason(w()), 'uncommitted');
  assert.equal(await s.worktreeTidy(chat.id), false, 'uncommitted work keeps it');
  rmSync(join(chat.cwd, 'draft.txt'));
  assert.equal(await keepReason(w()), null, 'links and node_modules Helm made do not count');

  const removed = await s.worktreeTidy(chat.id);
  assert.equal(removed, true);
  assert.ok(!existsSync(chat.cwd), 'the folder is gone');
  assert.throws(() => git(dir, 'rev-parse', '--verify', `refs/heads/${w().branch}`), 'the merged branch is deleted');
  assert.equal(drivers[0].killed, true, 'its idle agent was let go first');

  // Reopened: the folder comes back before the agent starts.
  await s.input(chat.id, 'one more thing');
  await until(() => drivers.length === 2);
  assert.ok(existsSync(join(chat.cwd, 'feature.txt')), 'rebuilt from the base');
  assert.equal(git(chat.cwd, 'branch', '--show-current'), w().branch);
  assert.ok(existsSync(join(chat.cwd, 'node_modules', 'dep')));
  // Its old work is in the base already, so the rebuilt branch is not "merged".
  assert.equal(await s.worktreeTidy(chat.id), false);
  assert.ok(existsSync(chat.cwd), 'a rebuilt worktree stays until new work is merged');
  await s.stop();
});

test('a chat opened while its folder is being removed starts no agent there', async () => {
  // The app asks for the command menu again as the agent is let go. The
  // folder still existed, so an agent started in it, found it gone a
  // moment later and wrote a red "can't access working directory" error.
  const dir = repo();
  const { sessions: s, drivers } = sessions();
  const chat = await s.start({ cwd: dir, profileId: 'claudea' });
  git(chat.cwd, 'commit', '-q', '--allow-empty', '-m', 'feature');
  git(dir, 'merge', '-q', '--no-edit', s.get(chat.id).chatWorktree.branch);
  const tidy = s.worktreeTidy(chat.id);
  await until(() => drivers[0].killed);
  assert.deepEqual(await s.commands(chat.id), []);
  assert.equal(drivers.length, 1, 'the menu started no agent');
  const sent = s.input(chat.id, 'one more thing');
  await tidy;
  await sent;
  await until(() => drivers.length === 2);
  assert.ok(existsSync(chat.cwd), 'a message waits for the removal, then gets its folder back');
  await s.stop();
});

test('a chat quiet for an hour loses a worktree it never committed to', async () => {
  const dir = repo();
  const { sessions: s } = sessions();
  const chat = await s.start({ cwd: dir, profileId: 'claudea' });
  const later = s.get(chat.id).updatedAt + UNUSED_MS;
  assert.equal(await s.worktreeTidy(chat.id, later - 1000), false, 'a chat just used keeps it');
  writeFileSync(join(chat.cwd, 'draft.txt'), 'half done\n');
  assert.equal(await s.worktreeTidy(chat.id, later), false, 'uncommitted work keeps it');
  rmSync(join(chat.cwd, 'draft.txt'));
  assert.equal(await s.worktreeTidy(chat.id, later), true);
  assert.ok(!existsSync(chat.cwd), 'the folder is gone');

  const busy = await s.start({ cwd: dir, profileId: 'claudea' });
  git(busy.cwd, 'commit', '-q', '--allow-empty', '-m', 'mine');
  assert.equal(await s.worktreeTidy(busy.id, s.get(busy.id).updatedAt + UNUSED_MS), false, 'unmerged commits keep it');
  await s.stop();
});

test('a folder removed by hand comes back from its branch; deleting a chat keeps unmerged work', async () => {
  const dir = repo();
  const { sessions: s, drivers } = sessions();
  const chat = await s.start({ cwd: dir, profileId: 'claudea' });
  writeFileSync(join(chat.cwd, 'mine.txt'), 'only on the branch\n');
  git(chat.cwd, 'add', 'mine.txt');
  git(chat.cwd, 'commit', '-qm', 'mine');
  await s.release(chat.id);
  git(dir, 'worktree', 'remove', '--force', chat.cwd);
  await s.input(chat.id, 'carry on');
  await until(() => drivers.length === 2);
  assert.ok(existsSync(join(chat.cwd, 'mine.txt')), 'checked out from its branch');

  await s.kill(chat.id);
  assert.ok(existsSync(chat.cwd), 'unmerged work stays after the chat is deleted');

  const empty = await s.start({ cwd: dir, profileId: 'claudea' });
  await s.kill(empty.id);
  assert.ok(!existsSync(empty.cwd), 'a chat that did nothing takes its worktree along');
  await s.stop();
});

test('a restart closes an idle agent whose folder was removed by hand, and does not rebuild it', async () => {
  const dir = repo();
  const events = new EventLog(join(process.env.HELM_DIR, 'events-gone'));
  const closed = [];
  const drivers = [];
  const make = () => new Sessions(new StubRuntime(), {
    events,
    // Every hosted agent outlived the old daemon.
    procHost: Object.assign(new EventEmitter(), { hasProc: () => true, procPipe: () => null, close: async (id) => { closed.push(id); } }),
    makeDriver: (engine, opts) => { const d = new FakeDriver({ engine, ...opts }); drivers.push(d); return d; },
  });
  const first = make();
  const chat = await first.start({ cwd: dir, profileId: 'claudea' });
  const kept = await first.start({ cwd: dir, profileId: 'claudea' });
  first.flush();
  git(dir, 'worktree', 'remove', '--force', chat.cwd);

  const next = make();
  drivers.length = 0;
  await next.resume();
  assert.ok(!existsSync(chat.cwd), 'the folder stays gone');
  assert.ok(closed.includes(chat.id), 'its agent is closed');
  assert.ok(!closed.includes(kept.id) && drivers.some((d) => d.env.HELM_SESSION_ID === kept.id), 'the other one is reattached');
  assert.ok(!drivers.some((d) => d.env.HELM_SESSION_ID === chat.id));
  assert.equal(next.get(chat.id).status, 'idle');

  await next.input(chat.id, 'carry on');
  await until(() => drivers.some((d) => d.env.HELM_SESSION_ID === chat.id));
  assert.ok(existsSync(chat.cwd), 'its next message rebuilds the folder');
  assert.ok(existsSync(kept.cwd));
  await next.stop();
  await first.stop();
});
