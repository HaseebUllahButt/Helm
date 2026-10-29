import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A new chat that clones a repo first: the chat is there the moment it is
// asked for, listed like any other, and survives being left while the
// repo comes down. Once it is in, an unused one goes like any chat. What is sent
// while the repo comes down waits and goes to the agent once it is in; the
// agent never starts in a folder that is not there yet.
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-clone-chat-'));
process.env.HELM_NO_SERVICE = '1';
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({
  version: 1,
  profiles: [{ id: 'claudea', label: 'Claude · personal', engine: 'claude', cmd: 'claude', args: [], env: {}, source: 'alias' }],
}));

class StubRuntime extends EventEmitter {
  async read() { return { text: '' }; }
  watch() {}
  async listLive() { return new Map(); }
}

class FakeDriver extends EventEmitter {
  constructor(opts) { super(); Object.assign(this, opts); this.engineSessionId = 'engine-clone'; this.pending = new Map(); }
  async start() { this.started = true; }
  async send(text) { this.sent = (this.sent ?? []).concat(text); this.emit('event', { type: 'status', status: 'working' }); }
  async kill() { this.killed = true; }
}

/** A clone that finishes when the test says so. */
function fakeCloner() {
  const calls = [];
  let last;
  return {
    calls,
    get job() { return last; },
    async begin(opts) {
      calls.push(opts);
      const listeners = new Set();
      let settle;
      last = { repo: opts.repo, state: 'cloning', percent: 0, path: opts.target, error: '', cancelled: false,
        done: new Promise((r) => { settle = r; }),
        onProgress: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
        progress(p) { this.percent = p; for (const fn of listeners) fn(this); },
        finish(state, error = '') { if (state === 'done') mkdirSync(opts.target, { recursive: true }); Object.assign(this, { state, error }); settle(this); },
        cancel() { this.cancelled = true; this.finish('failed', 'Stopped.'); } };
      return last;
    },
  };
}

const setup = async (name) => {
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const { EventLog } = await import('../packages/connect/src/events.js');
  const drivers = [];
  const cloner = fakeCloner();
  const make = () => {
    const s = new Sessions(new StubRuntime(), {
      events: new EventLog(join(process.env.HELM_DIR, `events-${name}`)),
      procHost: Object.assign(new EventEmitter(), { hasProc: () => false }),
      makeDriver: (engine, opts) => { const d = new FakeDriver({ engine, ...opts }); drivers.push(d); return d; },
    });
    s.cloner = cloner;
    return s;
  };
  return { make, drivers, cloner };
};
const tick = () => new Promise((r) => setTimeout(r, 20));

test('the chat is there at once; a message waits for the repo, then goes to the agent', async () => {
  const { make, drivers, cloner } = await setup('wait');
  const sessions = make();
  const target = join(process.env.HELM_DIR, 'work', 'app');
  const s = await sessions.start({ cwd: target, profileId: 'claudea', clone: { repo: 'me/app', login: 'me' } });
  assert.deepEqual(cloner.calls[0], { repo: 'me/app', target, login: 'me' });
  assert.equal(s.status, 'starting');
  assert.deepEqual(s.clone, { repo: 'me/app', login: 'me', state: 'cloning', percent: 0 });
  assert.equal(drivers.length, 0, 'no agent before the folder is there');
  assert.ok((await sessions.list()).some((x) => x.id === s.id), 'listed like any chat');

  cloner.job.progress(40);
  assert.equal(sessions.get(s.id).clone.percent, 40);

  await sessions.input(s.id, 'what is in here?');
  assert.equal(drivers.length, 0, 'still waiting for the clone');
  await assert.rejects(sessions.sendNow(s.id, sessions.events.tail(s.id).find((e) => e.type === 'turn.start').turnId), /once the repo is cloned/);
  assert.deepEqual(await sessions.discardEmpty(s.id), { ok: true, discarded: false }, 'leaving it keeps it');

  cloner.job.finish('done');
  await tick();
  const after = sessions.get(s.id);
  assert.equal(after.clone.state, 'done');
  assert.equal(after.engineSessionId, 'engine-clone');
  assert.equal(drivers[0].cwd, target, 'the agent runs in the clone');
  assert.deepEqual(drivers[0].sent, ['what is in here?'], 'the waiting message goes in');
  await sessions.stop();
});

test('an unused chat is kept while its clone runs or failed, and goes once the repo is in', async () => {
  const { make, cloner } = await setup('unused');
  const sessions = make();
  const target = join(process.env.HELM_DIR, 'work', 'unused');
  const s = await sessions.start({ cwd: target, profileId: 'claudea', clone: { repo: 'me/unused' } });
  assert.deepEqual(await sessions.discardEmpty(s.id), { ok: true, discarded: false }, 'kept while the clone runs');
  cloner.job.finish('failed', 'No network.');
  await tick();
  assert.deepEqual(await sessions.discardEmpty(s.id), { ok: true, discarded: false }, 'kept to try again');

  await sessions.retryClone(s.id);
  cloner.job.finish('done');
  await tick();
  assert.equal(sessions.get(s.id).clone.state, 'done');
  assert.deepEqual(await sessions.discardEmpty(s.id), { ok: true, discarded: true }, 'an unused chat goes once the repo is in');
  assert.throws(() => sessions.get(s.id), /unknown session/);
  assert.ok(existsSync(target), 'the cloned folder stays');
  await sessions.stop();
});

test('a failed clone says why and tries again; deleting the chat stops a clone', async () => {
  const { make, drivers, cloner } = await setup('fail');
  const sessions = make();
  const target = join(process.env.HELM_DIR, 'work', 'site');
  const s = await sessions.start({ cwd: target, profileId: 'claudea', clone: { repo: 'acme/site' } });
  cloner.job.finish('failed', 'GitHub says that repo is not there, or this account cannot see it.');
  await tick();
  assert.equal(sessions.get(s.id).clone.state, 'failed');
  assert.match(sessions.get(s.id).clone.error, /not there/);
  assert.equal(sessions.get(s.id).status, 'idle');

  await sessions.retryClone(s.id);
  assert.equal(cloner.calls.at(-1).partialOk, true);
  assert.equal(sessions.get(s.id).clone.state, 'cloning');
  cloner.job.finish('done');
  await tick();
  assert.equal(sessions.get(s.id).clone.state, 'done');
  assert.equal(drivers.length, 1);

  const other = await sessions.start({ cwd: join(process.env.HELM_DIR, 'work', 'big'), profileId: 'claudea', clone: { repo: 'acme/big' } });
  const job = cloner.job;
  await sessions.kill(other.id);
  assert.equal(job.cancelled, true);
  await sessions.stop();
});

test('a restart mid-clone leaves the chat, saying the clone stopped', async () => {
  const { make } = await setup('restart');
  const first = make();
  const s = await first.start({ cwd: join(process.env.HELM_DIR, 'work', 'cut'), profileId: 'claudea', clone: { repo: 'me/cut' } });
  await first.stop();
  const again = make();
  await again.resume();
  const back = again.get(s.id);
  assert.equal(back.clone.state, 'failed');
  assert.match(back.clone.error, /restarted/);
  assert.equal(back.status, 'idle');
  await again.stop();
});
