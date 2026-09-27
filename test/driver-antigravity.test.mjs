import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import http from 'node:http';
import { collect } from './helpers.mjs';

// paths.js pins HELM_DIR at module load - point it at a throwaway dir before
// the driver (and its imports) evaluate.
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-antigravity-'));
const { AntigravityDriver } = await import('../packages/connect/src/drivers/antigravity.js');
const {
  antigravityEnv, validateAntigravityRedirect, prepareAntigravityProfile,
  antigravityAuthMethod, unzipMembers, tmpParent,
} = await import('../packages/connect/src/antigravity.js');

const HERE = fileURLToPath(new URL('.', import.meta.url));

/**
 * Same fake-launcher shape as helpers.fakeCli, but the fixture path is the
 * caller's - the OAuth redirect fixture has to carry the real port of the
 * listener the test stands up.
 */
function fakeAntigravity(fixturePath) {
  const dir = mkdtempSync(join(tmpdir(), 'helm-fake-antigravity-'));
  const cmd = join(dir, 'agy_acp_server.par');
  const stdin = join(dir, 'stdin.ndjson');
  writeFileSync(cmd, `#!/bin/sh\nFAKE_FIXTURE=${JSON.stringify(fixturePath)} FAKE_STDIN=${JSON.stringify(stdin)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(HERE, 'fake-cli.mjs'))} antigravity "$@"\n`);
  chmodSync(cmd, 0o755);
  return {
    cmd, dir,
    stdinLines: () => (existsSync(stdin) ? readFileSync(stdin, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}

const make = (name, opts = {}) => {
  const fake = fakeAntigravity(join(HERE, 'fixtures', 'antigravity', `${name}.ndjson`));
  const home = mkdtempSync(join(tmpdir(), 'helm-gemini-home-'));
  const driver = new AntigravityDriver({
    cmd: fake.cmd, env: { GEMINI_HOME: home }, args: [],
    cwd: fake.dir, ...opts,
  });
  return { fake, driver, home, log: collect(driver) };
};

test('antigravity: auth refusal runs authenticate, the printed URL reaches the chat, session binds', async () => {
  const { driver, log, fake } = make('auth');
  await driver.send('say helm-acp-ok');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');

  // authenticate ran between the refused session/new and the retry.
  const methods = fake.stdinLines().map((m) => m.method).filter(Boolean);
  const at = (m) => methods.indexOf(m);
  assert.ok(at('initialize') < at('session/new') && at('session/new') < at('authenticate'));
  assert.ok(at('authenticate') < methods.lastIndexOf('session/new'));

  // The off-protocol OAuth line became an auth error event the phone can
  // act on, carrying the link and the paste-back instruction.
  const auth = log.of('error').find((e) => e.kind === 'auth' && e.message.includes('accounts.google.com'));
  assert.ok(auth, `no auth event; saw ${log.types().join(',')}`);
  assert.ok(auth.message.includes('http://127.0.0.1'));

  assert.equal(driver.engineSessionId, 'conv-acp-1');
  const deltas = log.of('item.delta').map((e) => e.text).join('');
  assert.equal(deltas, 'helm-acp-ok');
  assert.deepEqual(done.usage, { input: 50, output: 5, cacheRead: undefined });
  await driver.kill();
});

test('antigravity: a pasted 127.0.0.1 redirect is delivered to the agent listener, not the model', async (t) => {
  // A real listener on the port the fixture advertises: the sign-in's
  // loopback endpoint the agent itself would run.
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200); res.end('ok'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;

  // The fixture ends on print_on_request: authenticate stays pending, so
  // the sign-in window stays open for the paste.
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=t&redirect_uri=${encodeURIComponent(`http://127.0.0.1:${port}/`)}&response_type=code&state=st-1&scope=openid`;
  const dir = mkdtempSync(join(tmpdir(), 'helm-acp-fixture-'));
  const fx = join(dir, 'pending.ndjson');
  writeFileSync(fx, [
    JSON.stringify({ id: 'r1', result: { protocolVersion: 1, agentCapabilities: {} } }),
    JSON.stringify({ id: 'r2', error: { code: -32000, message: 'authentication required' } }),
    JSON.stringify({ print_on_request: 'authenticate', line: `Open the following link to authenticate the ACP server: ${authUrl}` }),
    '',
  ].join('\n'));

  const fake = fakeAntigravity(fx);
  const home = mkdtempSync(join(tmpdir(), 'helm-gemini-home-'));
  const driver = new AntigravityDriver({ cmd: fake.cmd, env: { GEMINI_HOME: home }, args: [], cwd: fake.dir });
  const log = collect(driver);

  const sent = driver.send('hello'); // blocks inside authenticate - do not await yet
  await log.until((e) => e.type === 'error' && e.kind === 'auth' && e.message.includes('accounts.google.com'));

  await driver.send(`http://127.0.0.1:${port}/?code=authcode-1&state=st-1`);
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');
  assert.deepEqual(hits, ['/?code=authcode-1&state=st-1']);

  // The redirect went to the listener as a local turn; nothing was prompted.
  assert.ok(!fake.stdinLines().some((m) => m.method === 'session/prompt'));
  await driver.kill();
  await sent.catch(() => {});
});

test('antigravity: resume speaks session/resume first', async () => {
  const { driver, fake } = make('resume', { engineSessionId: 'conv-resumed-1' });
  await driver.send('hello again');
  const methods = fake.stdinLines().map((m) => m.method).filter(Boolean);
  assert.ok(methods.includes('session/resume'), `no session/resume in ${methods.join(',')}`);
  assert.ok(!methods.includes('session/load'));
  assert.equal(driver.engineSessionId, 'conv-resumed-1');
  await driver.kill();
});

test('antigravity: a resume refused for auth authenticates and retries the same session', async () => {
  const { driver, log, fake } = make('resume-auth', { engineSessionId: 'conv-resumed-1' });
  await driver.send('hello again');
  const done = await log.until((e) => e.type === 'turn.done');
  assert.equal(done.status, 'ok');

  // authenticate sits between the refused resume and its retry; the
  // session is never rebuilt with session/new, and an auth refusal does
  // not fall through to the session/load probe.
  const methods = fake.stdinLines().map((m) => m.method).filter(Boolean);
  assert.deepEqual(methods.slice(0, 4),
    ['initialize', 'session/resume', 'authenticate', 'session/resume'],
    `wrong wire sequence: ${methods.join(',')}`);
  assert.ok(!methods.includes('session/new'), `no session/new on an auth-refused resume: ${methods.join(',')}`);
  assert.ok(!methods.includes('session/load'), `no session/load once auth is refused: ${methods.join(',')}`);

  assert.equal(driver.engineSessionId, 'conv-resumed-1');
  const deltas = log.of('item.delta').map((e) => e.text).join('');
  assert.equal(deltas, 'resumed-ok');
  await driver.kill();
});

test('antigravity: starting a session leaves another launch\'s unpack dir alone', async () => {
  // A second live session's TMPDIR: prepare must not sweep it, and this
  // driver's exit must not either - each launch removes only its own.
  const parent = tmpParent();
  mkdirSync(parent, { recursive: true });
  const other = join(parent, 'run-0-foreign');
  mkdirSync(other);

  const { driver } = make('resume', { engineSessionId: 'conv-resumed-1' });
  await driver.send('hello again'); // start() ran prepare by the time this returns
  const own = driver._agy?.tmpDir;
  assert.ok(own && existsSync(own), 'the session got its own unpack dir');
  assert.ok(existsSync(other), 'a neighbouring run-* dir must survive prepare');

  await driver.kill();
  assert.ok(existsSync(other), 'a neighbouring run-* dir must survive exit');
  for (let i = 0; i < 50 && existsSync(own); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(!existsSync(own), 'the session\'s own unpack dir is removed on exit');
});

test('antigravity: the spawn env scrubs ambient Google vars and keeps the profile credential', async () => {
  const env = antigravityEnv(
    {
      PATH: '/usr/bin', HOME: '/home/x',
      GEMINI_API_KEY: 'ambient-key', GOOGLE_APPLICATION_CREDENTIALS: '/x.json',
      AGY_ACP_ENABLE_OAUTH: '0', ELECTRON_RUN_AS_NODE: '1',
    },
    { exe: '/opt/tools/agy_acp_server.par', geminiHome: '/profile/home', tmpDir: '/tmp/run-1' },
  );
  assert.equal(env.GEMINI_HOME, '/profile/home');
  assert.equal(env.ANTIGRAVITY_HARNESS_PATH, '/opt/tools/localharness_external');
  assert.equal(env.TMPDIR, '/tmp/run-1');
  assert.equal(env.AGY_ACP_FORCE_FILE_STORAGE, '1');
  assert.equal(env.PYTHONUNBUFFERED, '1');
  // The api-key method keeps its own credential; the rest of Google's
  // ambient configuration is gone.
  assert.equal(env.GEMINI_API_KEY, 'ambient-key');
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(env.AGY_ACP_ENABLE_OAUTH, undefined);

  // Without a key the method is the browser flow, and no key leaks through.
  const oauth = antigravityEnv({ PATH: '/usr/bin', GEMINI_API_KEY: '' }, { exe: '/x/y.par', geminiHome: '/h', tmpDir: '/t' });
  assert.equal(antigravityAuthMethod({}), 'oauth-personal');
  assert.equal(antigravityAuthMethod({ GEMINI_API_KEY: 'k' }), 'gemini-api-key');
  assert.equal(oauth.GEMINI_API_KEY, undefined);
});

test('antigravity: the profile gets its own dirs and the chosen auth type in settings.json', async () => {
  const home = mkdtempSync(join(tmpdir(), 'helm-gemini-prof-'));
  const { geminiHome, tmpDir } = await prepareAntigravityProfile({ GEMINI_API_KEY: 'k', GEMINI_HOME: home });
  const settings = JSON.parse(readFileSync(join(geminiHome, 'antigravity-acp', 'settings.json'), 'utf8'));
  assert.deepEqual(settings.auth, { type: 'gemini-api-key' });
  assert.ok(tmpDir.includes('antigravity-acp'));
  assert.ok(existsSync(tmpDir));
});

/** The smallest zip the extractor accepts: local headers, a central dir, EOCD. */
function writeZip(path, entries) {
  const parts = [];
  const centrals = [];
  let off = 0;
  for (const { name, data, stored = false } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = stored ? data : deflateRawSync(data);
    const method = stored ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);   // version needed
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);  // compressed size
    local.writeUInt32LE(data.length, 22);  // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);   // version made by
    central.writeUInt16LE(20, 6);   // version needed
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(off, 42); // local header offset
    centrals.push(central, nameBuf);
    parts.push(local, nameBuf, body);
    off += 30 + nameBuf.length + body.length;
  }
  const cdStart = off;
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  writeFileSync(path, Buffer.concat([...parts, ...centrals, eocd]));
}

test('antigravity: the zip walker extracts every wanted member, deflate and stored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-acp-zip-'));
  const zip = join(dir, 'archive.zip');
  const big = Buffer.alloc(1 << 20, 0x61); // 1MB of 'a' - real deflate work
  writeZip(zip, [
    { name: 'agy_acp_server.par', data: big },
    { name: 'localharness_external', data: Buffer.from('harness bytes') },
    { name: 'unwanted.txt', data: Buffer.from('skip me') },
  ]);
  const dest = join(dir, 'out');
  await unzipMembers(zip, dest, new Set(['agy_acp_server.par', 'localharness_external']));
  assert.deepEqual(readFileSync(join(dest, 'agy_acp_server.par')), big);
  assert.equal(readFileSync(join(dest, 'localharness_external'), 'utf8'), 'harness bytes');
  assert.ok(!existsSync(join(dest, 'unwanted.txt')));
  // A wanted member the archive lacks is an error, not silence.
  await assert.rejects(() => unzipMembers(zip, dest, new Set(['missing.bin'])), /did not contain/);
});

test('antigravity: redirect validation pins the sign-in, wrong state or shape is refused', () => {
  const pending = { redirectUri: 'http://127.0.0.1:51123/', state: 'st-1' };
  assert.ok(validateAntigravityRedirect(pending, 'http://127.0.0.1:51123/?code=c&state=st-1').callback);
  assert.ok(validateAntigravityRedirect(pending, 'http://127.0.0.1:51123/?code=c&state=other').error);
  assert.ok(validateAntigravityRedirect(pending, 'http://127.0.0.1:9999/?code=c&state=st-1').error);
  assert.ok(validateAntigravityRedirect(pending, 'http://127.0.0.1:51123/?state=st-1').error);
  assert.ok(validateAntigravityRedirect(pending, 'not a url').error);
});
