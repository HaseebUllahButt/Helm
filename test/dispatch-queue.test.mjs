import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';

/**
 * The durable side of `helm dispatch`: a hub stores the whole handoff
 * request under its id, hands it to the target daemon the next time that
 * machine connects, and remembers the answer. The payload is opaque to the
 * hub - the code inside is encrypted to the target's machine key - so these
 * tests carry placeholder envelopes; the real target-side validation is
 * covered in handoffs.test.mjs.
 */

const root = mkdtempSync(join(tmpdir(), 'helm-dispatch-'));
process.env.HELM_DIR = root;
process.env.HELM_DB = join(root, 'hub.sqlite');
process.env.HELM_NO_SERVICE = '1';

const PORT = 18637;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const N = await import('@helm/protocol/network');
const { T, M } = await import('@helm/protocol');
const { mintToken, ROLE } = await import('@helm/protocol/identity');
const net = N.createNetwork({ name: 'source-pc', port: PORT });

// Two more machines in the same network: the dispatch target, and a second
// bystander used to prove a row only answers to the machine it is for.
const TARGET = 'bb22cc33dd44ee55';
const OTHER = 'cc33dd44ee556677';
const PHONE = 'de71ce0001';
for (const [id, name] of [[TARGET, 'target-vm'], [OTHER, 'other-pc']]) {
  net.machines[id] = {
    id, name, endpoints: [], addedAt: Date.now(), updatedAt: Date.now(),
  };
}
net.devices[PHONE] = { id: PHONE, label: 'phone', addedAt: Date.now(), updatedAt: Date.now() };
N.saveNetwork(net);

const { startRelay } = await import('@helm/relay');
const { q } = await import('@helm/relay/db');
const { handoffRequestDigest } = await import('../packages/connect/src/handoffs.js');
const { signHandoffDigest } = await import('../packages/connect/src/code-transfer.js');
const { mergeQueueReceipts } = await import('../packages/connect/src/hub-client.js');
const hub = await startRelay({
  port: PORT, dbFile: join(root, 'hub.sqlite'), host: '127.0.0.1',
});
test.after(() => { hub.stop(); rmSync(root, { recursive: true, force: true }); });

const machineToken = (sub) => mintToken(net.key, { net: net.id, sub, role: ROLE.MACHINE });
const deviceToken = (sub) => mintToken(net.key, { net: net.id, sub, role: ROLE.DEVICE });

const openWs = (token, query = 'role=client', port = PORT) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    // A hub can send frames in the same burst as the welcome - a pending
    // handoff job included - so every socket buffers frames from the start
    // rather than trusting listeners to attach in time.
    ws.frames = [];
    ws.waiters = [];
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.t === T.WELCOME) { resolve(ws); return; }
      const hit = ws.waiters.findIndex((w) => w.pred(msg));
      if (hit !== -1) {
        const [w] = ws.waiters.splice(hit, 1);
        w.resolve(msg);
        return;
      }
      ws.frames.push(msg);
    });
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
  });

let rpcSeq = 0;
/** One hub-intercepted or routed call; resolves { ok, result | error }. */
const rpc = (ws, method, params) => new Promise((resolve) => {
  const id = `q${++rpcSeq}`;
  waitFrame(ws, (msg) => msg.t === T.RPC_RESULT && msg.id === id)
    .then((msg) => resolve(
      msg.ok ? { ok: true, result: msg.result } : { ok: false, error: msg.error?.message }
    ));
  ws.send(JSON.stringify({ t: T.RPC, id, env: TARGET, method, params }));
});

/** Wait for one frame matching a predicate on an open socket. */
function waitFrame(ws, pred, ms = 10_000) {
  const hit = ws.frames.findIndex(pred);
  if (hit !== -1) return Promise.resolve(ws.frames.splice(hit, 1)[0]);
  return new Promise((resolve, reject) => {
    ws.waiters.push({ pred, resolve });
    setTimeout(() => {
      const i = ws.waiters.findIndex((w) => w.resolve === resolve);
      if (i !== -1) { ws.waiters.splice(i, 1); reject(new Error('the frame never arrived')); }
    }, ms).unref?.();
  });
}

let jobSeq = 0;
const jobParams = (overrides = {}) => {
  const params = {
    handoffId: (++jobSeq).toString(16).padStart(24, '0'),
    sourceMachineId: net.self,
    targetMachineId: TARGET,
    snapshotDigest: 'ab'.repeat(32),
    envelope: { of: 'ciphertext the hub never reads' },
    profileId: 'claudea',
    prompt: 'pick the task up',
    ...overrides,
  };
  // The digest binds the whole immutable request and the source signs it,
  // like the real CLI's - the hub only checks the digest's shape, but the
  // wire carries both.
  params.requestDigest = handoffRequestDigest(params);
  params.sourceSignature = signHandoffDigest(params.requestDigest);
  return params;
};

// Rebind a mutated request, the same honesty the CLI has.
const rebind = (p) => {
  p.requestDigest = handoffRequestDigest(p);
  p.sourceSignature = signHandoffDigest(p.requestDigest);
  return p;
};

test('a machine queues work for a machine that is not connected', async () => {
  const ws = await openWs(machineToken(net.self));
  try {
    const params = jobParams();
    const res = await rpc(ws, M.DISPATCH_SUBMIT, { targetMachineId: TARGET, params });
    assert.equal(res.ok, true);
    const receipt = res.result;
    assert.equal(receipt.handoffId, params.handoffId);
    assert.equal(receipt.sourceMachineId, net.self);
    assert.equal(receipt.targetMachineId, TARGET);
    assert.equal(receipt.snapshotDigest, params.snapshotDigest);
    assert.equal(receipt.status, 'queued');
    const row = q.handoffGet.get(params.handoffId);
    assert.equal(row.status, 'queued');
    assert.equal(JSON.parse(row.payload).prompt, params.prompt, 'the whole request is stored');
  } finally { ws.close(); }
});

test('a device credential cannot submit or query the queue', async () => {
  const ws = await openWs(deviceToken(PHONE));
  try {
    const params = jobParams();
    const res = await rpc(ws, M.DISPATCH_SUBMIT, { targetMachineId: TARGET, params });
    assert.equal(res.ok, false);
    assert.match(res.error, /machine/);
    const st = await rpc(ws, M.DISPATCH_STATUS, { handoffId: params.handoffId });
    assert.equal(st.ok, false);
    assert.match(st.error, /machine/);
    assert.equal(q.handoffGet.get(params.handoffId), undefined);
  } finally { ws.close(); }
});

test('the wrapper has to match the request inside it', async () => {
  const ws = await openWs(machineToken(net.self));
  try {
    const params = jobParams();
    // A claimed source that is not the calling machine.
    let res = await rpc(ws, M.DISPATCH_SUBMIT, {
      targetMachineId: TARGET, params: { ...params, sourceMachineId: TARGET },
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /does not match/);
    // The wrapper names one target, the request inside another.
    res = await rpc(ws, M.DISPATCH_SUBMIT, { targetMachineId: OTHER, params });
    assert.equal(res.ok, false);
    assert.match(res.error, /does not match/);
    // A target that is not a member at all.
    res = await rpc(ws, M.DISPATCH_SUBMIT, {
      targetMachineId: 'dd44ee55667788',
      params: { ...params, targetMachineId: 'dd44ee55667788' },
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /not a machine/);
    // Malformed ids.
    res = await rpc(ws, M.DISPATCH_SUBMIT, {
      targetMachineId: TARGET, params: { ...params, handoffId: 'nope' },
    });
    assert.equal(res.ok, false);
    res = await rpc(ws, M.DISPATCH_SUBMIT, {
      targetMachineId: TARGET, params: { ...params, snapshotDigest: 'nope' },
    });
    assert.equal(res.ok, false);
    res = await rpc(ws, M.DISPATCH_SUBMIT, {
      targetMachineId: TARGET, params: { ...params, requestDigest: 'nope' },
    });
    assert.equal(res.ok, false);
    assert.match(res.error, /request digest/);
    assert.equal(q.handoffGet.get(params.handoffId), undefined, 'nothing was stored');
  } finally { ws.close(); }
});

test('a resubmit repeats the id, it never rewrites the payload', async () => {
  const ws = await openWs(machineToken(net.self));
  try {
    const params = jobParams();
    await rpc(ws, M.DISPATCH_SUBMIT, { targetMachineId: TARGET, params });
    // A byte-identical retry is the same work: same receipt, nothing moved.
    const again = await rpc(ws, M.DISPATCH_SUBMIT, { targetMachineId: TARGET, params });
    assert.equal(again.ok, true);
    assert.equal(again.result.status, 'queued');
    // A retry honestly declaring different work - new prompt, new digest -
    // is a different request wearing a used id: refused at the hub.
    const changed = await rpc(ws, M.DISPATCH_SUBMIT, {
      targetMachineId: TARGET, params: rebind({ ...params, prompt: 'totally different work' }),
    });
    assert.equal(changed.ok, false);
    assert.match(changed.error, /does not match its original request/);
    assert.equal(
      JSON.parse(q.handoffGet.get(params.handoffId).payload).prompt,
      params.prompt, 'the stored request is the first one'
    );
    // And one that lies - changed prompt under the stale digest - still
    // cannot rewrite the row; the target's own content check catches it.
    const lying = await rpc(ws, M.DISPATCH_SUBMIT, {
      targetMachineId: TARGET, params: { ...params, prompt: 'totally different work' },
    });
    assert.equal(lying.ok, true);
    assert.equal(
      JSON.parse(q.handoffGet.get(params.handoffId).payload).prompt,
      params.prompt
    );
    // A different snapshot under the same id is a different request.
    const clash = await rpc(ws, M.DISPATCH_SUBMIT, {
      targetMachineId: TARGET, params: rebind({ ...params, snapshotDigest: 'cd'.repeat(32) }),
    });
    assert.equal(clash.ok, false);
    assert.match(clash.error, /does not match its original request/);
  } finally { ws.close(); }
});

test('a resubmitted failure goes back to queued with its original payload', async () => {
  const ws = await openWs(machineToken(net.self));
  try {
    const params = jobParams();
    await rpc(ws, M.DISPATCH_SUBMIT, { targetMachineId: TARGET, params });
    q.handoffFailed.run('the target daemon said no', Date.now(), params.handoffId);
    const res = await rpc(ws, M.DISPATCH_SUBMIT, { targetMachineId: TARGET, params });
    assert.equal(res.ok, true);
    assert.equal(res.result.status, 'queued');
    const row = q.handoffGet.get(params.handoffId);
    assert.equal(row.error, null);
    assert.equal(JSON.parse(row.payload).prompt, params.prompt);
  } finally { ws.close(); }
});

test('a target is handed its queue when it connects', async () => {
  const ws = await openWs(machineToken(net.self));
  const params = jobParams();
  await rpc(ws, M.DISPATCH_SUBMIT, { targetMachineId: TARGET, params });
  ws.close();

  const env = await openWs(machineToken(TARGET), 'name=target-vm');
  try {
    const job = await waitFrame(
      env, (m) => m.t === T.HANDOFF_JOB && m.handoffId === params.handoffId
    );
    assert.equal(job.sourceMachineId, net.self);
    assert.equal(job.params.prompt, params.prompt);
    assert.equal(job.params.targetMachineId, TARGET);
    assert.equal(q.handoffGet.get(params.handoffId).status, 'delivered');
  } finally { env.close(); }
});

test('a result from the wrong machine completes nothing', async () => {
  const ws = await openWs(machineToken(net.self));
  const params = jobParams();
  await rpc(ws, M.DISPATCH_SUBMIT, { targetMachineId: TARGET, params });
  ws.close();

  // A different machine's daemon claims the task finished.
  const env = await openWs(machineToken(OTHER), 'name=other-pc');
  env.send(JSON.stringify({
    t: T.HANDOFF_RESULT, handoffId: params.handoffId, ok: true, receipt: { forged: true },
  }));
  await sleep(300);
  const row = q.handoffGet.get(params.handoffId);
  assert.equal(row.status, 'queued');
  assert.equal(row.result, null);
  env.close();
});

test("the target's result is remembered, and only the source may read it", async () => {
  const ws = await openWs(machineToken(net.self));
  const env = await openWs(machineToken(TARGET), 'name=target-vm');
  try {
    const params = jobParams();
    await rpc(ws, M.DISPATCH_SUBMIT, { targetMachineId: TARGET, params });
    // Online at submit time, so the job arrives without a reconnect.
    await waitFrame(env, (m) => m.t === T.HANDOFF_JOB && m.handoffId === params.handoffId);
    env.send(JSON.stringify({
      t: T.HANDOFF_RESULT, handoffId: params.handoffId, ok: true,
      receipt: { sessionId: 'sess-99', folder: '/work/dir', status: 'running' },
    }));
    for (let i = 0; i < 40; i += 1) {
      if (q.handoffGet.get(params.handoffId).status === 'running') break;
      await sleep(50);
    }
    const row = q.handoffGet.get(params.handoffId);
    assert.equal(row.status, 'running');
    assert.equal(JSON.parse(row.result).sessionId, 'sess-99');

    const st = await rpc(ws, M.DISPATCH_STATUS, { handoffId: params.handoffId });
    assert.equal(st.ok, true);
    assert.equal(st.result.status, 'running');
    assert.equal(st.result.receipt.sessionId, 'sess-99');

    // Another machine gets nothing; the queue answers only the source.
    const other = await openWs(machineToken(OTHER));
    const denied = await rpc(other, M.DISPATCH_STATUS, { handoffId: params.handoffId });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /unknown handoff/);
    other.close();
  } finally { env.close(); ws.close(); }
});

test('a failed result is remembered the same way', async () => {
  const ws = await openWs(machineToken(net.self));
  const env = await openWs(machineToken(TARGET), 'name=target-vm');
  try {
    const params = jobParams();
    await rpc(ws, M.DISPATCH_SUBMIT, { targetMachineId: TARGET, params });
    await waitFrame(env, (m) => m.t === T.HANDOFF_JOB && m.handoffId === params.handoffId);
    env.send(JSON.stringify({
      t: T.HANDOFF_RESULT, handoffId: params.handoffId, ok: false,
      error: 'the handoff target is not this machine',
    }));
    for (let i = 0; i < 40; i += 1) {
      if (q.handoffGet.get(params.handoffId).status === 'failed') break;
      await sleep(50);
    }
    const st = await rpc(ws, M.DISPATCH_STATUS, { handoffId: params.handoffId });
    assert.equal(st.ok, true);
    assert.equal(st.result.status, 'failed');
    assert.equal(st.result.error, 'the handoff target is not this machine');
  } finally { env.close(); ws.close(); }
});

test('a recreated hub layer still holds the queued work', async () => {
  const ws = await openWs(machineToken(net.self));
  const params = jobParams();
  await rpc(ws, M.DISPATCH_SUBMIT, { targetMachineId: TARGET, params });
  ws.close();

  // The row is in the file, not the old layer's memory.
  const check = new DatabaseSync(join(root, 'hub.sqlite'));
  assert.equal(
    check.prepare('SELECT status FROM handoff_queue WHERE id = ?').get(params.handoffId).status,
    'queued'
  );
  check.close();

  const hub2 = await startRelay({
    port: PORT + 1, dbFile: join(root, 'hub.sqlite'), host: '127.0.0.1', openLogin: false,
  });
  try {
    const ws2 = await openWs(machineToken(net.self), 'role=client', PORT + 1);
    const st = await rpc(ws2, M.DISPATCH_STATUS, { handoffId: params.handoffId });
    assert.equal(st.ok, true);
    assert.equal(st.result.status, 'queued');
    assert.equal(st.result.targetMachineId, TARGET);
    ws2.close();
  } finally { hub2.stop(); }
});

test('the daemon consumes a job frame through its idempotent accept', async () => {
  // The frame handler itself: a good job reaches Handoffs.accept and the
  // receipt goes back as handoff.result; a malformed job answers failure
  // without doing any work.
  const { Daemon } = await import('../packages/connect/src/agent.js');
  const daemon = new Daemon({ name: 'me', port: PORT });
  const seen = [];
  daemon.handoffs = {
    accept: async (params, caller) => {
      seen.push({ params, caller });
      return { status: 'running', sessionId: 'sess-1' };
    },
  };
  const sent = [];
  const link = { send: (t, extra) => sent.push({ t, ...extra }) };

  const params = jobParams({ sourceMachineId: OTHER, targetMachineId: net.self });
  await daemon.onFrame(link, {
    t: T.HANDOFF_JOB, handoffId: params.handoffId, sourceMachineId: OTHER, params,
  });
  for (let i = 0; i < 40 && !sent.length; i += 1) await sleep(25);
  assert.equal(sent[0].t, T.HANDOFF_RESULT);
  assert.equal(sent[0].ok, true);
  assert.equal(sent[0].receipt.sessionId, 'sess-1');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].caller, OTHER, 'the frame source is the caller');

  // A frame whose params do not agree with its envelope is refused work.
  await daemon.onFrame(link, {
    t: T.HANDOFF_JOB, handoffId: params.handoffId, sourceMachineId: OTHER,
    params: { ...params, targetMachineId: TARGET },
  });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].ok, false);
  assert.match(sent[1].error, /does not match this machine/);
  assert.equal(seen.length, 1, 'the malformed job never reached accept');
});

test('a result too large to store is recorded as failed instead', async () => {
  const ws = await openWs(machineToken(net.self));
  const env = await openWs(machineToken(TARGET), 'name=target-vm');
  try {
    const params = jobParams();
    await rpc(ws, M.DISPATCH_SUBMIT, { targetMachineId: TARGET, params });
    await waitFrame(env, (m) => m.t === T.HANDOFF_JOB && m.handoffId === params.handoffId);
    env.send(JSON.stringify({
      t: T.HANDOFF_RESULT, handoffId: params.handoffId, ok: true,
      // A connected target answers for itself - a receipt bigger than a
      // megabyte is not one receipt any more.
      receipt: { sessionId: 'sess-1', folder: '/w', digest: 'cd'.repeat(32), pad: 'x'.repeat(1_600_000) },
    }));
    for (let i = 0; i < 40; i += 1) {
      if (q.handoffGet.get(params.handoffId).status === 'failed') break;
      await sleep(50);
    }
    const row = q.handoffGet.get(params.handoffId);
    assert.equal(row.status, 'failed');
    assert.match(row.error, /too large/);
  } finally { env.close(); ws.close(); }
});

test('a finished queue job reports back to its online source', async () => {
  // The source daemon attached as its own env, the target daemon attached,
  // and a client socket holding the machine credential to submit with.
  const src = await openWs(machineToken(net.self), 'name=source-pc&role=self');
  const env = await openWs(machineToken(TARGET), 'name=target-vm');
  const ws = await openWs(machineToken(net.self));
  try {
    const params = jobParams({ title: 'Handoff · a task' });
    params.parent = {
      handoffId: params.handoffId, machineId: net.self,
      sessionId: 'src-session-1', sourceFolder: '/src/dir', digest: params.snapshotDigest,
    };
    params.requestDigest = handoffRequestDigest(params);
    await rpc(ws, M.DISPATCH_SUBMIT, { targetMachineId: TARGET, params });
    await waitFrame(env, (m) => m.t === T.HANDOFF_JOB && m.handoffId === params.handoffId);
    env.send(JSON.stringify({
      t: T.HANDOFF_RESULT, handoffId: params.handoffId, ok: true,
      receipt: { sessionId: 'sess-42', folder: '/work/dest', digest: 'cd'.repeat(32) },
    }));
    const done = await waitFrame(
      src, (m) => m.t === T.HANDOFF_COMPLETE && m.handoffId === params.handoffId
    );
    assert.equal(done.targetMachineId, TARGET);
    assert.equal(done.parentSessionId, 'src-session-1');
    assert.equal(done.title, 'Handoff · a task');
    assert.equal(done.receipt.sessionId, 'sess-42');
  } finally { src.close(); env.close(); ws.close(); }
});

test('a source that was away hears about its finished child on connect', async () => {
  const ws = await openWs(machineToken(net.self));
  const env = await openWs(machineToken(TARGET), 'name=target-vm');
  try {
    const params = jobParams();
    params.parent = {
      handoffId: params.handoffId, machineId: net.self,
      sessionId: 'src-session-9', sourceFolder: '/src/dir', digest: params.snapshotDigest,
    };
    params.requestDigest = handoffRequestDigest(params);
    await rpc(ws, M.DISPATCH_SUBMIT, { targetMachineId: TARGET, params });
    await waitFrame(env, (m) => m.t === T.HANDOFF_JOB && m.handoffId === params.handoffId);
    env.send(JSON.stringify({
      t: T.HANDOFF_RESULT, handoffId: params.handoffId, ok: true,
      receipt: { sessionId: 'sess-77', folder: '/work/dest', digest: 'cd'.repeat(32) },
    }));
    for (let i = 0; i < 40; i += 1) {
      if (q.handoffGet.get(params.handoffId).status === 'running') break;
      await sleep(50);
    }
    assert.equal(q.handoffGet.get(params.handoffId).status, 'running');

    // The source daemon was offline for all of that; connecting now is
    // when it learns where the child session lives.
    const src = await openWs(machineToken(net.self), 'name=source-pc&role=self');
    try {
      const done = await waitFrame(
        src, (m) => m.t === T.HANDOFF_COMPLETE && m.handoffId === params.handoffId
      );
      assert.equal(done.parentSessionId, 'src-session-9');
      assert.equal(done.receipt.sessionId, 'sess-77');
    } finally { src.close(); }
  } finally { env.close(); ws.close(); }
});

test('the daemon links a finished child to its parent - once per handoff', async () => {
  const { Daemon } = await import('../packages/connect/src/agent.js');
  const daemon = new Daemon({ name: 'me', port: PORT });
  // The real linkChild keeps one record per handoffId; this fake keeps the
  // same rule so a redelivery proves dedupe, not just delivery.
  const children = new Map();
  daemon.sessions = {
    linkChild: (id, child) => {
      children.set(child.handoffId, { parent: id, ...child });
      return { ok: true };
    },
  };
  const link = { send: () => {} };
  const msg = {
    t: T.HANDOFF_COMPLETE,
    handoffId: 'f'.repeat(24),
    targetMachineId: TARGET,
    parentSessionId: 'src-session-1',
    title: 'Handoff · a task',
    receipt: { sessionId: 'sess-42', folder: '/work/dest', digest: 'cd'.repeat(32) },
  };
  await daemon.onFrame(link, msg);
  await daemon.onFrame(link, msg);
  assert.equal(children.size, 1, 'the same handoff replaces, never duplicates');
  assert.equal(children.get('f'.repeat(24)).sessionId, 'sess-42');
  assert.equal(children.get('f'.repeat(24)).machineId, TARGET);
  assert.equal(children.get('f'.repeat(24)).parent, 'src-session-1');

  // Malformed or stale completions are logged and dropped, never linked
  // and never fatal to the link.
  await daemon.onFrame(link, { t: T.HANDOFF_COMPLETE, handoffId: 'bad', receipt: {} });
  await daemon.onFrame(link, {
    ...msg, handoffId: 'e'.repeat(24), targetMachineId: 'dd44ee55667788',
  });
  await daemon.onFrame(link, {
    ...msg, handoffId: 'd'.repeat(24),
    receipt: { sessionId: 'sess-1', folder: '/w', digest: 'not-a-digest' },
  });
  assert.equal(children.size, 1);
});

test('the furthest-along queue copy answers across homes', async () => {
  const row = (status) => ({ status });
  assert.equal(mergeQueueReceipts([]), null);
  assert.equal(mergeQueueReceipts([row('queued'), row('delivered')]).status, 'delivered');
  // A stale failure on one hub cannot hide a live copy on another.
  assert.equal(mergeQueueReceipts([row('failed'), row('queued')]).status, 'queued');
  assert.equal(mergeQueueReceipts([row('delivered'), row('running')]).status, 'running');
  assert.equal(mergeQueueReceipts([row('failed'), row('failed')]).status, 'failed');
});
