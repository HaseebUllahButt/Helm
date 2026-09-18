import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.CON_DIR = mkdtempSync(join(tmpdir(), 'con-notify-'));

const { describe: describeAsk } = await import('../packages/connect/src/notify.js');
const { fanOut, isNew, forget } = await import('../apps/relay/src/notify.js');

/** A stand-in for FCM or APNs: records what it was sent, answers as told. */
function stubPushService(replies) {
  const got = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      got.push({ path: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks) });
      res.writeHead(replies[req.url] ?? 201).end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, got, port: server.address().port }));
  });
}

const sub = (endpoint, label) => ({
  endpoint, label,
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
});

test('a blocked session reaches every device, and a dead endpoint is forgotten', async () => {
  const { server, got, port } = await stubPushService({ '/gone': 410, '/ok': 201 });
  const dropped = [];
  const sent = await fanOut(
    [sub(`http://127.0.0.1:${port}/ok`, 'phone'), sub(`http://127.0.0.1:${port}/gone`, 'old tablet')],
    { title: 'aitink · codex needs you', body: 'run rm -rf build', tag: 't' },
    { drop: (e) => dropped.push(e) },
  );
  server.close();

  assert.equal(sent, 1, 'the live device was told');
  assert.deepEqual(dropped, [`http://127.0.0.1:${port}/gone`], 'the 410 was forgotten, the 201 kept');
  assert.equal(got.length, 2);
  for (const g of got) {
    // The push service must be able to route and authenticate it, and must
    // not be able to read it.
    assert.match(g.auth, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    assert.ok(g.body.length > 16, 'there is a body');
    assert.ok(!g.body.toString('utf8').includes('rm -rf build'), 'the payload is encrypted');
  }
});

test('one notification per request, however many times the event is seen', () => {
  forget();
  assert.equal(isNew('s1:req-1'), true);
  assert.equal(isNew('s1:req-1'), false);
  assert.equal(isNew('s1:req-2'), true);
});

test('the notification says which session, and what it is asking', () => {
  const n = describeAsk(
    { id: 's1', title: 'aitink', engine: 'codex', cwd: '/home/me/aitink', envId: 'env1' },
    { type: 'permission.request', requestId: 'r7', command: 'rm -rf build' },
  );
  assert.equal(n.title, 'aitink · codex needs you');
  assert.equal(n.body, 'run rm -rf build');
  assert.equal(n.tag, 'con-s1-r7');
  // The tap has to land on the session that asked, so both halves travel.
  assert.equal(n.envId, 'env1');
  assert.equal(n.sessionId, 's1');
});

test('a push service that never answers does not hold anything up', async () => {
  const slow = createServer(() => { /* never responds */ });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  const port = slow.address().port;
  const t0 = Date.now();
  const sent = await fanOut([sub(`http://127.0.0.1:${port}/hang`, 'stuck')], { title: 'x' }, { timeoutMs: 1200 });
  slow.close();
  assert.equal(sent, 0);
  assert.ok(Date.now() - t0 < 5_000, 'it gave up rather than waiting forever');
});
