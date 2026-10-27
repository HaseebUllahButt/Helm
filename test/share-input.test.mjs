import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'helm-share-input-'));
process.env.HELM_DIR = root;
process.env.HELM_SHARE_DOMAIN = 'input.test';
const { readForm, createShareRoute } = await import('../apps/relay/src/share.js');
test.after(() => rmSync(root, { recursive: true, force: true }));

test('Spin forms limit bytes and release unfinished requests after ten seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const large = new PassThrough();
  const rejected = assert.rejects(readForm(large), /too large/);
  large.end('π'.repeat(2100));
  await rejected;
  assert.equal(large.destroyed, true);
  const slow = new PassThrough();
  const timedOut = assert.rejects(readForm(slow), /too long/);
  slow.write('password=');
  t.mock.timers.tick(10_000);
  await timedOut;
  assert.equal(slow.destroyed, true);
  assert.equal(slow.listenerCount('data'), 0);
  const good = new PassThrough();
  const complete = readForm(good); good.end('password=fixture');
  assert.equal((await complete).get('password'), 'fixture');
});

test('unknown Spin names share paced discovery and a new link opens on its first visit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10000 });
  let calls = 0, shares = [];
  const route = createShareRoute({ online: new Map([['source', {}]]),
    callEnv: async () => { calls++; return { shares }; },
    openTcp: () => assert.fail('unknown and locked links must not open a tunnel') });
  const visit = async name => {
    let status;
    const req = { headers: { host: `${name}.input.test` }, socket: { remoteAddress: '192.0.2.1' }, method: 'GET', url: '/' };
    const res = { writeHead(code) { status = code; }, end() {} };
    await route.route(req, res);
    return status;
  };
  assert.equal(await visit('unknown'), 404);
  const requests = Array.from({ length: 40 }, (_, i) => visit(`missing-${i}`));
  const fresh = visit('new-link');
  assert.equal(calls, 1);
  t.mock.timers.tick(999);
  assert.equal(calls, 1);
  shares = [{ name: 'new-link', port: 3000, lock: { hash: 'fixture' } }];
  t.mock.timers.tick(1);
  assert.ok((await Promise.all(requests)).every(status => status === 404));
  assert.equal(await fresh, 401, 'the new name is found on its first request');
  assert.equal(calls, 2);
});
