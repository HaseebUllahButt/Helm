import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId, setFake, setup } from './sudo-fixture.mjs';

// helm sudo: the card, Allow once, Allow for 15 min, Deny, the password,
// and a Helm restart. A fake sudo on PATH stands in for the real one.

/** Read until the request ends, the way helm sudo does. */
async function finish(runs, requestId) {
  let from = 0, out = '', err = '';
  for (;;) {
    const w = await runs.wait({ requestId, from, wait: 5000 });
    for (const c of w.output) { const text = Buffer.from(c.d, 'base64').toString(); if (c.s === 'err') err += text; else out += text; }
    from = w.next;
    if (!['asking', 'running'].includes(w.state)) return { ...w, out, err };
  }
}

test('the card shows, and Allow once runs the command as admin', async (t) => {
  const { sessions, session, runs, cards, events, ask } = await setup(t);
  const asked = await ask('echo "hello from $(pwd)"; echo oops >&2', { reason: 'Install a package' });
  assert.equal(asked.state, 'asking');
  const [card] = cards();
  assert.equal(card.title, 'Run as admin');
  assert.equal(card.kind, 'command');
  assert.equal(card.detail, 'echo "hello from $(pwd)"; echo oops >&2');
  assert.equal(card.reason, 'Install a package. Folder: /tmp');
  assert.deepEqual(card.options.map((o) => [o.id, o.role, o.label]), [
    ['allow', 'allow', 'Allow once'], ['allow-15', 'allow-always', 'Allow for 15 min'], ['deny', 'deny', 'Deny']]);
  assert.equal(card.allowEdit, false);
  assert.equal(sessions.get(session.id).status, 'blocked');

  await sessions.answer(session.id, asked.requestId, { option: 'allow' });
  const result = await finish(runs, asked.requestId);
  assert.equal(result.state, 'done');
  assert.equal(result.exitCode, 0);
  assert.equal(result.out, 'hello from /tmp\n');
  assert.equal(result.err, 'oops\n');
  assert.equal(cards().length, 0);
  assert.equal(sessions.get(session.id).status, 'working');
  // The chat says what ran as admin; the password is nowhere in it.
  const start = events().find((e) => e.type === 'item.start' && e.id === asked.requestId);
  assert.equal(start.name, 'sudo');
  assert.equal(events().find((e) => e.type === 'item.done' && e.id === asked.requestId).exitCode, 0);
  assert.equal(JSON.stringify(events()).includes('right horse'), false);
});

test('the chat keeps waiting while the card is open, in its list and its log', async (t) => {
  const { sessions, session, driver, ask, events } = await setup(t);
  const asked = await ask('echo hi');
  // The agent's tool still runs, and its CLI says "working" again.
  driver.push('status', { status: 'working' });
  assert.equal(sessions.get(session.id).status, 'blocked');
  assert.equal(events().filter((e) => e.type === 'status').at(-1).status, 'blocked');
  await sessions.answer(session.id, asked.requestId, { option: 'deny' });
  assert.equal(sessions.get(session.id).status, 'working');
  assert.equal(events().filter((e) => e.type === 'status').at(-1).status, 'working');
});

test('Deny with a note: the command does not run, and the note goes to helm sudo, not the chat', async (t) => {
  const { sessions, session, runs, cards, events, ask } = await setup(t);
  const asked = await ask('touch /tmp/never');
  const sent = sessions.history(session.id).events.filter((e) => e.type === 'turn.start').length;
  await sessions.answer(session.id, asked.requestId, { option: 'deny', message: 'Use apt instead.' });
  const result = await finish(runs, asked.requestId);
  assert.equal(result.state, 'denied');
  assert.equal(result.note, 'Use apt instead.');
  assert.equal(cards().length, 0);
  assert.equal(events().filter((e) => e.type === 'turn.start').length, sent);
  assert.equal(events().some((e) => e.type === 'item.start' && e.id === asked.requestId), false);
  // A second answer finds nothing open.
  await assert.rejects(sessions.answer(session.id, asked.requestId, { option: 'allow' }), /no longer open/);
});

test('Allow for 15 min skips the card for that chat, and it ends', async (t) => {
  let clock = Date.now();
  const { sessions, session, runs, cards, ask } = await setup(t, { now: () => clock });
  const first = await ask('echo one');
  await sessions.answer(session.id, first.requestId, { option: 'always' });
  assert.equal((await finish(runs, first.requestId)).out, 'one\n');

  const second = await ask('echo two');
  assert.equal(second.state, 'running');
  assert.equal(cards().length, 0);
  assert.equal((await finish(runs, second.requestId)).out, 'two\n');
  assert.deepEqual(runs.allows().map((a) => a.id), [session.id]);

  // 15 minutes later the card is back.
  clock += 15 * 60_000 + 1;
  const third = await ask('echo three');
  assert.equal(third.state, 'asking');
  await sessions.answer(session.id, third.requestId, { option: 'always' });
  await finish(runs, third.requestId);

  // The owner ends it early.
  await runs.setup({ do: 'stop', sessionId: session.id });
  assert.equal((await ask('echo four')).state, 'asking');
});

test('a wrong saved password says so, and sudo\'s own words stay out', async (t) => {
  const { sessions, session, runs, ask } = await setup(t, { saved: 'old horse' });
  const asked = await ask('echo hi');
  await sessions.answer(session.id, asked.requestId, { option: 'allow' });
  const result = await finish(runs, asked.requestId);
  assert.equal(result.state, 'failed');
  assert.equal(result.message, 'The saved admin password is wrong. Ask the owner to save it again.');
  assert.equal(result.out + result.err, '');
});

test('with no saved password, helm sudo fails before any card', async (t) => {
  const { ask, cards } = await setup(t, { saved: null });
  const asked = await ask('echo hi');
  assert.equal(asked.state, 'failed');
  assert.equal(asked.message, 'No admin password is saved on testbox. Ask the owner to save it: in the Helm app Settings, or with helm sudo password on that machine.');
  assert.equal(cards().length, 0);
});

test('a machine where sudo needs no password runs with none saved', async (t) => {
  const { sessions, session, runs, ask } = await setup(t, { password: 'nopass', saved: null });
  const asked = await ask('echo free');
  assert.equal(asked.state, 'asking');
  await sessions.answer(session.id, asked.requestId, { option: 'allow' });
  assert.equal((await finish(runs, asked.requestId)).out, 'free\n');
  assert.equal((await runs.status()).needsPassword, false);
});

test('after a restart, the same request id shows the card again; a command that ran is never run again', async (t) => {
  const { sessions, session, make, cards, ask } = await setup(t);
  const asked = await ask('echo again');
  sessions.helmAsks.stop();
  // A new Helm: the old card closes, helm sudo asks again with its id.
  let runs = make();
  assert.equal(cards().length, 0);
  assert.equal(sessions.get(session.id).status, 'working');
  assert.equal((await runs.wait({ requestId: asked.requestId, from: 0, wait: 0 })).state, 'unknown');
  const again = await ask('echo again', { requestId: asked.requestId });
  assert.equal(again.state, 'asking');
  // Asked twice, it is still one card.
  await ask('echo again', { requestId: asked.requestId });
  assert.equal(cards().length, 1);

  // Now it runs, and Helm restarts while it does.
  await sessions.answer(session.id, asked.requestId, { option: 'allow' });
  sessions.helmAsks.stop();
  runs = make();
  const lost = await runs.wait({ requestId: asked.requestId, from: 0, wait: 0 });
  assert.equal(lost.state, 'lost');
  assert.match(lost.message, /Check the result before you run it again/);
  assert.equal((await ask('echo again', { requestId: asked.requestId })).state, 'lost');
});

test('cancel closes the card, and stops a running command', async (t) => {
  const { sessions, session, runs, cards, ask } = await setup(t);
  const asked = await ask('echo never');
  runs.cancel({ requestId: asked.requestId });
  assert.equal(cards().length, 0);
  assert.equal((await finish(runs, asked.requestId)).state, 'cancelled');

  const long = await ask('trap "echo stopped; exit 7" INT; echo started; while :; do sleep 0.05; done');
  await sessions.answer(session.id, long.requestId, { option: 'allow' });
  // Wait for the command to say it started, then stop it.
  let from = 0;
  for (let said = ''; !said.includes('started');) {
    const w = await runs.wait({ requestId: long.requestId, from, wait: 5000 });
    for (const c of w.output) said += Buffer.from(c.d, 'base64');
    from = w.next;
  }
  runs.cancel({ requestId: long.requestId });
  const result = await finish(runs, long.requestId);
  assert.equal(result.state, 'done');
  assert.equal(result.exitCode, 7);
});

test('the owner saves the password only when sudo takes it; it is sealed at rest', async () => {
  setFake('right horse');
  const { saveAdminPassword, AdminPassword, KEY_NAME, SEALED_NAME } = await import('../packages/connect/src/sudo.js');
  const dir = mkdtempSync(join(process.env.HELM_DIR, 'seal-'));
  await assert.rejects(saveAdminPassword(Buffer.from('wrong'), { dir }), /did not accept/);
  assert.equal(existsSync(join(dir, SEALED_NAME)), false);
  await saveAdminPassword(Buffer.from('right horse'), { dir });
  const sealed = readFileSync(join(dir, SEALED_NAME));
  assert.equal(sealed.includes(Buffer.from('right horse')), false);
  assert.equal(statSync(join(dir, SEALED_NAME)).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, KEY_NAME)).mode & 0o777, 0o600);
  assert.equal(new AdminPassword(dir).read().toString(), 'right horse');
  new AdminPassword(dir).forget();
  assert.equal(new AdminPassword(dir).saved(), false);
});

test('status never holds the password, and other machines are refused', async (t) => {
  const { runs } = await setup(t);
  const status = await runs.dispatch('sudo.setup', { do: 'status' }, { trusted: true });
  assert.equal(status.saved, true);
  assert.equal(JSON.stringify(status).includes('right horse'), false);
  await assert.rejects(runs.dispatch('sudo.setup', { do: 'forget' }, { trusted: false }), /Only this machine/);
  await assert.rejects(runs.dispatch('sudo.ask', {}, { trusted: false }), /Only this machine/);
});

test('a backup leaves the admin password out', async () => {
  const { createBackup } = await import('../packages/connect/src/backup.js');
  const { AdminPassword } = await import('../packages/connect/src/sudo.js');
  const source = mkdtempSync(join(process.env.HELM_DIR, 'backup-src-'));
  writeFileSync(join(source, 'config.json'), '{}');
  new AdminPassword(join(source, 'sudo')).save(Buffer.from('right horse'));
  const result = createBackup({ source, destination: join(process.env.HELM_DIR, `${newId()}.helmbk`), password: Buffer.alloc(16, 1), offline: true });
  assert.equal(result.files, 1);
});
