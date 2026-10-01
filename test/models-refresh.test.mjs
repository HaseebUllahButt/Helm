import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    "    if (request.method === 'model/list') setTimeout(() => process.stdout.write(reply), 200);",
    "    else process.stdout.write(reply);",
    "  }",
    "});",
    '',
  ].join('\n'));
  const barrier = await barrierServer('/manifest');
  const priorPath = process.env.PATH;
  const priorManifest = process.env.HELM_CODEX_MODEL_MANIFEST_URL;
  process.env.PATH = bin + ':' + priorPath;
  process.env.HELM_CODEX_MODEL_MANIFEST_URL = barrier.url;
  try {
    const { listModels } = await import('../packages/connect/src/models.js?codex-fast-path');
    const began = Date.now();
    const first = await listModels('codex', home);
    assert.ok(Date.now() - began < 1000, 'disk catalog should not wait for public HTTP');
    assert.ok(first.models.includes('disk-model'));
    assert.equal(first.labels['disk-model'], 'Disk model label');
    assert.deepEqual(first.effortsByModel['disk-model'], ['low', 'high']);
    assert.equal(first.imagesByModel['disk-model'], false);
    await barrier.started;
    barrier.release({ currentModels: { codex: ['public-model'] } });
    const withPublic = await until(async () => {
      const current = await listModels('codex', home);
      return current.models.includes('public-model') ? current : null;
    });
    assert.ok(withPublic.models.includes('disk-model'));
    const withProvider = await until(async () => {
      const current = await listModels('codex', home);
      return current.models.includes('provider-model') ? current : null;
    });
    assert.ok(withProvider.models.includes('public-model'));
    assert.equal(withProvider.labels['provider-model'], 'Provider model');
    assert.deepEqual(withProvider.effortsByModel['provider-model'], ['xhigh']);
  } finally {
    process.env.PATH = priorPath;
    if (priorManifest === undefined) delete process.env.HELM_CODEX_MODEL_MANIFEST_URL;
    else process.env.HELM_CODEX_MODEL_MANIFEST_URL = priorManifest;
    barrier.release({ currentModels: { codex: ['test-cleanup'] } });
    await barrier.close();
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
    const refreshed = await until(async () => {
      const current = await listModels('claude', home);
      return current.models.includes('published-test-model') ? current : null;
    });
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

test('OpenCode tries usable local model rows before forced refresh', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-model-opencode-'));
  const bin = join(dir, 'bin');
  const localHome = join(dir, 'local');
  const emptyHome = join(dir, 'empty');
  mkdirSync(bin);
  mkdirSync(localHome);
  mkdirSync(emptyHome);
  writeFileSync(join(localHome, 'models.txt'), 'provider/local-model\n');
  const log = join(dir, 'calls.log');
  executable(bin, 'opencode', [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "fs.appendFileSync(process.env.OPENCODE_CALLS_PATH, process.argv.slice(2).join(' ') + '\\n');",
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
    const local = await listModels('opencode', localHome);
    assert.deepEqual(local.models, ['provider/local-model']);
    assert.equal(readFileSync(log, 'utf8').trim(), 'models');

    const refreshed = await listModels('opencode', emptyHome);
    assert.deepEqual(refreshed.models, ['provider/refreshed-model']);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
      'models', 'models', 'models --refresh',
    ]);
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
    const { listModels } = await import('../packages/connect/src/models.js?codex-failed-refresh');
    const first = await listModels('codex', home);
    await delay(100);
    const second = await listModels('codex', home);
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
