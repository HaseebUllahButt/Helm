import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { setFake, setup } from './sudo-fixture.mjs';

// The agent's side of helm sudo: what it prints, its exit code, a lost
// link, a Helm restart and Ctrl+C.

const sink = () => { let text = ''; return { write: (d) => { text += d; return true; }, get text() { return text; } }; };

/** helm sudo wired to a chat; `answer` decides each card when it shows. */
async function cli(t, { answer = { option: 'allow' }, ...options } = {}) {
  const fixture = await setup(t, options);
  const { sessions, session } = fixture;
  const asks = [];
  let rpc = async (_env, method, params) => {
    if (method === 'sudo.ask') asks.push(params.requestId);
    return sessions.helmAsks.dispatch(method, params, { trusted: true });
  };
  sessions.on('event', ({ id, event }) => {
    if (id !== session.id || event.type !== 'permission.request' || !answer) return;
    setImmediate(() => void sessions.answer(id, event.requestId, typeof answer === 'function' ? answer() : answer).catch(() => {}));
  });
  const { runSudoCommand } = await import('../packages/connect/src/sudo-cli.js');
  const run = async (args, extra = {}) => {
    const out = sink(), err = sink();
    const code = await runSudoCommand(args, {
      rpc: (...a) => rpc(...a), self: () => 'self', env: { HELM_SESSION_ID: session.id }, cwd: '/tmp',
      out, err, dir: fixture.dir, retryMs: 1, ...extra,
    });
    return { code, out: out.text, err: err.text };
  };
  return { ...fixture, asks, run, wrap: (f) => { const inner = rpc; rpc = (...a) => f(inner, ...a); } };
}

test('helm sudo prints the output and ends with the command\'s exit code', async (t) => {
  const { run } = await cli(t);
  const r = await run(['--reason', 'Check the disk', '--', 'echo out; echo err >&2; exit 3']);
  assert.equal(r.code, 3);
  assert.equal(r.out, 'out\n');
  assert.match(r.err, /Waiting for the owner to allow this in the Helm app\.\nerr\n/);
});

test('several words are quoted as given', async (t) => {
  const { run } = await cli(t);
  const r = await run(['--', 'printf', '%s|', 'a b', "it's"]);
  assert.equal(r.out, "a b|it's|");
});

test('a no from the owner is said with the note', async (t) => {
  const { run } = await cli(t, { answer: { option: 'deny', message: 'Not on this machine.' } });
  const r = await run(['--', 'echo hi']);
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.match(r.err, /The owner said no: Not on this machine\.\n$/);
});

test('no saved password: helm sudo waits on the card until the owner saves it', async (t) => {
  const { run, runs, sessions, session } = await cli(t, { saved: null, answer: null });
  sessions.on('event', ({ id, event }) => {
    if (id !== session.id || event.type !== 'permission.request') return;
    assert.equal(event.passwordNeeded, true);
    // The app saves the typed password first, then answers.
    setImmediate(() => void runs.setup({ do: 'save', password: 'right horse' })
      .then(() => sessions.answer(id, event.requestId, { option: 'allow' })));
  });
  const r = await run(['--', 'echo hi']);
  assert.equal(r.out, 'hi\n');
  assert.equal(r.code, 0);
});

test('--machine is not supported yet, and helm sudo needs a chat', async (t) => {
  const { run } = await cli(t);
  const away = await run(['--machine', 'vm', '--', 'echo hi']);
  assert.equal(away.code, 1);
  assert.match(away.err, /--machine is not supported yet/);
  const alone = await run(['--', 'echo hi'], { env: {} });
  assert.match(alone.err, /Run helm sudo in a Helm chat/);
  const bare = await run(['apt', 'update']);
  assert.equal(bare.code, 2);
  assert.match(bare.err, /helm sudo -- apt update/);
});

test('a restart while the card waits: helm sudo asks again with the same id', async (t) => {
  let once = true;
  const fixture = await cli(t);
  const { make, asks, run, wrap } = fixture;
  wrap(async (inner, env, method, params, ms) => {
    // The first wait finds a new Helm that never heard of the request.
    if (method === 'sudo.wait' && once) {
      once = false;
      fixture.sessions.helmAsks.stop();
      make();
      throw new Error('not connected');
    }
    return inner(env, method, params, ms);
  });
  // One card from the old Helm, one from the new.
  let cardsSeen = 0;
  fixture.sessions.prependListener('event', ({ event }) => { if (event.type === 'permission.request') cardsSeen += 1; });
  const r = await run(['--', 'echo back']);
  assert.equal(r.out, 'back\n');
  assert.equal(r.code, 0);
  assert.match(r.err, /Helm is not answering/);
  assert.equal(asks.length, 2);
  assert.equal(new Set(asks).size, 1);
  assert.equal(cardsSeen, 2);
});

test('a restart while the command runs: it is never run again', async (t) => {
  const fixture = await cli(t);
  const { make, asks, run, wrap } = fixture;
  let restarted = false;
  wrap(async (inner, env, method, params, ms) => {
    const result = await inner(env, method, params, ms);
    if (method === 'sudo.wait' && result.state === 'running' && !restarted) {
      restarted = true;
      fixture.sessions.helmAsks.stop();
      make();
    }
    return result;
  });
  const r = await run(['--', 'echo started; sleep 0.3; echo end']);
  assert.equal(r.code, 1);
  assert.match(r.err, /Helm restarted while the admin command ran/);
  assert.equal(asks.length, 1);
});

test('Ctrl+C while the card waits stops the request', async (t) => {
  const signals = new EventEmitter();
  const { run, cards, sessions, session } = await cli(t, { answer: null });
  sessions.on('event', ({ id, event }) => {
    if (id === session.id && event.type === 'permission.request') setImmediate(() => signals.emit('SIGINT'));
  });
  const r = await run(['--', 'echo never'], { signals });
  assert.equal(r.code, 130);
  assert.match(r.err, /Stopped\. The command did not run\./);
  assert.equal(cards().length, 0);
});

test('the owner saves, checks and forgets the password from the command line', async (t) => {
  const { run } = await cli(t, { saved: null });
  const dir = mkdtempSync(join(process.env.HELM_DIR, 'cli-'));
  setFake('right horse');
  const wrong = await run(['password'], { dir, readPassword: async () => Buffer.from('nope') });
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, /did not accept/);
  const saved = await run(['password'], { dir, readPassword: async () => Buffer.from('right horse') });
  assert.equal(saved.code, 0);
  assert.match(saved.out, /^Saved\./);
  assert.match((await run(['forget'], { dir })).out, /forgot the admin password/);
  assert.match((await run(['forget'], { dir })).out, /No admin password was saved/);
});

test('status and stop show and end the 15-minute allows', async (t) => {
  const { run } = await cli(t, { answer: { option: 'always' } });
  await run(['--', 'true']);
  const status = await run(['status']);
  assert.match(status.out, /An admin password is saved/);
  assert.match(status.out, /runs admin commands with no card until/);
  assert.match((await run(['stop'])).out, /Ended all 15-minute allows/);
  assert.match((await run(['status'])).out, /No chat can run admin commands without a card/);
});
