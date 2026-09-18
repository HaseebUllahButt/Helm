import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A headless agent session, end to end inside the daemon: starting one goes
// to a driver, its events land in the log with sequence numbers, pushes flow
// only while watched, a pending prompt survives the driver, and a kill
// removes everything.
process.env.CON_DIR = mkdtempSync(join(tmpdir(), 'con-session-driver-'));
process.env.CON_NO_SERVICE = '1';

// A profile for the fakes to be started from, for every test in the file -
// the first test's cleanup must not take it away from the rest.
test.after(() => rmSync(process.env.CON_DIR, { recursive: true, force: true }));
writeFileSync(join(process.env.CON_DIR, 'profiles.json'), JSON.stringify({
  version: 1,
  profiles: [{ id: 'claudea', label: 'Claude · personal', engine: 'claude', cmd: 'claude', args: ['--model', 'x'], env: { CLAUDE_CONFIG_DIR: '~/.claude-personal' }, source: 'alias' }],
}));

class StubRuntime extends EventEmitter {
  async read() { return { text: '' }; }
  watch() {}
  async listLive() { return new Map(); }
}

/** A driver that does what it is told and reports it, without any CLI. */
class FakeDriver extends EventEmitter {
  static made = [];
  constructor(opts) {
    super();
    Object.assign(this, opts);
    this.status = 'idle';
    this.engineSessionId = opts.engineSessionId ?? 'engine-1';
    this.pending = new Map();
    FakeDriver.made.push(this);
  }
  push(type, payload) {
    if (type === 'status') this.status = payload.status;
    this.emit('event', { type, ...payload });
  }
  async start() { this.started = true; }
  async send(text) {
    this.sent = (this.sent ?? []).concat(text);
    this.push('status', { status: 'working' });
    this.push('turn.start', { turnId: 't1', text });
    this.push('item.start', { id: 'i1', kind: 'text', turnId: 't1' });
    this.push('item.delta', { id: 'i1', text: 'hello' });
  }
  ask() {
    this.push('status', { status: 'blocked' });
    this.push('permission.request', { requestId: 'r1', kind: 'command', title: 'Run a command', options: [] });
    this.pending.set('r1', {});
  }
  async answer(requestId, decision) {
    this.answered = { requestId, decision };
    this.pending.delete(requestId);
    this.push('permission.resolved', { requestId, decision: decision.option });
    this.push('status', { status: 'working' });
  }
  async interrupt() { this.interrupted = true; }
  async setMode(m) { this.mode = m; }
  async setModel(m) { this.model = m; }
  async setEffort(e) { this.effort = e; }
  async compact(hint) { this.compacted = hint ?? ''; }
  async kill() { this.killed = true; this.push('status', { status: 'exited' }); }
}

test('a headless session: start, stream, watch, prompt, resume, kill', async (t) => {
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const { EventLog } = await import('../packages/connect/src/events.js');
  const events = new EventLog(join(process.env.CON_DIR, 'events'));
  const sessions = new Sessions(new StubRuntime(), { events, makeDriver: (engine, opts) => new FakeDriver({ engine, ...opts }) });

  const updates = [];
  const pushed = [];
  sessions.on('session', (s) => updates.push(s.status));
  sessions.on('event', (e) => pushed.push(e));

  const s = await sessions.start({ cwd: '/tmp', profileId: 'claudea', mode: 'acceptEdits', model: 'opus', effort: 'high' });
  assert.equal(s.driver, 'claude');
  assert.equal(s.mode, 'acceptEdits');
  assert.equal(s.engineSessionId, 'engine-1');
  const d = FakeDriver.made.at(-1);
  assert.equal(d.cmd, 'claude');
  assert.deepEqual(d.args, ['--model', 'x']);
  assert.ok(d.env.CLAUDE_CONFIG_DIR.endsWith('/.claude-personal'), 'the account home is passed through');
  assert.equal(d.model, 'opus');
  assert.ok(d.started);

  const listed = (await sessions.list()).find((x) => x.id === s.id);
  assert.equal(listed.alive, true);
  assert.equal(listed.pending, 0);

  await sessions.input(s.id, 'hi\n');
  assert.deepEqual(d.sent, ['hi']);
  const h = sessions.history(s.id);
  // The first turn.start is con's own optimistic `local-` turn, posted the
  // moment the message is sent; the second is the agent echoing it back
  // under its own id once it picks the message up.
  assert.deepEqual(h.events.map((e) => e.type), ['turn.start', 'status', 'turn.start', 'item.start', 'item.delta']);
  assert.ok(h.events[0].turnId.startsWith('local-'));
  assert.deepEqual(h.events.map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.equal(sessions.history(s.id, { since: 4 }).events.length, 1);
  assert.equal(pushed.length, 5, 'every event reaches the daemon; the daemon decides who gets it');
  assert.ok(updates.includes('working'));

  // A prompt: the session is blocked, the prompt is pending, and answering it clears it.
  d.ask();
  assert.equal((await sessions.list()).find((x) => x.id === s.id).status, 'blocked');
  assert.equal(sessions.history(s.id).pending.length, 1);
  assert.equal(sessions.history(s.id).pending[0].requestId, 'r1');
  await sessions.answer(s.id, 'r1', { option: 'allow' });
  assert.deepEqual(d.answered, { requestId: 'r1', decision: { option: 'allow' } });
  assert.equal(sessions.history(s.id).pending.length, 0);

  // Watching has a TTL.
  assert.equal(sessions.watching(s.id), false);
  sessions.watch(s.id);
  assert.equal(sessions.watching(s.id), true);
  sessions.unwatch(s.id);
  assert.equal(sessions.watching(s.id), false);

  // Mode and model changes reach the driver and the record.
  await sessions.setMode(s.id, 'plan');
  await sessions.setModel(s.id, 'sonnet');
  assert.equal(d.mode, 'plan');
  assert.equal(d.model, 'sonnet');
  assert.equal(sessions.get(s.id).mode, 'plan');

  // The process going away is not the end of the session: the next message resumes it.
  d.push('status', { status: 'idle' });
  d.push('status', { status: 'exited' });
  assert.equal(sessions.get(s.id).status, 'idle');
  assert.equal((await sessions.list()).find((x) => x.id === s.id).alive, false);

  // Archiving hides the thread without stopping it, and unarchiving restores it.
  await sessions.archive(s.id);
  assert.equal((await sessions.list()).find((x) => x.id === s.id).archived, true);
  assert.equal(sessions.get(s.id).status, 'idle');
  await sessions.archive(s.id, false);
  assert.equal((await sessions.list()).find((x) => x.id === s.id).archived, false);

  await sessions.input(s.id, 'again');
  const d2 = FakeDriver.made.at(-1);
  assert.notEqual(d2, d);
  assert.equal(d2.engineSessionId, 'engine-1', 'resumed with the same engine session');
  assert.equal(d2.mode, 'plan');

  // Kill removes the record and the log.
  await sessions.kill(s.id);
  assert.ok(d2.killed);
  assert.throws(() => sessions.get(s.id), /unknown session/);
  assert.equal(events.since(s.id, 0).length, 0);
});

test('a daemon restart lists a driven session as idle and resumable', async (t) => {
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const sessions = new Sessions(new StubRuntime(), { makeDriver: (engine, opts) => new FakeDriver({ engine, ...opts }) });
  const s = await sessions.start({ cwd: '/tmp', profileId: 'claudea' });
  const again = new Sessions(new StubRuntime(), { makeDriver: (engine, opts) => new FakeDriver({ engine, ...opts }) });
  again.resume();
  const listed = (await again.list()).find((x) => x.id === s.id);
  assert.equal(listed.alive, false);
  assert.equal(listed.status, 'idle');
  assert.equal(listed.mode, 'default');
  t.after(() => again.kill(s.id));
});

test('the model the CLI reports is kept, so the app can name what is running', async () => {
  // Neither CLI takes a model unless one is chosen, but both announce what
  // they started with. Without keeping it the chip has nothing to show but
  // the word "model", which is what the owner saw.
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const sessions = new Sessions(new StubRuntime(), {
    makeDriver: (engine, opts) => new FakeDriver({ engine, ...opts }),
  });
  const s = await sessions.start({ cwd: '/tmp', profileId: 'claudea' });
  const updates = [];
  sessions.on('session', (rec) => updates.push({ model: rec.engineModel, effort: rec.engineEffort }));

  const driver = FakeDriver.made[FakeDriver.made.length - 1];
  driver.emit('init', { model: 'claude-fable-5-1', effort: 'high' });

  const listed = (await sessions.list()).find((x) => x.id === s.id);
  assert.equal(listed.engineModel, 'claude-fable-5-1');
  assert.equal(listed.engineEffort, 'high');
  assert.ok(updates.some((u) => u.model === 'claude-fable-5-1'), 'the app is told');
  // Reported, not chosen: it must not become an argument on the next launch.
  assert.equal(listed.model, null);

  // The same announcement again is not news.
  const before = updates.length;
  driver.emit('init', { model: 'claude-fable-5-1', effort: 'high' });
  assert.equal(updates.length, before);
  await sessions.kill(s.id);
});

test('images ride the driver when it implements the verb, else a placeholder', async () => {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(process.env.CON_DIR, { recursive: true });
  writeFileSync(join(process.env.CON_DIR, 'profiles.json'), JSON.stringify({
    version: 1,
    profiles: [{ id: 'claudea', label: 'Claude', engine: 'claude', cmd: 'claude', args: [], env: {}, source: 'alias' }],
  }));
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const { EventLog } = await import('../packages/connect/src/events.js');

  // A driver without sendWithAttachments: the model gets words, not bytes.
  const plain = new Sessions(new StubRuntime(), {
    events: new EventLog(join(process.env.CON_DIR, 'events-plain')),
    makeDriver: (engine, opts) => new FakeDriver({ engine, ...opts }),
  });
  const s1 = await plain.start({ cwd: '/tmp', profileId: 'claudea' });
  await plain.input(s1.id, 'look', { attachments: [{ filename: 'a.png', mime: 'image/png', data: 'iVBORw0KGgo=' }] });
  const d1 = FakeDriver.made.at(-1);
  assert.match(d1.sent.at(-1), /look\n\[image: a\.png - this agent cannot see images\]/);
  // And the owner is told, rather than the bytes going quietly missing.
  const said = plain.events.since(s1.id, 0).filter((e) => e.type === 'error' && e.kind === 'attachment');
  assert.equal(said.length, 1);
  assert.match(said[0].message, /cannot be sent images/);

  // A driver with the verb gets the bytes.
  class ImageDriver extends FakeDriver {
    async sendWithAttachments(text, attachments) { this.gotAttachments = { text, attachments }; }
  }
  const rich = new Sessions(new StubRuntime(), {
    events: new EventLog(join(process.env.CON_DIR, 'events-rich')),
    makeDriver: (engine, opts) => new ImageDriver({ engine, ...opts }),
  });
  const s2 = await rich.start({ cwd: '/tmp', profileId: 'claudea' });
  const atts = [{ filename: 'b.png', mime: 'image/png', data: 'iVBORw0KGgo=' }];
  await rich.input(s2.id, 'look', { attachments: atts });
  const d2 = ImageDriver.made.at(-1);
  assert.equal(d2.gotAttachments.text, 'look');
  assert.deepEqual(d2.gotAttachments.attachments, atts);

  // The verb is not enough: an ACP agent that said at `initialize` that it
  // takes no images must not be handed any. This is the case that used to
  // pass the UI's check and fail silently at the wire.
  class BlindDriver extends ImageDriver {
    acceptsImages() { return false; }
  }
  const blind = new Sessions(new StubRuntime(), {
    events: new EventLog(join(process.env.CON_DIR, 'events-blind')),
    makeDriver: (engine, opts) => new BlindDriver({ engine, ...opts }),
  });
  const s3 = await blind.start({ cwd: '/tmp', profileId: 'claudea' });
  await blind.input(s3.id, 'look', { attachments: atts });
  const d3 = BlindDriver.made.at(-1);
  assert.equal(d3.gotAttachments, undefined);
  assert.match(d3.sent.at(-1), /cannot see images/);

  // An ACP agent only answers this in its reply to `initialize`, and the
  // driver is started lazily - so a driver asked before it is up says "no"
  // for an agent that would have said yes. Devin did exactly that in the
  // real app: the clip was there, the picture previewed, and the model was
  // handed the string `[image: dot.jpg]`.
  class LateDriver extends ImageDriver {
    #up = false;
    async start() { this.#up = true; }
    acceptsImages() { return this.#up; }
  }
  const late = new Sessions(new StubRuntime(), {
    events: new EventLog(join(process.env.CON_DIR, 'events-late')),
    makeDriver: (engine, opts) => new LateDriver({ engine, ...opts }),
  });
  const s4 = await late.start({ cwd: '/tmp', profileId: 'claudea' });
  await late.input(s4.id, 'look', { attachments: atts });
  const d4 = LateDriver.made.at(-1);
  assert.deepEqual(d4.gotAttachments?.attachments, atts, 'the image reaches an agent that starts up saying yes');
});

test('an attached image survives a restart, and nonsense is refused', async () => {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(process.env.CON_DIR, { recursive: true });
  writeFileSync(join(process.env.CON_DIR, 'profiles.json'), JSON.stringify({
    version: 1,
    profiles: [{ id: 'claudea', label: 'Claude', engine: 'claude', cmd: 'claude', args: [], env: {}, source: 'alias' }],
  }));
  const { Sessions, acceptImages } = await import('../packages/connect/src/sessions.js');
  const { EventLog } = await import('../packages/connect/src/events.js');

  const dir = join(process.env.CON_DIR, 'events-durable');
  const data = 'iVBORw0KGgo=';
  const sessions = new Sessions(new StubRuntime(), {
    events: new EventLog(dir),
    makeDriver: (engine, opts) => new FakeDriver({ engine, ...opts }),
  });
  const s = await sessions.start({ cwd: '/tmp', profileId: 'claudea' });
  await sessions.input(s.id, 'look', { attachments: [{ filename: 'a.png', mime: 'image/png', data }] });

  // A fresh log over the same directory is what a restarted daemon sees.
  // The old code wrote 80 characters of base64 and an ellipsis here, so the
  // owner's own picture came back as a broken thumbnail.
  const reopened = new EventLog(dir);
  const turn = reopened.since(s.id, 0).find((e) => e.type === 'turn.start' && e.attachments?.length);
  assert.ok(turn, 'the turn carrying the image is in the log');
  assert.equal(turn.attachments[0].data, data);
  assert.equal(turn.attachments[0].filename, 'a.png');

  // What a client may send is checked here, not only in the browser.
  assert.throws(() => acceptImages([{ filename: 'notes.txt', mime: 'text/plain', data }]), /only images/);
  assert.throws(() => acceptImages([{ filename: 'a.png', mime: 'image/png', data: 'not base64!' }]), /valid base64/);
  assert.throws(() => acceptImages(Array.from({ length: 9 }, () => ({ filename: 'a.png', mime: 'image/png', data }))), /too many/);
  assert.deepEqual(acceptImages([]), []);
  assert.deepEqual(acceptImages(undefined), []);
});

test('model and effort switch mid-session on the live driver', async () => {
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const sessions = new Sessions(new StubRuntime(), {
    makeDriver: (engine, opts) => new FakeDriver({ engine, ...opts }),
  });
  const s = await sessions.start({ cwd: '/tmp', profileId: 'claudea' });
  await sessions.input(s.id, 'hi');
  await sessions.setModel(s.id, 'claude-sonnet-5');
  await sessions.setEffort(s.id, 'max');
  const d = FakeDriver.made.at(-1);
  assert.equal(d.model, 'claude-sonnet-5');
  assert.equal(d.effort, 'max');
  assert.equal(sessions.get(s.id).model, 'claude-sonnet-5');
  assert.equal(sessions.get(s.id).effort, 'max');
  await sessions.kill(s.id);
});


test('/compact delegates to the driver', async () => {
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const { EventLog } = await import('../packages/connect/src/events.js');
  const sessions = new Sessions(new StubRuntime(), {
    events: new EventLog(join(process.env.CON_DIR, 'events-slash')),
    makeDriver: (engine, opts) => new FakeDriver({ engine, ...opts }),
  });
  const s = await sessions.start({ cwd: '/tmp', profileId: 'claudea' });
  const d = FakeDriver.made.at(-1);

  await sessions.input(s.id, '/compact focus on auth');
  assert.equal(d.compacted, 'focus on auth');
  await sessions.kill(s.id);
});

test('a session names itself after two prompts, not one', async () => {
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const { EventLog } = await import('../packages/connect/src/events.js');
  const sessions = new Sessions(new StubRuntime(), {
    events: new EventLog(join(process.env.CON_DIR, 'events-titles')),
    makeDriver: (engine, opts) => new FakeDriver({ engine, ...opts }),
  });
  const s = await sessions.start({ cwd: '/tmp/proj', profileId: 'claudea' });
  assert.equal(s.title, 'proj', 'the folder is the name until one is earned');
  const d = FakeDriver.made.at(-1);

  // One prompt in, a title that is just the prompt back is not trusted:
  // half the time that prompt is "hi".
  await sessions.input(s.id, 'hi');
  d.push('title', { title: 'hi' });
  assert.equal(sessions.get(s.id).title, 'proj');

  // Two prompts in, the gate opens. The agent only ever said "hi", so the
  // prompts themselves name the session - then the agent's real title,
  // arriving late, outranks that.
  await sessions.input(s.id, 'fix the login bug');
  assert.equal(sessions.get(s.id).title, 'fix the login bug');
  d.push('title', { title: 'Login bug fix' });
  assert.equal(sessions.get(s.id).title, 'Login bug fix');
  await sessions.kill(s.id);
});

test('greetings never name a session, whoever says them', async () => {
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const { EventLog } = await import('../packages/connect/src/events.js');
  const sessions = new Sessions(new StubRuntime(), {
    events: new EventLog(join(process.env.CON_DIR, 'events-titles-greet')),
    makeDriver: (engine, opts) => new FakeDriver({ engine, ...opts }),
  });
  const s = await sessions.start({ cwd: '/tmp/proj', profileId: 'claudea' });
  const d = () => FakeDriver.made.at(-1);

  // Two prompts in and nothing worth a name yet: the gate has opened but
  // there is nothing behind it, so the folder holds.
  await sessions.input(s.id, 'hi');
  await sessions.input(s.id, 'hello');
  assert.equal(sessions.get(s.id).title, 'proj');

  // The third prompt says something, and names the session even though the
  // gate opened on the ones that did not.
  await sessions.input(s.id, 'port the parser to the new lexer');
  assert.equal(sessions.get(s.id).title, 'port the parser to the new lexer');

  // The agent keeps reporting a name, and early on that name is a copy of
  // whatever was last typed. A greeting must not take the one just earned.
  d().push('title', { title: 'hey' });
  assert.equal(sessions.get(s.id).title, 'port the parser to the new lexer');
  await sessions.input(s.id, 'thanks');
  d().push('title', { title: 'thanks' });
  assert.equal(sessions.get(s.id).title, 'port the parser to the new lexer');
  await sessions.kill(s.id);
});

test('the prompt sample stays on the machine', async () => {
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const { EventLog } = await import('../packages/connect/src/events.js');
  const sessions = new Sessions(new StubRuntime(), {
    events: new EventLog(join(process.env.CON_DIR, 'events-titles-wire')),
    makeDriver: (engine, opts) => new FakeDriver({ engine, ...opts }),
  });
  const s = await sessions.start({ cwd: '/tmp/proj', profileId: 'claudea' });
  await sessions.input(s.id, 'the whole first paragraph of what I want');
  const listed = (await sessions.list()).find((x) => x.id === s.id);
  assert.equal(listed.promptSample, undefined, 'prompts are not shipped to every paired device');
  assert.equal(sessions.get(s.id).promptSample.length, 1, 'but con still keeps them to name the session');
  await sessions.kill(s.id);
});

test('a name typed at start is never overwritten by a generated one', async () => {
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const { EventLog } = await import('../packages/connect/src/events.js');
  const sessions = new Sessions(new StubRuntime(), {
    events: new EventLog(join(process.env.CON_DIR, 'events-titles-user')),
    makeDriver: (engine, opts) => new FakeDriver({ engine, ...opts }),
  });
  const s = await sessions.start({ cwd: '/tmp', profileId: 'claudea', title: 'build' });
  await sessions.input(s.id, 'one');
  await sessions.input(s.id, 'two');
  FakeDriver.made.at(-1).push('title', { title: 'something else entirely' });
  assert.equal(sessions.get(s.id).title, 'build');
  await sessions.kill(s.id);
});

test('a name the owner types wins, before and after the gate', async () => {
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const { EventLog } = await import('../packages/connect/src/events.js');
  const sessions = new Sessions(new StubRuntime(), {
    events: new EventLog(join(process.env.CON_DIR, 'events-rename')),
    makeDriver: (engine, opts) => new FakeDriver({ engine, ...opts }),
  });
  const s = await sessions.start({ cwd: '/tmp/proj', profileId: 'claudea' });

  // Renaming does not wait for the two prompts a *generated* name waits for.
  sessions.rename(s.id, '  the parser   rewrite  ');
  assert.equal(sessions.get(s.id).title, 'the parser rewrite', 'squashed, trimmed, taken');

  // And nothing generated takes it back afterwards.
  await sessions.input(s.id, 'port the parser to the new lexer');
  await sessions.input(s.id, 'now do the tests');
  FakeDriver.made.at(-1).push('title', { title: 'Parser and lexer work' });
  assert.equal(sessions.get(s.id).title, 'the parser rewrite');

  assert.throws(() => sessions.rename(s.id, '   '), /needs a name/);
  assert.throws(() => sessions.rename('pane:nope:1', 'x'), /external session/);
  await sessions.kill(s.id);
});

test('a thread keeps what it has cost', async () => {
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const { EventLog } = await import('../packages/connect/src/events.js');
  const sessions = new Sessions(new StubRuntime(), {
    events: new EventLog(join(process.env.CON_DIR, 'events-cost')),
    makeDriver: (engine, opts) => new FakeDriver({ engine, ...opts }),
  });
  const s = await sessions.start({ cwd: '/tmp/proj', profileId: 'claudea' });
  const d = FakeDriver.made.at(-1);

  d.push('turn.done', { turnId: 't1', status: 'ok', costUsd: 0.0712 });
  d.push('turn.done', { turnId: 't2', status: 'interrupted' });
  d.push('turn.done', { turnId: 't3', status: 'ok', costUsd: 0.0119 });
  const listed = (await sessions.list()).find((x) => x.id === s.id);
  assert.equal(listed.turns, 3, 'an interrupted turn still happened');
  assert.equal(listed.costUsd, 0.0831, 'and the cents do not drift');
  await sessions.kill(s.id);
});

test('work con did not start can be filed away or struck off', async () => {
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const { EventLog } = await import('../packages/connect/src/events.js');
  // A machine with a pane con never started, which is what the runtime
  // reports for anything the owner opened at the keyboard.
  class WithPane extends StubRuntime {
    async listLive() {
      return new Map([['w1:p1', { workspaceId: 'w1', tabId: 'w1:t1', cwd: '/tmp/x', engine: 'claude', status: 'idle' }]]);
    }
  }
  const sessions = new Sessions(new WithPane(), {
    events: new EventLog(join(process.env.CON_DIR, 'events-external')),
    makeDriver: (engine, opts) => new FakeDriver({ engine, ...opts }),
  });

  const pane = () => sessions.list().then((l) => l.find((x) => x.id === 'pane:w1:p1'));
  assert.equal((await pane()).archived, false, 'listed, and not filed away');

  // Archiving one is reversible and says so in the list.
  sessions.archive('pane:w1:p1', true);
  assert.equal((await pane()).archived, true);
  sessions.archive('pane:w1:p1', false);
  assert.equal((await pane()).archived, false);

  // A thread read out of a CLI's own history has no record and no process:
  // "delete" means stop listing it, and nothing else.
  assert.deepEqual(sessions.marks(), {});
  await sessions.kill('found:claude:abc123');
  assert.deepEqual(sessions.marks(), { 'found:claude:abc123': 'removed' });
  sessions.archive('found:codex:def456', true);
  assert.equal(sessions.marks()['found:codex:def456'], 'archived');

  // And a dismissed pane stops being listed at all.
  await sessions.kill('found:claude:abc123');
  sessions.archive('pane:w1:p1', true);
  assert.equal((await pane()).archived, true, 'still there, filed');
});

test('terminals are numbered by the machine, not guessed by the app', async () => {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(process.env.CON_DIR, { recursive: true });
  writeFileSync(join(process.env.CON_DIR, 'profiles.json'), JSON.stringify({
    version: 1,
    profiles: [{ id: 'shell', label: 'Shell', engine: 'shell', cmd: '/bin/sh', args: [], env: {}, source: 'builtin' }],
  }));
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const { EventLog } = await import('../packages/connect/src/events.js');

  // A stand-in for the pty host: opening always works, nothing really runs.
  const { EventEmitter } = await import('node:events');
  const terminals = Object.assign(new EventEmitter(), {
    ensure: async () => true,
    open: async () => ({}),
    has: () => true,
    adopt: async () => [],
  });
  const sessions = new Sessions(new StubRuntime(), {
    events: new EventLog(join(process.env.CON_DIR, 'events-term')),
    terminals,
  });

  // Two in a row, with nothing reloaded in between: the case that produced
  // two terminals both called "Terminal 1".
  const [a, b] = await Promise.all([
    sessions.start({ cwd: '/tmp', profileId: 'shell' }),
    sessions.start({ cwd: '/tmp', profileId: 'shell' }),
  ]);
  const c = await sessions.start({ cwd: '/tmp', profileId: 'shell' });
  const names = [a.title, b.title, c.title];
  assert.equal(new Set(names).size, 3, `all different, got ${names.join(', ')}`);
  assert.ok(names.includes('Terminal 3'), `counted up, got ${names.join(', ')}`);

  // A name the caller chose is still theirs.
  const named = await sessions.start({ cwd: '/tmp', profileId: 'shell', title: 'build' });
  assert.equal(named.title, 'build');
});

test('a chat asks for its end, and is told what is behind it', async () => {
  // The test above leaves only a shell profile behind; this one needs the
  // agent account back.
  writeFileSync(join(process.env.CON_DIR, 'profiles.json'), JSON.stringify({
    version: 1,
    profiles: [{ id: 'claudea', label: 'Claude · personal', engine: 'claude', cmd: 'claude', args: [], env: {}, source: 'alias' }],
  }));
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const { EventLog } = await import('../packages/connect/src/events.js');
  const events = new EventLog(mkdtempSync(join(tmpdir(), 'con-history-')));
  const sessions = new Sessions(new StubRuntime(), { events, makeDriver: (engine, opts) => new FakeDriver({ engine, ...opts }) });
  const s = await sessions.start({ cwd: '/tmp', profileId: 'claudea' });
  events.append(s.id, { type: 'turn.start', turnId: 't1', text: 'one long turn' });
  for (let i = 0; i < 40; i++) {
    events.append(s.id, {
      type: 'item.start', id: `i${i}`, kind: 'edit', turnId: 't1',
      changes: [{ path: `f${i}.ts`, kind: 'update', diff: 'd'.repeat(30_000) }],
    });
  }

  const open = sessions.history(s.id, { tail: 300 });
  assert.ok(JSON.stringify(open.events).length <= 200_000, 'the reply fits one page');
  assert.equal(open.events[0].type, 'turn.start', 'and hangs off the turn it is inside');
  assert.ok(open.firstSeq > open.logFirst, 'the app is told there is more behind it');
  assert.equal(open.last, events.last(s.id), 'and where the live edge is');
  assert.ok(open.events[open.events.length - 1].seq === open.last, 'the window ends at the end');

  const back = sessions.history(s.id, { before: open.firstSeq });
  assert.ok(back.events.length, 'earlier fetches what is behind');
  assert.ok(back.events[back.events.length - 1].seq < open.firstSeq);

  // Every diff was capped on the way out, whatever the driver wrote.
  for (const e of open.events) {
    for (const c of e.changes ?? []) assert.ok(c.diff.length < 9_000, 'diffs are capped on the wire');
  }
});
