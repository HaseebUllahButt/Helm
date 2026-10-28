import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnose, formatDiagnosis, probeHealth } from '../packages/connect/src/doctor.js';
import { M } from '../packages/protocol/index.js';

const exec = promisify(execFile);
const network = () => ({ id: 'private-network', self: 'local', key: 'secret-network-key', port: 9876,
  machines: { local: { id: 'local', kind: 'pc', endpoints: ['https://local.example'] },
    home: { id: 'home', kind: 'vm', endpoints: ['https://private-home.example'] } },
});
const defaults = overrides => ({ network: async () => network(), service: async () => ({ state: 'active', linger: 'yes' }),
  web: () => '/built-app', health: async () => 'ok', rpc: async (_, __, method) => method === M.ENV_INFO
    ? { version: { full: 'one' }, web: { commit: 'one' }, terminals: 'pty' }
    : { machines: [{ env: 'home', url: 'https://private-home.example' }] }, ...overrides });

test('the support report diagnoses working routes without disclosing addresses or machine keys', async () => {
  const calls = [];
  const options = defaults({ rpc: async (net, self, method, params, limits) => {
    calls.push({ net, self, method, params, limits });
    return method === M.ENV_INFO ? { version: { full: 'one' }, web: { commit: 'one' } }
      : { machines: [{ env: 'home', url: 'https://private-home.example', name: 'secret-name' }] };
  } });
  const report = await diagnose(options);
  assert.equal(report.ok, true);
  assert.ok(report.checks.every(c => c.state === 'ok'));
  assert.deepEqual(calls.map(c => c.method).sort(), [M.ENV_INFO, M.NET_ROUTES].sort());
  for (const call of calls) {
    assert.deepEqual(Object.keys(call.net.machines), ['local']);
    assert.deepEqual(call.net.machines.local.endpoints, []);
    assert.equal(call.limits.budget, 5000);
  }
  assert.doesNotMatch(JSON.stringify(report), /secret-|private-|https:|built-app/);
});

test('a broken local service stays broken in the report even when the remote home works', async () => {
  let called = false;
  const report = await diagnose(defaults({
    health: async address => address.startsWith('http://127.') ? 'unavailable' : 'ok',
    rpc: async () => { called = true; throw Error('should not call'); },
  }));
  assert.equal(report.ok, false);
  assert.equal(called, false);
  assert.equal(report.checks.find(c => c.id === 'local').state, 'error');
  assert.equal(report.checks.find(c => c.id === 'home-1').state, 'ok');
});

test('a different local network never receives credentials or a restart recommendation', async () => {
  let called = false;
  const report = await diagnose(defaults({ health: async () => 'wrong-network', rpc: async () => { called = true; } }));
  assert.equal(called, false);
  assert.equal(report.ok, false);
  const local = report.checks.find(c => c.id === 'local');
  assert.match(local.message, /another Helm network/);
  assert.doesNotMatch(local.action, /helm start/);
});

test('a working web page cannot hide a failed live connection or leak its error', async () => {
  const report = await diagnose(defaults({ rpc: async () => { throw Error('Bearer secret-network-key https://private.example'); } }));
  assert.equal(report.ok, false);
  assert.equal(report.checks.find(c => c.id === 'commands').state, 'error');
  assert.doesNotMatch(JSON.stringify(report), /Bearer|secret-network-key|private.example/);
});

test('the report distinguishes update, logout, packet recovery, and unreachable machine warnings', async () => {
  const report = await diagnose(defaults({ service: async () => ({ state: 'active', linger: 'no' }),
    rpc: async (_, __, method) => method === M.ENV_INFO
      ? { version: { full: 'old' }, web: { commit: 'new' }, sync: { reason: 'secret error' }, terminals: 'panes' }
      : { machines: [{ attached: true }, { url: null }], recovery: { repair: 'untrusted command' } },
  }));
  assert.equal(report.ok, true, 'warnings alone do not fail the check');
  for (const id of ['logout', 'app-version', 'updates', 'terminals', 'routes', 'packet-recovery']) {
    assert.equal(report.checks.find(c => c.id === id).state, 'warning', id);
  }
  assert.match(formatDiagnosis(report), /1 of 2 other machines/);
  assert.doesNotMatch(JSON.stringify(report), /secret error|untrusted command/);
});

test('two machines with their own changes need attention in the report', async () => {
  const report = await diagnose(defaults({ rpc: async (_, __, method) => method === M.ENV_INFO
    ? { version: { full: 'one' }, web: { commit: 'one' }, sync: { diverged: true, with: 'secret-machine' } }
    : { machines: [] } }));
  assert.equal(report.checks.find(c => c.id === 'updates').state, 'warning');
  assert.doesNotMatch(JSON.stringify(report), /secret-machine/);
});

test('missing and damaged registrations give different steps without probing any machine', async () => {
  let probes = 0;
  const probe = async () => { probes++; return 'ok'; };
  const absent = await diagnose(defaults({ network: async () => null, health: probe }));
  assert.match(absent.checks[0].action, /helm join/);
  for (const value of [{}, { ...network(), port: 'bad' }]) {
    const damaged = await diagnose(defaults({ network: async () => value, health: probe }));
    assert.match(damaged.checks[0].action, /trusted backup/);
    assert.doesNotMatch(JSON.stringify(damaged), /helm join/);
  }
  assert.equal(probes, 0);
});

async function server(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('health checks validate the network and reject redirects, arbitrary pages, and oversized replies', async t => {
  const seen = [];
  const address = await server(t, (req, res) => {
    seen.push(req.url);
    assert.equal(req.headers.authorization, undefined);
    if (req.url.startsWith('/redirect/')) { res.writeHead(302, { location: '/secret' }); res.end(); }
    else if (req.url.startsWith('/large/')) res.end('x'.repeat(9000));
    else if (req.url.startsWith('/page/')) res.end('<html>sign in</html>');
    else res.end(JSON.stringify({ ok: true, network: 'expected' }));
  });
  assert.equal(await probeHealth(address, 'expected'), 'ok');
  assert.equal(await probeHealth(address, 'another'), 'wrong-network');
  assert.notEqual(await probeHealth(`${address}/redirect`, 'expected'), 'ok');
  assert.notEqual(await probeHealth(`${address}/page`, 'expected'), 'ok');
  assert.equal(await probeHealth(`${address}/large`, 'expected'), 'invalid-reply');
  assert.ok(!seen.includes('/secret'));
  const before = seen.length;
  for (const bad of [`${address}/?key=secret`, `${address}/#pair=secret`, address.replace('http://', 'http://user:secret@'), 'file:///tmp/secret']) {
    assert.equal(await probeHealth(bad, 'expected'), 'invalid-address');
  }
  assert.equal(seen.length, before);
});

test('health checks stop when a server stalls while sending its reply', async t => {
  let requested;
  const arrived = new Promise(resolve => { requested = resolve; });
  const address = await server(t, (_, res) => { res.writeHead(200); res.write('{'); requested(); });
  const probe = probeHealth(address, 'expected', { timeout: 100 });
  await arrived;
  assert.equal(await probe, 'timed-out');
});

test('the real CLI preserves a damaged registration and returns a safe JSON report', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'helm-doctor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'network.json');
  await writeFile(file, '{"key":"private-test-key", broken');
  const before = await readFile(file, 'utf8');
  let result;
  try {
    await exec(process.execPath, ['packages/connect/bin/helm.js', 'doctor', '--json'], {
      env: { ...process.env, HELM_DIR: dir, HELM_NO_SERVICE: '1', HELM_NO_UPDATE: '1' },
    });
    assert.fail('doctor must report failure');
  } catch (error) { result = error; }
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.match(report.checks[0].action, /trusted backup/);
  assert.doesNotMatch(result.stdout, /private-test-key/);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.deepEqual(await readdir(dir), ['network.json']);
});
