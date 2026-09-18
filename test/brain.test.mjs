import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { EventLog } = await import('../packages/connect/src/events.js');
const {
  lastLine, readThread, localDigest, render, summaryLine, mergeSnapshot,
  readSnapshot, writeSnapshot, shortId, ago, brief,
} = await import('../packages/connect/src/brain.js');

// The digest is the brain's whole picture of the network, so what it says
// has to be true before anything built on it can be.

// Events are flat and incremental - `{ type, ...fields }`, with a tool's
// arguments and a model's whole sentence arriving as separate later events -
// so these fixtures are shaped like the ones in ~/.con/events, not like a
// convenient summary of them.
test('lastLine puts an unanswered permission ahead of everything else', () => {
  const line = lastLine([
    { type: 'turn.start', turnId: 't1', text: 'renew the cert' },
    { type: 'item.start', id: 'i1', kind: 'tool', turnId: 't1', name: 'Bash' },
    { type: 'item.update', id: 'i1', input: { command: 'certbot renew' } },
    { type: 'permission.request', requestId: 'r1', tool: 'Bash', title: 'Bash(certbot renew)' },
  ]);
  assert.equal(line, 'waiting: Bash(certbot renew)');
});

test('a permission that was answered is not still waiting', () => {
  const line = lastLine([
    { type: 'turn.start', turnId: 't1', text: 'tidy up' },
    { type: 'permission.request', requestId: 'r1', title: 'Bash(rm -rf /)' },
    { type: 'permission.resolved', requestId: 'r1', decision: { option: 'deny' } },
    { type: 'item.start', id: 'i2', kind: 'tool', turnId: 't1', name: 'Read' },
    { type: 'item.update', id: 'i2', input: { file_path: 'notes.md' } },
  ]);
  assert.equal(line, 'running: Read(notes.md)');
});

test('a finished tool is not a running one', () => {
  const line = lastLine([
    { type: 'turn.start', turnId: 't1', text: 'read it' },
    { type: 'item.start', id: 'i1', kind: 'tool', turnId: 't1', name: 'Read' },
    { type: 'item.update', id: 'i1', input: { file_path: 'README.md' } },
    { type: 'item.done', id: 'i1', status: 'ok' },
    { type: 'item.start', id: 'i2', kind: 'text', turnId: 't1' },
    { type: 'item.delta', id: 'i2', text: "It is the guide to con.\nAnything else?" },
    { type: 'item.done', id: 'i2', status: 'ok' },
  ]);
  assert.equal(line, 'It is the guide to con.');
});

test('a sentence that arrived as deltas is one line, not none', () => {
  const line = lastLine([
    { type: 'turn.start', turnId: 't1', text: 'hi' },
    { type: 'item.start', id: 'i1', kind: 'text', turnId: 't1' },
    ...'the cert renews on the 14th'.split(' ').map((w) => ({ type: 'item.delta', id: 'i1', text: w + ' ' })),
    { type: 'item.done', id: 'i1', status: 'ok' },
  ]);
  assert.equal(line, 'the cert renews on the 14th');
  assert.equal(lastLine([]), null);
});

test('readThread folds deltas back into the sentence they were', () => {
  const lines = readThread([
    { type: 'turn.start', turnId: 't1', text: 'what is in README.md?' },
    { type: 'item.start', id: 'i1', kind: 'tool', turnId: 't1', name: 'Read' },
    { type: 'item.update', id: 'i1', input: { file_path: '/w/README.md' } },
    { type: 'item.done', id: 'i1', status: 'ok', output: 'x'.repeat(50_000) },
    { type: 'item.start', id: 'i2', kind: 'text', turnId: 't1' },
    ...'it is the guide'.split(' ').map((w) => ({ type: 'item.delta', id: 'i2', text: w + ' ' })),
    { type: 'turn.done', turnId: 't1', status: 'ok', costUsd: 0.12 },
  ]);
  assert.deepEqual(lines, [
    '> what is in README.md?',
    '  · Read(/w/README.md)',
    '  it is the guide',
    '  ($0.12)',
  ]);
});

// A real EventLog, not a stand-in. The first version of this test handed
// localDigest a fake whose `since` returned `{ events: [] }`; the real one
// returns the array itself, so the code read `undefined`, every digest line
// came out blank, and the test agreed with the bug. Reading the log is the
// whole job here, so the log is real.
test('localDigest reads each session line out of the real event log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'con-brain-log-'));
  try {
    const log = new EventLog(dir);
    log.append('a1', { type: 'turn.start', turnId: 't1', text: 'renew the cert' });
    log.append('a1', { type: 'item.start', id: 'i1', kind: 'tool', turnId: 't1', name: 'Bash' });
    log.append('a1', { type: 'item.update', id: 'i1', input: { command: 'certbot renew' } });

    const rows = localDigest([
      { id: 'a1', title: 'live', cwd: '/w', engine: 'claude', status: 'working' },
      { id: 'a2', title: 'filed', cwd: '/w', engine: 'claude', status: 'idle', archived: true },
      { id: 'a3', title: 'over', cwd: '/w', engine: 'claude', status: 'exited' },
    ], log);

    assert.deepEqual(rows.map((r) => r.title), ['live'], 'archived and finished threads are left out');
    assert.equal(rows[0].last, 'running: Bash(certbot renew)');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a pane con did not start contributes no event line', () => {
  let asked = 0;
  const events = { since: () => { asked += 1; return []; } };
  localDigest([{ id: 'pane:w1:p1', title: 'zsh', cwd: '/w', engine: 'shell', status: 'shell' }], events);
  assert.equal(asked, 0, 'con has no event log for a pane it does not own');
});

// An offline machine that simply vanishes is the failure that matters here:
// the brain would report "nothing is running there", which is a wrong answer
// rather than a missing one.
test('a machine that did not answer keeps its last known state, dated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'con-brain-'));
  const file = join(dir, 'snapshot.json');
  try {
    const t0 = Date.now() - 3 * 3600 * 1000;
    writeSnapshot({ at: t0, machines: { lap: { name: 'laptop', at: t0, sessions: [{ id: 'z9', title: 'refactor', cwd: '/w', engine: 'codex', status: 'idle' }] } } }, file);

    const merged = mergeSnapshot(readSnapshot(file), { vm: { name: 'vm', sessions: [] } });
    assert.ok(merged.machines.lap, 'the sleeping machine is still there');
    assert.equal(merged.machines.lap.sessions.length, 1);
    assert.equal(merged.machines.lap.at, t0, 'and still dated when it was last seen');

    const text = render(merged, { roster: { vm: { name: 'vm', online: true }, lap: { name: 'laptop', online: false } } });
    assert.match(text, /laptop \(offline · last seen 3h ago\)/);
    assert.match(text, /refactor/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('render leads with what is waiting on a person', () => {
  const snap = { machines: { vm: { name: 'vm', at: Date.now(), sessions: [
    { id: 'aabbccdd', title: 'deploy', cwd: '/srv', engine: 'claude', status: 'blocked', last: 'waiting: Bash(restart)' },
    { id: 'eeff0011', title: 'tidy', cwd: '/srv', engine: 'codex', status: 'working' },
  ] } } };
  const text = render(snap, { roster: { vm: { name: 'vm', online: true } } });
  assert.match(text.split('\n')[0], /^1 session waiting on you\./);
  assert.match(text, /aabbcc NEEDS YOU/);
  assert.match(text, /waiting: Bash\(restart\)/);
});

test('an empty network says so rather than throwing', () => {
  assert.equal(render({ machines: {} }, { roster: {} }), 'No machines in this network yet.');
});

// The line goes in front of every message the owner sends the brain, so its
// size is a running cost, not a one-off.
test('the prepended line stays one short line', () => {
  const snap = { machines: {} };
  for (let i = 0; i < 40; i += 1) {
    snap.machines[`m${i}`] = { name: `machine-${i}`, at: Date.now(), sessions: Array.from({ length: 20 }, (_, j) => ({ id: `s${i}${j}`, status: j % 3 ? 'idle' : 'working' })) };
  }
  const line = summaryLine(snap, { roster: {} });
  assert.ok(line.length < 120, `one line, got ${line.length}: ${line}`);
  assert.equal(line.split('\n').length, 1);
});

test('the shape the transcript splits back off a brain message', () => {
  // Must match CON_NOTE in apps/web/src/session/Transcript.tsx: one
  // bracketed line, then a blank line, then what the owner typed.
  const line = summaryLine({ machines: { a: { sessions: [] } } }, { roster: { a: { online: true } } });
  const message = `${line}\n\nwhat is waiting on me?`;
  const m = /^(\[con [^\]\n]*\])\n\n([\s\S]*)$/.exec(message);
  assert.ok(m, 'the web regex has to match what the daemon sends');
  assert.equal(m[2], 'what is waiting on me?');
});

test('short ids are short, and strip the prefixes that are not part of them', () => {
  assert.equal(shortId('a1b2c3d4e5f6'), 'a1b2c3');
  assert.equal(shortId('pane:w12:p1'), 'w12:p1');
  assert.equal(shortId('found:claude:abcdef123'), 'abcdef');
});

test('ago says never rather than guessing', () => {
  assert.equal(ago(0), 'never');
  assert.equal(ago(Date.now() - 5000), '5s ago');
});

test('the brief names the machine and the verbs it is given', () => {
  const b = brief('vm');
  assert.match(b, /running on vm/);
  for (const verb of ['con digest', 'con thread', 'con say', 'con spawn']) {
    assert.ok(b.includes(verb), `the brief has to mention ${verb}`);
  }
});
