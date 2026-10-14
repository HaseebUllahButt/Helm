import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { EventLog } = await import('../packages/connect/src/events.js');
const {
  lastLine, readThread, localDigest, render, summaryLine, mergeSnapshot,
  readSnapshot, writeSnapshot, shortId, ago, brief, findNetworkSession,
} = await import('../packages/connect/src/brain.js');
const { M } = await import('@helm/protocol');

test('CLI lookup finds standalone leads and child helpers omitted from the digest', async () => {
  const machines = { laptop: { name: 'Laptop' }, vm: { name: 'VM' } };
  const lead = { id: '7159e75cb90b', title: 'Lead', delegation: { parentId: null } };
  const child = { id: 'f5383e2abde5', title: 'Mountains', delegation: { parentId: lead.id } };
  const snapshot = { machines: { vm: { name: 'VM', sessions: [] } } };
  const saved = JSON.stringify(snapshot);
  const calls = [];
  const rpc = async (env, method, params) => {
    calls.push({ env, method, params });
    return { sessions: env === 'vm' ? [lead, child] : [] };
  };
  for (const [id, session] of [[lead.id, lead], ['7159e7', lead], ['f5383e', child]]) {
    assert.deepEqual(await findNetworkSession(id, { machines, snapshot, rpc }), { env: 'vm', machine: 'VM', session });
  }
  assert.ok(calls.every(c => c.method === M.SESSION_LIST && c.params.includeDelegations === true));
  assert.equal(JSON.stringify(snapshot), saved, 'helper lookup must not change the digest snapshot');
});

test('CLI lookup rejects prefixes shared by a regular session and a hidden helper', async () => {
  const rpc = async env => ({ sessions: [{
    id: env === 'laptop' ? 'abcdef111111' : 'abcdef222222', title: env,
    ...(env === 'vm' ? { delegation: { parentId: 'lead' } } : {}),
  }] });
  const options = { machines: { laptop: { name: 'Laptop' }, vm: { name: 'VM' } }, snapshot: {}, rpc };
  await assert.rejects(findNetworkSession('abcdef', options), /matches 2 sessions:\n  Laptop  abcdef111111.*\n  VM  abcdef222222/s);
  assert.equal((await findNetworkSession('abcdef222222', options)).env, 'vm');
});

test('CLI lookup retains offline candidates and rejects live/offline prefix collisions', async () => {
  const offline = { id: 'abcdef222222', title: 'Offline work' };
  const options = {
    machines: { laptop: { name: 'Laptop' }, vm: { name: 'VM' } },
    snapshot: { machines: { vm: { name: 'VM', sessions: [offline] }, removed: { sessions: [{ id: 'gone' }] } } },
    rpc: async env => {
      if (env === 'vm') throw new Error('offline');
      return { sessions: [{ id: 'abcdef111111', title: 'Live work' }] };
    },
  };
  assert.deepEqual(await findNetworkSession(offline.id, options), { env: 'vm', machine: 'VM', session: offline });
  await assert.rejects(findNetworkSession('abcdef', options), /matches 2 sessions/);
  await assert.rejects(findNetworkSession('gone', options), /no session/);
});

test('CLI lookup finds a helper saved under its lead while that machine restarts', async () => {
  const options = {
    machines: { laptop: { name: 'Laptop' } },
    snapshot: { machines: { laptop: { name: 'Laptop', sessions: [
      { id: 'c6df5f000000', title: 'Coordinator', helpers: [{ id: '397140aaaaaa', title: 'Helper', depth: 1 }] },
    ] } } },
    rpc: async () => { throw new Error('timed out'); },
  };
  const hit = await findNetworkSession('397140', options);
  assert.equal(hit.env, 'laptop');
  assert.equal(hit.session.id, '397140aaaaaa');
});

test('CLI lookup waits for a machine that is restarting instead of calling the id unknown', async () => {
  const helper = { id: '713142bbbbbb', title: 'Helper', delegation: { parentId: 'lead' } };
  let tries = 0;
  const waits = [], slept = [];
  const options = {
    machines: { laptop: { name: 'Laptop' }, vm: { name: 'VM' } },
    snapshot: { machines: {} },
    rpc: async (env) => {
      if (env === 'vm') return { sessions: [] };
      if (++tries < 3) throw new Error('connect ECONNREFUSED 127.0.0.1:8787');
      return { sessions: [helper] };
    },
    waitMs: 60_000, onWait: (names) => waits.push(names), sleep: async (ms) => { slept.push(ms); },
  };
  assert.deepEqual(await findNetworkSession('713142', options), { env: 'laptop', machine: 'Laptop', session: helper });
  assert.deepEqual(waits, ['Laptop', 'Laptop']);
  assert.deepEqual(slept, [1000, 2000], 'backs off between tries');
});

test('CLI lookup says a silent machine is busy, not that the session is gone', async () => {
  const options = {
    machines: { laptop: { name: 'Laptop' }, vm: { name: 'VM' } },
    snapshot: { machines: {} },
    rpc: async (env) => { if (env === 'laptop') throw new Error('timed out'); return { sessions: [] }; },
    waitMs: 5000, sleep: async () => {},
  };
  let asked = 0;
  const offline = { ...options, rpc: async (env) => { asked++; return options.rpc(env); }, waitFor: () => false, sleep: () => assert.fail('no wait for a machine off for long') };
  await assert.rejects(findNetworkSession('397140', offline), /Laptop did not answer/);
  assert.equal(asked, 2, 'one try each, no waiting');
  await assert.rejects(findNetworkSession('397140', options),
    (err) => err.code === 'busy' && /Laptop did not answer \(offline, restarting or busy\)/.test(err.message));
});

test('CLI lookup uses a live empty inventory instead of a stale cached match', async () => {
  const options = {
    machines: { vm: { name: 'VM' } },
    snapshot: { machines: { vm: { sessions: [{ id: 'removed', title: 'Old' }] } } },
    rpc: async () => ({ sessions: [] }),
  };
  await assert.rejects(findNetworkSession('removed', options), /no session "removed"/);
  await assert.rejects(findNetworkSession('', options), /which session/);
});

// The digest is the brain's whole picture of the network, so what it says
// has to be true before anything built on it can be.

// Events are flat and incremental - `{ type, ...fields }`, with a tool's
// arguments and a model's whole sentence arriving as separate later events -
// so these fixtures are shaped like the ones in ~/.helm/events, not like a
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
    { type: 'item.delta', id: 'i2', text: "It is the guide to helm.\nAnything else?" },
    { type: 'item.done', id: 'i2', status: 'ok' },
  ]);
  assert.equal(line, 'It is the guide to helm.');
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
  const dir = mkdtempSync(join(tmpdir(), 'helm-brain-log-'));
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

test('the digest line is read from disk once and kept until the thread changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-brain-derive-'));
  try {
    const writer = new EventLog(dir);
    writer.append('b1', { type: 'turn.start', turnId: 't1', text: 'renew the cert' });
    writer.append('b1', { type: 'item.start', id: 'i1', kind: 'tool', turnId: 't1', name: 'Bash' });
    writer.append('b1', { type: 'item.update', id: 'i1', input: { command: 'certbot renew' } });
    // A fresh reader has nothing parsed yet, like a daemon with more threads than its cache.
    const reader = new EventLog(dir);
    let reads = 0; const line = (events) => { reads += 1; return lastLine(events); };
    assert.equal(reader.derive('b1', line), 'running: Bash(certbot renew)');
    assert.equal(reader.derive('b1', line), 'running: Bash(certbot renew)');
    assert.equal(reads, 1, 'an unchanged thread is not read again');
    writer.append('b1', { type: 'item.start', id: 'i2', kind: 'tool', turnId: 't1', name: 'Read' });
    writer.append('b1', { type: 'item.update', id: 'i2', input: { file_path: '/etc/hosts' } });
    assert.match(reader.derive('b1', line), /Read/, 'a thread that changed on disk is read again');
    assert.equal(reads, 2);
    assert.equal(reader.derive('missing', line), null, 'a thread with no log gives no line');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a pane helm did not start contributes no event line', () => {
  let asked = 0;
  const events = { since: () => { asked += 1; return []; } };
  localDigest([{ id: 'pane:w1:p1', title: 'zsh', cwd: '/w', engine: 'shell', status: 'shell' }], events);
  assert.equal(asked, 0, 'helm has no event log for a pane it does not own');
});

test('the digest reports team activity while the parent provider is idle', () => {
  const rows = localDigest([
    { id: 'parent', engine: 'claude', status: 'idle', team: { working: 1, blocked: 0 } },
    { id: 'waiting', engine: 'codex', status: 'idle', team: { working: 1, blocked: 1 } },
  ], { tail: () => [] });
  assert.deepEqual(rows.map(row => row.status), ['working', 'blocked']);
});

// An offline machine that simply vanishes is the failure that matters here:
// the brain would report "nothing is running there", which is a wrong answer
// rather than a missing one.
test('a machine that did not answer keeps its last known state, dated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-brain-'));
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
  // Must match HELM_NOTE in apps/web/src/session/Transcript.tsx: one
  // bracketed line, then a blank line, then what the owner typed.
  const line = summaryLine({ machines: { a: { sessions: [] } } }, { roster: { a: { online: true } } });
  const message = `${line}\n\nwhat is waiting on me?`;
  const m = /^(\[helm [^\]\n]*\])\n\n([\s\S]*)$/.exec(message);
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
  for (const verb of ['helm digest', 'helm thread', 'helm say', 'helm spawn']) {
    assert.ok(b.includes(verb), `the brief has to mention ${verb}`);
  }
});

test('the rough folder map survives archived chats and sleeping machines', () => {
  const initial = mergeSnapshot({ machines: {} }, {
    why: { name: 'why', sessions: [{ cwd: '/work/helm', engine: 'codex' }], projects: [{ path: '/work/quiet', title: 'Quiet project' }] },
  }, 1000);
  const archived = mergeSnapshot(initial, { why: { name: 'why', sessions: [], projects: [] } }, 2000);
  assert.deepEqual(archived.machines.why.folders.map(f => f.path), ['/work/helm', '/work/quiet']);
  assert.equal(archived.machines.why.folders[0].at, 1000, 'folder observations keep their real age');
  const asleep = mergeSnapshot(archived, { vm: { name: 'VM', sessions: [] } }, 3000);
  assert.equal(asleep.machines.why.at, 2000);
  const text = render(asleep, { roster: { why: { name: 'why', online: false } }, now: 3000 });
  assert.match(text, /Known folders \(last observed; verify before using\)/);
  assert.match(text, /\/work\/quiet · Quiet project/);
});

test('the digest prints a standalone lead with its helpers nested beneath it', () => {
  const now = Date.now();
  const snap = { machines: { vm: { name: 'VM', at: now, sessions: [{
    id: '7159e75cb90b', title: 'Lead', cwd: '/home/u/masair', engine: 'devin', model: 'swe-2-high', status: 'working',
    updatedAt: now, unhomed: true,
    helpers: [{ id: 'f5383e2abde5', title: 'Mountains', engine: 'devin', status: 'working', depth: 1, updatedAt: now, last: 'measuring ridge colour' }],
  }] } } };
  const out = render(snap, { roster: { vm: { name: 'VM', online: true } }, now });
  assert.match(out, /7159e7 +working +devin \(swe-2-high\) "Lead" .*\[helper\]/);
  assert.match(out, /└ f5383e working +devin "Mountains"/);
  assert.match(out, /measuring ridge colour/);
});
