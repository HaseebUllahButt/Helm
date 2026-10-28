import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A quick chat is a chat with no folder: it runs in an empty folder helm
// makes for it under HELM_DIR/quick, named by its id. The folder must be
// there for its whole life (restarts included) and gone when it is deleted.
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-quick-chat-'));
process.env.HELM_NO_SERVICE = '1';
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({
  version: 1,
  profiles: [
    { id: 'claudea', label: 'Claude · personal', engine: 'claude', cmd: 'claude', args: [], env: {}, source: 'alias' },
    { id: 'shell', label: 'Shell', engine: 'shell', cmd: 'bash', args: [], env: {}, source: 'alias' },
  ],
}));

class StubRuntime extends EventEmitter {
  async read() { return { text: '' }; }
  watch() {}
  async listLive() { return new Map(); }
}

class FakeDriver extends EventEmitter {
  constructor(opts) {
    super();
    Object.assign(this, opts);
    this.status = 'idle';
    this.engineSessionId = opts.engineSessionId ?? 'engine-quick';
    this.pending = new Map();
  }
  async start() { this.started = true; }
  async send(text) {
    this.sent = (this.sent ?? []).concat(text);
    this.emit('event', { type: 'status', status: 'working' });
  }
  async kill() { this.killed = true; }
}

const setup = async (name) => {
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const { EventLog } = await import('../packages/connect/src/events.js');
  const drivers = [];
  const make = () => new Sessions(new StubRuntime(), {
    events: new EventLog(join(process.env.HELM_DIR, `events-${name}`)),
    procHost: Object.assign(new EventEmitter(), { hasProc: () => false }),
    makeDriver: (engine, opts) => { const d = new FakeDriver({ engine, ...opts }); drivers.push(d); return d; },
  });
  return { make, drivers };
};

test('a quick chat gets its own empty folder, keeps it across a restart, and loses it on delete', async () => {
  const { quickDir } = await import('../packages/connect/src/paths.js');
  const { make, drivers } = await setup('life');
  const first = make();
  const s = await first.start({ quick: true, profileId: 'claudea' });
  const dir = quickDir(s.id);
  assert.equal(s.quick, true);
  assert.equal(s.cwd, dir);
  assert.ok(existsSync(dir), 'scratch folder made on start');
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(drivers.at(-1).cwd, dir, 'the agent runs in it');
  // The folder's name is the id, which must never become the title.
  assert.equal(s.title, 'Sketch');
  assert.equal(s.titleBy, null);
  const listed = (await first.list()).find((x) => x.id === s.id);
  assert.equal(listed.quick, true);
  assert.equal(listed.branch, undefined);
  await first.input(s.id, 'what is 2+2');
  await first.stop();

  // A restart reads the record back and the chat resumes in the same folder.
  const again = make();
  await again.resume();
  const back = again.get(s.id);
  assert.equal(back.quick, true);
  assert.equal(back.cwd, dir);
  assert.ok(existsSync(dir), 'scratch folder survives a restart');
  await again.input(s.id, 'and 3+3?');
  assert.equal(drivers.at(-1).cwd, dir);
  assert.deepEqual(drivers.at(-1).sent, ['and 3+3?']);

  // Archiving keeps it; deleting removes it.
  again.archive(s.id, true);
  assert.ok(existsSync(dir), 'archive keeps the folder');
  await again.kill(s.id);
  assert.ok(!existsSync(dir), 'delete removes the folder');
  await again.stop();
});

test('a deleted quick chat leaves the folder while a branch of it still works there', async () => {
  const { quickDir } = await import('../packages/connect/src/paths.js');
  const { make } = await setup('shared');
  const sessions = make();
  const s = await sessions.start({ quick: true, profileId: 'claudea' });
  const other = await sessions.start({ quick: true, profileId: 'claudea' });
  assert.notEqual(s.cwd, other.cwd, 'each quick chat has its own folder');
  // A child started from inside the quick chat runs in the same folder.
  const child = await sessions.start({ cwd: s.cwd, profileId: 'claudea' });
  await sessions.kill(s.id);
  assert.ok(existsSync(quickDir(s.id)), 'still in use by the child');
  await sessions.kill(child.id);
  assert.ok(existsSync(quickDir(s.id)), 'a plain chat never removes a folder');
  await sessions.kill(other.id);
  assert.ok(!existsSync(quickDir(other.id)));
  await sessions.stop();
});

test('session.start wants exactly one of cwd and quick, and quick only for driven agents', async () => {
  const { make } = await setup('reject');
  const sessions = make();
  await assert.rejects(sessions.start({ quick: true, cwd: '/tmp', profileId: 'claudea' }), /not both/);
  await assert.rejects(sessions.start({ profileId: 'claudea' }), /which folder/);
  await assert.rejects(sessions.start({ quick: true, profileId: 'shell' }), /cannot start a sketch/);
  assert.deepEqual((await sessions.list()).filter((s) => s.quick), []);
  await sessions.stop();
});

test('a quick chat that fails to start leaves no folder behind', async () => {
  const { QUICK_DIR } = await import('../packages/connect/src/paths.js');
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const { EventLog } = await import('../packages/connect/src/events.js');
  const before = existsSync(QUICK_DIR) ? readdirSync(QUICK_DIR).length : 0;
  const sessions = new Sessions(new StubRuntime(), {
    events: new EventLog(join(process.env.HELM_DIR, 'events-fail')),
    makeDriver: (engine, opts) => Object.assign(new FakeDriver({ engine, ...opts }), {
      start: async () => { throw new Error('agent would not start'); },
    }),
  });
  await assert.rejects(sessions.start({ quick: true, profileId: 'claudea' }), /would not start/);
  assert.equal(readdirSync(QUICK_DIR).length, before);
  await sessions.stop();
});
