import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { M } from '@helm/protocol';
import { LocalModelHost } from '../packages/connect/src/local-model-host.js';
import { LocalModelJobs } from '../packages/connect/src/local-model-jobs.js';
import { LocalModelAccounts, cachedModelProfiles, localProfileCatalog, modelProfile } from '../packages/connect/src/local-model-accounts.js';
import { modelName } from '../packages/connect/src/local-model-state.js';
import { freeGpu, runModelsCommand } from '../packages/connect/src/local-model-cli.js';
import { ensureOllamaService } from '../packages/connect/src/ollama-service.js';

function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'helm-models-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const noForwards = { list: () => [] };
const machines = Object.fromEntries(['here', 'gpu', 'offline'].map((id) => [id, { id, name: id }]));

test('choose the answering machine with the most free memory on one GPU', async () => {
  const lines = [], work = [];
  const rpc = async (host, method, params) => {
    switch (method) {
      case M.LOCAL_MODELS_LIST: return { models: [] };
      case M.MACHINE_STATS:
        if (host === 'offline') throw new Error('offline');
        return { gpus: [{ memory: { total: host === 'gpu' ? 16 : 24, used: host === 'gpu' ? 3 : 23 } }] };
      case M.LOCAL_MODELS_WORK:
        work.push(host);
        return { id: params.id, state: 'done', result: { model: params.model, state: 'loaded', gpu: 1024 * 1024, memory: 0 } };
      case M.LOCAL_MODELS_ENDPOINT: return { url: 'http://127.0.0.1:48321/v1' };
    }
    assert.fail(method);
  };
  await runModelsCommand(['serve', 'tiny:latest'], {
    net: { machines, self: 'here' }, rpc, write: (line) => lines.push(line),
  });
  assert.deepEqual(work, ['gpu']);
  assert.match(lines.join('\n'), /tiny on gpu.*loaded on GPU.*1 MiB/);
  assert.match(lines.join('\n'), /localhost|127\.0\.0\.1/);
  assert.equal(freeGpu({ gpus: [{ memory: null }, { memory: { total: 4, used: 9 } }] }), 0);
  assert.equal(modelName('Team/Tiny:latest'), 'team/tiny');
  assert.throws(() => modelName('https://outside/model'));
});

test('report CPU fallback and check an uncertain start by its request number', async () => {
  const lines = [], calls = [];
  let id;
  const rpc = async (host, method, params) => {
    if (method === M.LOCAL_MODELS_LIST) return { models: [] };
    if (method === M.MACHINE_STATS) return { gpus: [] };
    if (method === M.LOCAL_MODELS_WORK) {
      id = params.id;
      calls.push(host);
      throw Object.assign(new Error('connection lost'), { uncertain: true });
    }
    if (method === M.LOCAL_MODELS_JOB) {
      assert.equal(host, 'here');
      assert.equal(params.id, id);
      return { id, state: 'done', result: { model: 'tiny', state: 'loaded', gpu: 0, memory: 1024 * 1024 } };
    }
    return { url: 'http://127.0.0.1:48321/v1' };
  };
  await runModelsCommand(['serve', 'tiny', '--machine', 'auto'], {
    net: { machines, self: 'here' }, rpc, write: (line) => lines.push(line),
  });
  assert.deepEqual(calls, ['here']);
  assert.match(lines.join('\n'), /No machine reported free GPU memory/);
  assert.match(lines.join('\n'), /loaded on CPU/);
});

test('freeze the user service to loopback and refuse to install a missing binary', async (t) => {
  const dir = directory(t);
  const calls = [];
  const run = async (cmd, args) => calls.push([cmd, args]);
  await assert.rejects(ensureOllamaService(1234, { dir, binary: null, platform: 'linux', allowService: true, run }), /owner approves.*helm sudo/);
  assert.equal(calls.length, 0);
  await ensureOllamaService(1234, {
    dir, binary: '/some folder/ollama', platform: 'linux', allowService: true, run,
    fetcher: async (url) => {
      assert.equal(url, 'http://127.0.0.1:1234/api/version');
      return Response.json({ version: 'fake' });
    },
  });
  const unit = readFileSync(join(dir, 'helm-ollama.service'), 'utf8');
  assert.match(unit, /ExecStart="\/some folder\/ollama" serve/);
  assert.match(unit, /OLLAMA_HOST=127\.0\.0\.1:1234/);
  assert.match(unit, /OLLAMA_NO_CLOUD=1/);
  assert.deepEqual(calls, [
    ['systemctl', ['--user', 'daemon-reload']],
    ['systemctl', ['--user', 'enable', '--now', 'helm-ollama.service']],
  ]);
});

test('serve a model, forward it, restore the same gateway and unload it after an active reply', async (t) => {
  const dir = directory(t);
  const calls = [];
  let loaded = false, cached = false;
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const out = [];
  const forwards = {
    list: () => out,
    async add(row) { out.push(row); return row; },
    async remove(id, opts) { out.splice(out.findIndex((row) => row.id === id), 1); assert.equal(opts.notify, true); },
  };
  const options = {
    dir, network: () => ({ self: 'gpu' }), forwards, service: async () => {},
    fetcher: async (url, opts) => {
      const path = new URL(url).pathname;
      const body = opts.body ? JSON.parse(opts.body) : null;
      calls.push([path, body]);
      if (path === '/api/show') return cached ? Response.json({ capabilities: ['completion', 'tools'] }) : Response.json({ error: 'missing' }, { status: 404 });
      if (path === '/api/pull') { cached = true; return Response.json({ status: 'success' }); }
      if (path === '/api/generate') { loaded = body.keep_alive !== 0; return Response.json({ done: true }); }
      if (path === '/api/ps') return Response.json({ models: loaded ? [{ model: 'tiny:latest', size: 12, size_vram: 10 }] : [] });
      assert.equal(path, '/v1/chat/completions');
      assert.equal(body.model, 'tiny');
      entered.resolve();
      await release.promise;
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    },
  };
  let host = new LocalModelHost(options);
  t.after(() => host.close());
  assert.deepEqual(await host.serve('tiny'), { model: 'tiny', state: 'loaded', gpu: 10, memory: 2 });
  const { gateway } = host.catalog();
  await host.open('here', gateway.generation);
  assert.equal(out.length, 1);
  await host.close();
  host = new LocalModelHost(options);
  await host.begin();
  assert.deepEqual(host.catalog().gateway, gateway);
  const base = `http://127.0.0.1:${gateway.port}`;
  assert.deepEqual((await (await fetch(base + '/v1/models')).json()).data.map((m) => m.id), ['tiny']);
  assert.equal((await fetch(base + '/api/pull', { method: 'POST' })).status, 404);
  const ask = (model) => fetch(base + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }),
  });
  assert.equal((await ask('some-other-model')).status, 404);
  const pending = ask('tiny:latest');
  await entered.promise;
  const stopping = host.stop('tiny');
  // The stop job marks the row before it waits for the last request.
  await new Promise(setImmediate);
  assert.equal((await host.list()).models[0].state, 'stopping');
  assert.equal(loaded, true);
  assert.equal((await ask('tiny')).status, 404);
  release.resolve();
  assert.equal(await (await pending).text(), 'data: [DONE]\n\n');
  assert.deepEqual(await stopping, { stopped: true });
  assert.equal(out.length, 0);
  assert.equal(loaded, false);
  assert.equal(calls.filter(([path]) => path === '/api/pull').length, 1);
});

test('build both client accounts with the same private forward and remove them when the host stops', async (t) => {
  const dir = directory(t);
  let catalog = { gateway: { port: 3210, generation: 'a'.repeat(32) }, models: [{ model: 'tiny:0.5b', tools: true, context: 4096 }] };
  const net = { self: 'here', machines: { here: machines.here, gpu: machines.gpu } };
  const listeners = [];
  const forwards = {
    list: () => listeners,
    async add(row) { listeners.push({ ...row, listening: true, localPort: 4321 }); return listeners[0]; },
  };
  const accounts = new LocalModelAccounts({
    dir, network: () => net, host: { catalog: () => ({ models: [] }) }, forwards, version: async () => '2.3.2',
    rpc: async (_host, method) => {
      if (method === M.LOCAL_MODELS_CATALOG) return catalog;
      const { forwardId } = await import('../packages/connect/src/local-model-state.js');
      return { id: forwardId('gpu', 'here', catalog.gateway.generation), port: 3210 };
    },
  });
  const base = [{ id: 'opencode', engine: 'opencode', cmd: 'opencode' }, { id: 'pi', engine: 'pi', cmd: 'pi' }];
  const [code, pi] = await accounts.sync(base);
  assert.equal(code.id, 'local-tiny:0.5b');
  assert.equal(pi.id, 'local-tiny:0.5b@pi');
  assert.equal(localProfileCatalog(pi).default, 'helm-local/tiny:0.5b');
  const codeConfig = JSON.parse(readFileSync(code.env.OPENCODE_CONFIG));
  const piConfig = JSON.parse(readFileSync(join(pi.env.PI_CODING_AGENT_DIR, 'models.json')));
  assert.equal(codeConfig.providers['helm-local'].settings.baseURL, 'http://127.0.0.1:4321/v1');
  assert.equal(codeConfig.compaction.auto, false);
  assert.equal(piConfig.providers['helm-local'].baseUrl, 'http://127.0.0.1:4321/v1');
  assert.equal(listeners.length, 1);
  assert.deepEqual(cachedModelProfiles(base, dir), [code, pi]);
  catalog = { models: [] };
  assert.deepEqual(await accounts.sync(base, { fresh: true }), []);
  assert.deepEqual(cachedModelProfiles(base, dir), []);
});

test('use the OpenCode 1 provider settings on an older client', (t) => {
  const dir = directory(t);
  const profile = modelProfile({ engine: 'opencode', cmd: 'opencode' }, 'local-tiny',
    { model: 'tiny', tools: false, images: false, context: 4096 }, 'http://127.0.0.1:4321/v1', dir, '1.19.0');
  const config = JSON.parse(readFileSync(profile.env.OPENCODE_CONFIG));
  assert.deepEqual(config.enabled_providers, ['helm-local']);
  assert.equal(config.provider['helm-local'].npm, '@ai-sdk/openai-compatible');
  assert.equal(config.provider['helm-local'].models.tiny.tool_call, false);
});

test('resume a saved model job after restart and return its result by ID', async (t) => {
  const dir = directory(t);
  const first = Promise.withResolvers();
  let loads = 0;
  const host = { serve: async () => (++loads === 1 ? first.promise : { state: 'loaded' }) };
  const id = '1'.repeat(32);
  const jobs = new LocalModelJobs({ dir, host });
  assert.equal(jobs.submit({ id, model: 'tiny', action: 'serve' }).state, 'working');
  assert.equal(jobs.submit({ id: '2'.repeat(32), model: 'tiny:latest', action: 'serve' }).id, id);
  await new Promise(setImmediate);
  jobs.close();
  const after = new LocalModelJobs({ dir, host });
  after.begin();
  assert.equal((await after.read(id)).result.state, 'loaded');
  first.resolve({ state: 'ready' });
  assert.equal((await after.read(id)).result.state, 'loaded');
  assert.equal(loads, 2);
  after.close();
});
