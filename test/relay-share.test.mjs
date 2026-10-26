import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

const root = mkdtempSync(join(tmpdir(), 'helm-relay-share-'));
Object.assign(process.env, { HELM_DIR: root, HELM_SHARE_DOMAIN: 'links.test' });
const { createShareRoute } = await import('../apps/relay/src/share.js');
test.after(() => rmSync(root, { recursive: true, force: true }));

function captureMaps(t, create) {
  const maps = [], Base = Map;
  const mock = t.mock.method(globalThis, 'Map', class extends Base {
    constructor(...args) { super(...args); maps.push(this); }
  });
  try { return { value: create(), maps }; } finally { mock.mock.restore(); }
}

function request(ip, post = true) {
  const req = new PassThrough();
  Object.assign(req, { headers: { host: 'test.links.test' }, socket: { remoteAddress: ip },
    method: post ? 'POST' : 'GET', url: post ? '/.helm-share/unlock' : '/' });
  req.end('password=wrong');
  return req;
}
function response() {
  return { status: null, writeHead(status) { this.status = status; }, end() {} };
}

test('share requests remove expired password records and preserve active retry counts', async t => {
  let now = 100_000;
  t.mock.method(Date, 'now', () => now);
  const { value: share, maps } = captureMaps(t, () => createShareRoute({
    online: new Map([['machine', {}]]),
    callEnv: async () => ({ shares: [{ name: 'test', port: 3000, lock: {} }] }),
  }));
  const first = response();
  await share.route(request('old-visitor'), first);
  assert.equal(first.status, 401);
  const attempts = maps.find(map => map.has('old-visitor|test'));
  assert.ok(attempts);
  now += 5 * 60_000;
  for (let i = 0; i < 8; i++) await share.route(request('current-visitor'), response());
  now += 5 * 60_000;
  await share.route(request('reader', false), response());
  assert.equal(attempts.has('old-visitor|test'), false);
  assert.equal(attempts.get('current-visitor|test').n, 8);
  const refused = response();
  await share.route(request('current-visitor'), refused);
  assert.equal(refused.status, 429);
});
