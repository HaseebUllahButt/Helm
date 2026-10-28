import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, timeoutMs = 2500) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await delay(20);
  }
  throw new Error('condition did not become true');
}

async function barrierServer(pathname) {
  let release;
  let markStarted;
  const result = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { markStarted = resolve; });
  const server = createServer(async (req, res) => {
    if (req.url !== pathname) { res.writeHead(404).end(); return; }
    markStarted();
    const body = await result;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: 'http://127.0.0.1:' + port + pathname,
    started,
    release,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function executable(dir, name, source) {
  const path = join(dir, name);
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

test('Codex serves disk data immediately and merges public refreshes that finish before provider refresh', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-model-codex-'));
  const home = join(dir, 'account');
  const bin = join(dir, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(home, 'config.toml'), 'model = "disk-model"\nmodel_reasoning_effort = "high"\n');
  writeFileSync(join(home, 'model_catalog.json'), JSON.stringify({ models: [
    {
      model: 'disk-model', displayName: 'Disk model label', isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
      inputModalities: ['text'],
    },
  ] }));
  executable(bin, 'codex', [
    '#!/usr/bin/env node',
    "if (process.argv[2] !== 'app-server') process.exit(1);",
    "let buffer = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => {",
    "  buffer += chunk;",
    "  let end;",
    "  while ((end = buffer.indexOf('\\n')) >= 0) {",
    "    const line = buffer.slice(0, end);",
    "    buffer = buffer.slice(end + 1);",
    "    if (!line.trim()) continue;",
    "    const request = JSON.parse(line);",
    "    const result = request.method === 'model/list'",
    "      ? { data: [{ model: 'provider-model', displayName: 'Provider model', supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }], inputModalities: ['text', 'image'] }] }",
    "      : {};",
    "    const reply = JSON.stringify({ id: request.id, result }) + '\\n';",
    "    if (request.method === 'model/list') fetch(process.env.TEST_CODEX_PROVIDER_URL).then(r => r.json()).then(() => process.stdout.write(reply));",
    "    else process.stdout.write(reply);",
    "  }",
    "});",
    '',
  ].join('\n'));
  const barrier = await barrierServer('/manifest');
  const provider = await barrierServer('/provider');
  const priorPath = process.env.PATH;
  const priorManifest = process.env.HELM_CODEX_MODEL_MANIFEST_URL;
  process.env.PATH = bin + ':' + priorPath;
  process.env.HELM_CODEX_MODEL_MANIFEST_URL = barrier.url;
  try {
    const { listModels } = await import('../packages/connect/src/models.js?codex-fast-path');
    const environment = { TEST_CODEX_PROVIDER_URL: provider.url };
    const began = Date.now();
    const first = await listModels('codex', home, environment);
    assert.ok(Date.now() - began < 1000, 'disk catalog should not wait for public HTTP');
    assert.ok(first.models.includes('disk-model'));
    assert.equal(first.labels['disk-model'], 'Disk model label');
    assert.deepEqual(first.effortsByModel['disk-model'], ['low', 'high']);
    assert.equal(first.imagesByModel['disk-model'], false);
    assert.equal(first.refreshing, true, 'the menu must request the completed Codex list');
    await barrier.started;
    barrier.release({ currentModels: { codex: ['public-model'] } });
    const withPublic = await until(async () => {
      const current = await listModels('codex', home, environment);
      return current.models.includes('public-model') ? current : null;
    });
    assert.ok(withPublic.models.includes('disk-model'));
    assert.equal(withPublic.refreshing, true, 'the provider refresh still runs after the public list arrives');
    await provider.started;
    let settled = false;
    const completion = listModels('codex', home, environment, null, { settled: true })
      .then((list) => { settled = true; return list; });
    await new Promise(setImmediate);
    assert.equal(settled, false, 'the settled request must wait for Codex');
    provider.release({});
    const withProvider = await completion;
    assert.equal(withProvider.refreshing, false);
    assert.ok(withProvider.models.includes('provider-model'));
    assert.ok(withProvider.models.includes('public-model'));
    assert.equal(withProvider.labels['provider-model'], 'Provider model');
    assert.deepEqual(withProvider.effortsByModel['provider-model'], ['xhigh']);
  } finally {
    process.env.PATH = priorPath;
    if (priorManifest === undefined) delete process.env.HELM_CODEX_MODEL_MANIFEST_URL;
    else process.env.HELM_CODEX_MODEL_MANIFEST_URL = priorManifest;
    barrier.release({ currentModels: { codex: ['test-cleanup'] } });
    provider.release({});
    await barrier.close();
    await provider.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude returns its local account answer before Models.dev and refreshes the cached list later', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-model-claude-'));
  const home = join(dir, 'account');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ model: 'account-model' }));
  const barrier = await barrierServer('/catalog');
  const prior = process.env.HELM_MODELS_DEV_URL;
  process.env.HELM_MODELS_DEV_URL = barrier.url;
  try {
    const { listModels } = await import('../packages/connect/src/models.js?models-dev-fast-path');
    const began = Date.now();
    const first = await listModels('claude', home);
    assert.ok(Date.now() - began < 1000, 'local Claude data should not wait for Models.dev');
    assert.ok(first.models.includes('account-model'));
    assert.ok(first.models.includes('claude-opus-5-5'), 'Opus 5.5 remains selectable before public discovery');
    assert.equal(first.labels['claude-opus-5-5'], 'Claude Opus 5.5');
    assert.equal(first.refreshing, true);
    await barrier.started;
    barrier.release({ anthropic: { models: {
      'published-test-model': { name: 'Published test model', attachment: true },
    } } });
    const refreshed = await listModels('claude', home, {}, null, { settled: true });
    assert.ok(refreshed.models.includes('published-test-model'));
    assert.equal(refreshed.labels['published-test-model'], 'Published test model');
    assert.equal(refreshed.refreshing, false);
  } finally {
    if (prior === undefined) delete process.env.HELM_MODELS_DEV_URL;
    else process.env.HELM_MODELS_DEV_URL = prior;
    barrier.release({ anthropic: { models: {} } });
    await barrier.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Change the cache age, not the test duration. Restore the clock before
// asynchronous CLI or HTTP work runs.
function expiredList(listModels, ...args) {
  const now = Date.now;
  Date.now = () => now() + 10 * 60_000 + 1;
  try { return listModels(...args); } finally { Date.now = now; }
}

const CLI_LIST_STUB = `#!/usr/bin/env node
const path = require('node:path');
const name = path.basename(process.argv[1]);
if (process.argv.includes('auth')) { console.log('[]'); process.exit(); }
async function output() {
  const payload = await (await fetch(process.env.TEST_MODEL_URL)).json();
  if (payload.fail) process.exit(1);
  if (payload.empty) return '';
  switch (name) {
    case 'opencode': case 'opencode2': return 'provider/future-model\\n';
    case 'grok': return '- future-model\\n';
    case 'pi': return 'provider model context max-out thinking images\\nprovider future-model 128k 8k yes yes\\n';
    case 'omp': return JSON.stringify({models:[{selector:'provider/future-model',name:'Future model',thinking:['low','high']}]});
    case 'kimi': return JSON.stringify({providers:[{models:[{id:'future-model',name:'Future model'}]}]});
    case 'agy': return 'future-model\\tFuture model\\n';
    default: return JSON.stringify([{id:'future-model',name:'Future model'}]);
  }
}
if (name === 'codex') {
  if (process.argv[2] !== 'app-server') process.exit(1);
  require('node:readline').createInterface({input:process.stdin}).on('line', async line => {
    const req = JSON.parse(line);
    if (req.id === undefined) return;
    if (req.method === 'model/list') await output();
    console.log(JSON.stringify({id:req.id,result:req.method === 'model/list' ? {data:[{model:'future-model',displayName:'Future model'}]} : {}}));
  });
} else output().then(result => process.stdout.write(result));
`;

test('every CLI provider marks an expired list as refreshing and returns its completed account list', async (t) => {
  for (const engine of ['codex', 'opencode', 'opencode2', 'devin', 'grok', 'pi', 'omp', 'cursor', 'agy', 'kimi']) {
    await t.test(engine, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'helm-model-refresh-' + engine + '-'));
      const bin = join(dir, 'bin');
      const home = join(dir, 'account');
      mkdirSync(bin);
      mkdirSync(home);
      executable(bin, engine === 'cursor' ? 'cursor-agent' : engine, CLI_LIST_STUB);
      const barrier = await barrierServer('/models');
      const environment = { PATH: bin + ':' + process.env.PATH, TEST_MODEL_URL: barrier.url,
        HOME: home, XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache') };
      const prior = process.env.HELM_CODEX_MODEL_MANIFEST_URL;
      process.env.HELM_CODEX_MODEL_MANIFEST_URL = 'http://127.0.0.1:1/unavailable';
      try {
        const { listModels, primeModels } = await import('../packages/connect/src/models.js?all-cli-' + engine);
        primeModels(engine, home, null, { models: ['old-model'], labels: { 'old-model': 'Old model' } });
        const old = await expiredList(listModels, engine, home, environment);
        assert.deepEqual(old.models, ['old-model']);
        assert.equal(old.refreshing, true, 'an open menu must follow every provider refresh');
        await barrier.started;
        let completed = false;
        const next = listModels(engine, home, environment, null, { settled: true })
          .then(list => { completed = true; return list; });
        await new Promise(setImmediate);
        assert.equal(completed, false, 'the follow-up waits for this provider');
        barrier.release({});
        const fresh = await next;
        const id = ['opencode', 'opencode2', 'pi', 'omp'].includes(engine) ? 'provider/future-model' : 'future-model';
        assert.deepEqual(fresh.models, [id], 'new model names need no Helm release');
        assert.equal(fresh.refreshing, false);
        assert.deepEqual(await listModels(engine, home, environment), fresh);
      } finally {
        if (prior === undefined) delete process.env.HELM_CODEX_MODEL_MANIFEST_URL;
        else process.env.HELM_CODEX_MODEL_MANIFEST_URL = prior;
        barrier.release({});
        await barrier.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

test('Claude and Gemini wait for their account rebuild after the shared public list arrives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-model-public-'));
  const barrier = await barrierServer('/catalog');
  const prior = process.env.HELM_MODELS_DEV_URL;
  process.env.HELM_MODELS_DEV_URL = barrier.url;
  try {
    const { listModels } = await import('../packages/connect/src/models.js?all-public');
    const claude = await listModels('claude', join(dir, 'claude'));
    const gemini = await listModels('gemini', join(dir, 'gemini'));
    assert.equal(claude.refreshing, true);
    assert.equal(gemini.refreshing, true);
    await barrier.started;
    const done = ['claude', 'gemini'].map(engine => listModels(engine, join(dir, engine), {}, null, { settled: true }));
    barrier.release({
      anthropic: { models: { 'claude-future-model': { name: 'Future Claude' } } },
      google: { models: { 'gemini-future-model': { name: 'Future Gemini' } } },
    });
    const lists = await Promise.all(done);
    assert.ok(lists[0].models.includes('claude-future-model'));
    assert.ok(lists[1].models.includes('gemini-future-model'));
    assert.ok(lists.every(list => list.refreshing === false));
  } finally {
    if (prior === undefined) delete process.env.HELM_MODELS_DEV_URL;
    else process.env.HELM_MODELS_DEV_URL = prior;
    barrier.release({});
    await barrier.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a finished account does not wait for another account or provider', { timeout: 5000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-model-scoped-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  executable(bin, 'kimi', CLI_LIST_STUB);
  executable(bin, 'devin', CLI_LIST_STUB);
  const fast = await barrierServer('/fast');
  const slow = await barrierServer('/slow');
  const { listModels, primeModels, modelsSettled } = await import('../packages/connect/src/models.js?scoped-all');
  try {
    const environment = url => ({ PATH: bin + ':' + process.env.PATH, TEST_MODEL_URL: url });
    const accounts = [['kimi', 'fast', fast], ['kimi', 'slow', slow], ['devin', 'other', slow]];
    for (const [engine, home, server] of accounts) {
      primeModels(engine, join(dir, home), null, { models: ['old-model'] });
      assert.equal((await expiredList(listModels, engine, join(dir, home), environment(server.url))).refreshing, true);
    }
    await Promise.all([fast.started, slow.started]);
    fast.release({});
    const fresh = await listModels('kimi', join(dir, 'fast'), environment(fast.url), null, { settled: true });
    assert.deepEqual(fresh.models, ['future-model']);
    assert.equal(fresh.refreshing, false);
    assert.equal((await listModels('kimi', join(dir, 'slow'))).refreshing, true);
    assert.equal((await listModels('devin', join(dir, 'other'))).refreshing, true);
  } finally {
    fast.release({}); slow.release({});
    await modelsSettled();
    await Promise.all([fast.close(), slow.close()]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failed and empty refreshes keep usable models and finish without a retry loop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-model-refresh-failure-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  executable(bin, 'kimi', CLI_LIST_STUB);
  executable(bin, 'grok', CLI_LIST_STUB);
  try {
    const { listModels, primeModels } = await import('../packages/connect/src/models.js?failed-all');
    for (const [engine, payload] of [['kimi', { fail: true }], ['grok', { empty: true }]]) {
      const barrier = await barrierServer('/models');
      try {
        const home = join(dir, engine);
        const environment = { PATH: bin + ':' + process.env.PATH, TEST_MODEL_URL: barrier.url };
        primeModels(engine, home, null, { models: ['usable-model'] });
        assert.equal((await expiredList(listModels, engine, home, environment)).refreshing, true);
        await barrier.started;
        barrier.release(payload);
        const kept = await listModels(engine, home, environment, null, { settled: true });
        assert.deepEqual(kept.models, ['usable-model']);
        assert.equal(kept.refreshing, false);
        assert.deepEqual(await listModels(engine, home, environment), kept);
      } finally { barrier.release({}); await barrier.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('OpenCode tries usable local model rows before forced refresh, without its background service', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-model-opencode-'));
  const bin = join(dir, 'bin');
  const localHome = join(dir, 'local');
  const emptyHome = join(dir, 'empty');
  const v1Home = join(dir, 'v1');
  mkdirSync(bin);
  mkdirSync(localHome);
  mkdirSync(emptyHome);
  mkdirSync(v1Home);
  writeFileSync(join(localHome, 'models.txt'), 'provider/local-model\n');
  writeFileSync(join(v1Home, 'models.txt'), 'provider/v1-model\n');
  const log = join(dir, 'calls.log');
  executable(bin, 'opencode', [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "fs.appendFileSync(process.env.OPENCODE_CALLS_PATH, process.argv.slice(2).join(' ') + '\\n');",
    "if (process.env.XDG_CONFIG_HOME.endsWith('v1') && process.argv.includes('--standalone')) process.exit(1);",
    "if (process.argv.includes('--refresh')) { process.stdout.write('provider/refreshed-model\\n'); process.exit(0); }",
    "const local = path.join(process.env.XDG_CONFIG_HOME, 'models.txt');",
    "if (fs.existsSync(local)) process.stdout.write(fs.readFileSync(local, 'utf8'));",
    "else process.stdout.write('warning: local model cache is empty\\n');",
    '',
  ].join('\n'));
  const priorPath = process.env.PATH;
  const priorLog = process.env.OPENCODE_CALLS_PATH;
  process.env.PATH = bin + ':' + priorPath;
  process.env.OPENCODE_CALLS_PATH = log;
  try {
    const { listModels } = await import('../packages/connect/src/models.js?opencode-local-first');
    const modelCalls = () => readFileSync(log, 'utf8').trim().split('\n').filter((l) => l.startsWith('models'));
    const local = await listModels('opencode', localHome);
    assert.deepEqual(local.models, ['provider/local-model']);
    assert.deepEqual(modelCalls(), ['models --standalone']);

    const refreshed = await listModels('opencode', emptyHome);
    assert.deepEqual(refreshed.models, ['provider/refreshed-model']);
    assert.deepEqual(modelCalls(), [
      'models --standalone', 'models --standalone', 'models --refresh --standalone',
    ]);
    assert.ok(readFileSync(log, 'utf8').includes('auth export --standalone'));

    // OpenCode 1 has no --standalone flag, so the plain command still answers.
    const v1 = await listModels('opencode', v1Home);
    assert.deepEqual(v1.models, ['provider/v1-model']);
    assert.deepEqual(modelCalls().slice(3), ['models --standalone', 'models']);
  } finally {
    process.env.PATH = priorPath;
    if (priorLog === undefined) delete process.env.OPENCODE_CALLS_PATH;
    else process.env.OPENCODE_CALLS_PATH = priorLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed Codex provider refresh leaves the usable account disk catalog cached', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-model-codex-fallback-'));
  const home = join(dir, 'account');
  const bin = join(dir, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(home, 'model_catalog.json'), JSON.stringify({ models: [
    { model: 'only-local-model', displayName: 'Local model' },
  ] }));
  executable(bin, 'codex', '#!/bin/sh\nexit 1\n');
  const priorPath = process.env.PATH;
  const priorManifest = process.env.HELM_CODEX_MODEL_MANIFEST_URL;
  process.env.PATH = bin + ':' + priorPath;
  process.env.HELM_CODEX_MODEL_MANIFEST_URL = 'http://127.0.0.1:1/unavailable';
  try {
    const { listModels, modelsSettled } = await import('../packages/connect/src/models.js?codex-failed-refresh');
    const first = await listModels('codex', home);
    assert.equal(first.refreshing, true);
    await modelsSettled();
    const second = await listModels('codex', home);
    assert.equal(second.refreshing, false);
    assert.ok(first.models.includes('only-local-model'));
    assert.ok(second.models.includes('only-local-model'));
    assert.equal(second.labels['only-local-model'], 'Local model');
  } finally {
    process.env.PATH = priorPath;
    if (priorManifest === undefined) delete process.env.HELM_CODEX_MODEL_MANIFEST_URL;
    else process.env.HELM_CODEX_MODEL_MANIFEST_URL = priorManifest;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex reads either disk cache name and prefers the newest valid account catalog', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-model-codex-cache-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  executable(bin, 'codex', '#!/bin/sh\nexit 1\n');
  const priorPath = process.env.PATH;
  const priorManifest = process.env.HELM_CODEX_MODEL_MANIFEST_URL;
  process.env.PATH = bin + ':' + priorPath;
  process.env.HELM_CODEX_MODEL_MANIFEST_URL = 'http://127.0.0.1:1/unavailable';
  try {
    const { listModels, modelsSettled } = await import('../packages/connect/src/models.js?codex-cache-names');
    for (const newest of ['model_catalog.json', 'models_cache.json']) {
      const home = join(dir, newest);
      mkdirSync(home);
      for (const filename of ['model_catalog.json', 'models_cache.json']) {
        const file = join(home, filename);
        writeFileSync(file, JSON.stringify({ models: [{
          model: filename === newest ? 'gpt-6.1-terra' : 'old-model',
          display_name: 'GPT-6.1 Terra', supported_reasoning_levels: ['low', 'high'],
        }] }));
        utimesSync(file, 100, filename === newest ? 200 : 100);
      }
      const list = await listModels('codex', home);
      assert.deepEqual(list.models, ['gpt-6.1-terra']);
      assert.equal(list.labels['gpt-6.1-terra'], 'GPT-6.1 Terra');
      assert.deepEqual(list.effortsByModel['gpt-6.1-terra'], ['low', 'high']);
      await modelsSettled();
    }
    const home = join(dir, 'partial');
    mkdirSync(home);
    writeFileSync(join(home, 'model_catalog.json'), '{');
    writeFileSync(join(home, 'models_cache.json'), JSON.stringify({ models: [{ model: 'gpt-6.1-terra' }] }));
    assert.deepEqual((await listModels('codex', home)).models, ['gpt-6.1-terra']);
    await modelsSettled();
  } finally {
    process.env.PATH = priorPath;
    if (priorManifest === undefined) delete process.env.HELM_CODEX_MODEL_MANIFEST_URL;
    else process.env.HELM_CODEX_MODEL_MANIFEST_URL = priorManifest;
    rmSync(dir, { recursive: true, force: true });
  }
});


test('Codex refreshes online before accepting stale app-server rows and finds later releases', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-model-online-'));
  const home = join(dir, 'account');
  const bin = join(dir, 'bin');
  mkdirSync(home); mkdirSync(bin);
  const catalogFile = join(home, 'model_catalog.json');
  const onlineFile = join(dir, 'online.json');
  const callsFile = join(dir, 'calls');
  writeFileSync(catalogFile, JSON.stringify({models:[{slug:'old-model'}]}));
  executable(bin, 'codex', `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.TEST_CALLS, process.argv.slice(2).join(' ') + '\\n');
if (process.argv[2] === 'debug') {
  process.stdout.write(fs.readFileSync(process.env.TEST_CATALOG));
} else if (process.argv[2] === 'app-server') {
  require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const req = JSON.parse(line);
    if (req.id !== undefined) console.log(JSON.stringify({id:req.id,result:req.method === 'model/list' ? {data:[{model:'old-model'}]} : {}}));
  });
}
`);
  const prior = process.env.HELM_CODEX_MODEL_MANIFEST_URL;
  process.env.HELM_CODEX_MODEL_MANIFEST_URL = 'http://127.0.0.1:1/unavailable';
  try {
    const {listModels} = await import('../packages/connect/src/models.js?online-first');
    const env = {PATH:bin+':'+process.env.PATH, TEST_CATALOG:onlineFile, TEST_CALLS:callsFile};
    writeFileSync(onlineFile, JSON.stringify({models:[{slug:'gpt-6.1-terra'}]}));
    assert.deepEqual((await listModels('codex', home, env)).models, ['old-model']);
    assert.deepEqual((await listModels('codex', home, env, null, {settled:true})).models, ['gpt-6.1-terra']);
    writeFileSync(onlineFile, JSON.stringify({models:[{slug:'gpt-6.1-terra'},{slug:'future-model'}]}));
    const now = Date.now;
    Date.now = () => now() + 10 * 60_000 + 1;
    try {
      await listModels('codex', home, env);
      assert.deepEqual((await listModels('codex', home, env, null, {settled:true})).models, ['gpt-6.1-terra','future-model']);
    } finally { Date.now = now; }
    assert.deepEqual(readFileSync(callsFile,'utf8').trim().split('\n'), ['debug models','debug models']);
  } finally {
    if (prior === undefined) delete process.env.HELM_CODEX_MODEL_MANIFEST_URL;
    else process.env.HELM_CODEX_MODEL_MANIFEST_URL = prior;
    rmSync(dir, {recursive:true, force:true});
  }
});
