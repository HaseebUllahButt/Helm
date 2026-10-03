import { readFileSync, existsSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { ENGINES } from './engines.js';
import { expand } from './paths.js';

const exec = promisify(execFile);

/**
 * Which models a CLI on this machine can run, read from the CLI's own
 * records rather than a list baked into helm that goes stale in a month.
 *
 *   codex     `codex debug models`, falling back to a model_catalog.json
 *   claude    the account's .claude.json remembers the last model per project;
 *             Models.dev supplies the current public Anthropic catalog
 *   opencode  `opencode models` reads the local catalog; `--refresh` is only
 *             used when the local command cannot provide model rows
 *   devin     `devin models list --format json` (with text fallback) - uid plus
 *             display name; thinking level is baked into each model name
 *
 * `home` is the account's home directory (CODEX_HOME etc.), so a personal
 * account reports its own default.
 *
 * Asking the CLI costs a process, so the answer is held: a phone opening a
 * picker should not spawn one every time. A minute was too short to be that -
 * opening the settings screen twice in an afternoon spawned twice, and for
 * opencode that is a process enumerating three dozen models while a phone
 * waits. A catalogue changes when a CLI is upgraded or its config is edited,
 * neither of which is urgent to notice, so it is held for ten.
 */
const CACHE_MS = 10 * 60_000;
const cache = new Map();
const CODEX_MANIFEST_TTL_MS = 10 * 60_000;
const CODEX_MANIFEST_URL = 'https://raw.githubusercontent.com/pingdotgg/t3code/main/apps/server/src/provider/model-manifest.json';
const MODELS_DEV_TTL_MS = 10 * 60_000;
const MODELS_DEV_URL = 'https://models.dev/api.json';
const PUBLIC_CATALOG_RETRY_MS = 30_000;
const CODEX_RETRY_MS = 60_000;
let codexManifestCache = { at: 0, checkedAt: 0, models: [] };
let codexManifestInflight = null;
let modelsDevCache = { at: 0, checkedAt: 0, catalog: null };
let modelsDevInflight = null;
const discoveries = new Map();
const codexRetryAt = new Map();

/**
 * `launcher` is the {cmd, args} of an account run through a wrapper script
 * (discover.js wrappedEngine): its own binary can only be reached that way.
 */
export async function listModels(engine, home, environment = {}, launcher = null) {
  const answer = (value) => ['claude', 'gemini'].includes(engine)
    ? { ...value, refreshing: !!modelsDevInflight }
    : value;
  const key = modelsKey(engine, home, launcher);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return answer(hit.value);
  // Some CLIs take seconds to list (agy asks the server every time). A list
  // that has aged out is still a far better answer than a spinner: hand it
  // back and fetch the new one behind it.
  if (hit?.value) {
    refreshModels(key, engine, home, environment, launcher, hit).catch(() => {});
    return answer(hit.value);
  }
  return answer(await refreshModels(key, engine, home, environment, launcher, hit));
}

const modelsKey = (engine, home, launcher) => {
  const root = expand(home ?? ENGINES[engine]?.defaultHome ?? '~');
  return `${engine}|${root}|${launcher ? [launcher.cmd, ...launcher.args].join(' ') : ''}`;
};

/** Fill the cache from output something else already fetched (auth.js). */
export function primeModels(engine, home, launcher, value) {
  cache.set(modelsKey(engine, home, launcher), { at: Date.now(), value });
}

const inflight = new Map();

/** A session's live choices must never overwrite another session's cached catalog. */
export function mergeLiveModelCatalog(catalog, live, { all = false } = {}) {
  const models = { ...catalog };
  let extra = [];
  if (!live) return { models, extra };
  if (live.models?.length) {
    const advertised = new Set(live.models);
    extra = all ? [] : models.models.filter((m) => !advertised.has(m));
    models.models = all ? [...new Set([...live.models, ...models.models])] : [...live.models];
  }
  models.labels = { ...(models.labels ?? {}), ...(live.labels ?? {}) };
  // These levels belong to the current model only. In particular, [] is
  // authoritative: switching to a model without thinking removes the chip.
  models.effortsByModel = { ...(models.effortsByModel ?? {}) };
  if (live.current) models.effortsByModel[live.current] = [...(live.efforts ?? [])];
  models.effort = live.effort ?? null;
  models.efforts = [];
  if (live.current && !models.default) models.default = live.current;
  return { models, extra };
}

function refreshModels(key, engine, home, environment, launcher, hit) {
  if (inflight.has(key)) return inflight.get(key);
  discoveries.set(key, { engine, home, environment, launcher });
  const root = expand(home ?? ENGINES[engine]?.defaultHome ?? '~');
  const job = (async () => {
    let value = { default: null, models: [] };
    try {
      if (engine === 'codex') value = await codexModels(root, environment, key);
      else if (engine === 'claude') value = await claudeModels(root, environment);
      else if (engine === 'opencode' || engine === 'opencode2') {
        value = await opencodeModels(root, ENGINES[engine]?.bin ?? engine, environment);
      }
      else if (engine === 'devin') value = await devinModels(root, environment);
      else if (engine === 'grok') value = await grokModels(root, environment);
      else if (engine === 'pi' || engine === 'omp') value = await piModels(engine, root, environment);
      else if (engine === 'cursor') value = await cursorModels(environment);
      else if (engine === 'gemini') value = await geminiModels();
      else if (engine === 'agy') value = await agyModels(root, environment, launcher);
      else if (engine === 'kimi') value = await kimiModels(environment);
    } catch {
      // A transient provider or CLI failure should not make a previously known
      // model disappear from the picker. The next expiry will try discovery
      // again, while this answer keeps the app useful in the meantime.
      if (hit?.value) return hit.value;
    }
    // An empty answer from a CLI that listed models before is a hiccup, not news.
    if (!value.models?.length && hit?.value?.models?.length) return hit.value;
    cache.set(key, { at: Date.now(), value });
    return value;
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** Rebuild already-listed account caches after an optional public catalog updates. */
function refreshDiscoveredModels(engines) {
  setImmediate(async () => {
    for (const [key, discovery] of discoveries) {
      if (!engines.has(discovery.engine)) continue;
      const current = inflight.get(key);
      if (current) await current.catch(() => {});
      const hit = cache.get(key);
      try {
        await refreshModels(key, discovery.engine, discovery.home,
          discovery.environment, discovery.launcher, hit);
      } catch { /* keep the prior account-specific answer */ }
    }
  });
}

async function codexModels(root, environment, key) {
  let def = null;
  let effort = null;
  try {
    const toml = readFileSync(join(root, 'config.toml'), 'utf8');
    def = /^model\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null;
    effort = /^model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null;
  } catch { /* no config */ }

  // The catalog file belongs to this account. It is already useful offline,
  // so return it immediately and let app-server refresh the cached answer.
  const disk = readCodexDiskCatalog(root);
  if (disk?.models?.length) {
    // Start the public overlay refresh too, but neither catalog is allowed to
    // hold up the usable local answer.
    const catalog = mergeCodexPublishedModels(disk, await codexPublishedModels());
    scheduleCodexRefresh(key, root, environment, def, effort);
    return codexValue(catalog, def, effort);
  }

  // On a headless-only account there is no disk catalog; app-server remains
  // the only account-aware source. Public manifest fetches are nonblocking.
  const { catalog } = await codexCatalog(root, environment);
  return codexValue(catalog, def, effort);
}

function readCodexDiskCatalog(root) {
  try {
    const catalog = JSON.parse(readFileSync(join(root, 'model_catalog.json'), 'utf8'));
    return Array.isArray(catalog?.models) && catalog.models.length ? catalog : null;
  } catch { return null; }
}

function codexValue(catalog, def = null, effort = null) {
  const parsed = parseCodexModelList(catalog?.models ?? []);
  const models = [...parsed.models];
  if (def && !models.includes(def)) models.unshift(def);
  return {
    default: def ?? parsed.default ?? null,
    models,
    labels: parsed.labels,
    effort,
    efforts: parsed.efforts,
    effortsByModel: parsed.effortsByModel,
    speeds: parsed.speeds,
    speedByModel: parsed.speedByModel,
    images: parsed.images,
    imagesByModel: Object.fromEntries(models.map((m) => [m, parsed.imagesByModel?.[m] ?? true])),
  };
}

function scheduleCodexRefresh(key, root, environment, def, effort) {
  if (Date.now() < (codexRetryAt.get(key) ?? 0)) return;
  codexRetryAt.set(key, Date.now() + CODEX_RETRY_MS);
  setImmediate(async () => {
    try {
      const result = await codexCatalog(root, environment);
      if (!['app-server', 'debug'].includes(result?.source) || !result.catalog?.models?.length) return;
      const catalog = result.catalog;
      const fresh = codexValue(catalog, def, effort);
      // Provider discovery can fail or return less than the last usable local
      // cache. Never turn that transient result into an empty picker.
      const prior = cache.get(key)?.value;
      if (prior?.models?.length && !fresh.models.length) return;
      cache.set(key, { at: Date.now(), value: fresh });
    } catch { /* keep local data and throttle the next provider probe */ }
  });
}

/**
 * Normalize Codex app-server's model/list rows without naming model families.
 * The app-server and debug command have used slightly different field names
 * over time, so a newly published model only needs to appear in the provider
 * response for Helm to understand it.
 */
export function parseCodexModelList(rows) {
  const models = [];
  const labels = {};
  const effortsByModel = {};
  const speedByModel = {};
  const imagesByModel = {};
  let def = null;

  const text = (...values) => values.find((value) => typeof value === 'string' && value.trim())?.trim() ?? null;
  const list = (value) => Array.isArray(value) ? value : [];
  const level = (value) => typeof value === 'string'
    ? value
    : text(value?.reasoningEffort, value?.reasoning_effort, value?.effort, value?.value, value?.id);
  const tier = (value) => typeof value === 'string' ? value : text(value?.id, value?.name, value?.value);

  for (const m of Array.isArray(rows) ? rows : []) {
    const slug = text(m?.model, m?.id, m?.slug);
    if (!slug || /review|reserve/.test(slug) || models.includes(slug)) continue;
    models.push(slug);
    const label = text(m?.displayName, m?.display_name, m?.name);
    if (label) labels[slug] = label;
    if (m?.isDefault || m?.is_default) def ??= slug;

    const levels = list(m?.supportedReasoningEfforts ?? m?.supported_reasoning_efforts
      ?? m?.supportedReasoningLevels ?? m?.supported_reasoning_levels).map(level).filter(Boolean);
    if (levels.length) effortsByModel[slug] = levels;

    // What the TUI calls /fast: a service tier this model also answers on.
    const tiers = list(m?.additionalSpeedTiers ?? m?.additional_speed_tiers
      ?? m?.serviceTiers ?? m?.service_tiers).map(tier).filter(Boolean);
    if (tiers.length) speedByModel[slug] = tiers;

    const modalities = m?.inputModalities ?? m?.input_modalities;
    imagesByModel[slug] = Array.isArray(modalities)
      ? modalities.some((modality) => String(modality).toLowerCase() === 'image')
      : m?.supportsImages ?? m?.supports_images ?? true;
  }

  const effortOrder = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const efforts = [...new Set(Object.values(effortsByModel).flat())]
    .sort((a, b) => effortOrder.indexOf(a) - effortOrder.indexOf(b));
  const images = models.length ? models.some((model) => imagesByModel[model]) : true;
  return {
    default: def,
    models,
    labels,
    efforts: efforts.length ? efforts : ['low', 'medium', 'high', 'xhigh'],
    effortsByModel,
    speeds: [...new Set(Object.values(speedByModel).flat())],
    speedByModel,
    images,
    imagesByModel,
  };
}

const GENERIC_CODEX_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

const codexRowId = (row) => typeof row === 'string'
  ? row
  : row?.model ?? row?.id ?? row?.slug ?? null;

const codexLabel = (slug) => slug.startsWith('gpt-')
  ? `GPT-${slug.slice(4).split('-').map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join('-')}`
  : slug;

/**
 * Add models that the provider has published while an installed Codex CLI is
 * still serving an older local catalog. The manifest is only an additive
 * safety net; app-server remains the source of per-model capabilities.
 */
export function mergeCodexPublishedModels(catalog, published) {
  const out = { ...(catalog ?? {}) };
  const rows = [...(out.models ?? [])];
  const known = new Set(rows.map(codexRowId).filter(Boolean));
  for (const slug of Array.isArray(published) ? published : []) {
    if (typeof slug !== 'string' || !slug.trim() || known.has(slug)) continue;
    known.add(slug);
    rows.push({
      model: slug,
      displayName: codexLabel(slug),
      supportedReasoningEfforts: GENERIC_CODEX_EFFORTS,
      inputModalities: ['text', 'image'],
    });
  }
  out.models = rows;
  return out;
}

/** Keep provider answers available while refreshing the optional public overlay. */
function codexPublishedModels() {
  const now = Date.now();
  if (now - codexManifestCache.at >= CODEX_MANIFEST_TTL_MS
      && now - codexManifestCache.checkedAt >= PUBLIC_CATALOG_RETRY_MS
      && !codexManifestInflight) {
    codexManifestCache.checkedAt = now;
    codexManifestInflight = (async () => {
      try {
        const response = await fetch(process.env.HELM_CODEX_MODEL_MANIFEST_URL || CODEX_MANIFEST_URL, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error(`model manifest returned ${response.status}`);
        const manifest = await response.json();
        const models = [...new Set((manifest?.currentModels?.codex ?? [])
          .filter((model) => typeof model === 'string' && model.trim()))];
        if (!models.length) throw new Error('model manifest contained no Codex models');
        codexManifestCache = { at: Date.now(), checkedAt: Date.now(), models };
        for (const [key, row] of cache) {
          if (discoveries.get(key)?.engine !== 'codex') continue;
          const value = withPublishedCodexModels(row.value, models);
          cache.set(key, { at: Date.now(), value });
        }
      } catch { /* retain stale data and back off before trying again */ }
    })().finally(() => { codexManifestInflight = null; });
  }
  return Promise.resolve(codexManifestCache.models);
}

function withPublishedCodexModels(value, published) {
  const merged = mergeCodexPublishedModels({ models: value?.models ?? [] }, published);
  const models = [...(value?.models ?? [])];
  const labels = { ...(value?.labels ?? {}) };
  const effortsByModel = { ...(value?.effortsByModel ?? {}) };
  const imagesByModel = { ...(value?.imagesByModel ?? {}) };
  const addedEfforts = [];
  for (const row of merged.models) {
    if (!row || typeof row === 'string' || models.includes(row.model)) continue;
    models.push(row.model);
    labels[row.model] = row.displayName;
    effortsByModel[row.model] = row.supportedReasoningEfforts;
    imagesByModel[row.model] = true;
    addedEfforts.push(...row.supportedReasoningEfforts);
  }
  return {
    ...value,
    models,
    labels,
    effortsByModel,
    efforts: [...new Set([...(value?.efforts ?? []), ...addedEfforts])],
    imagesByModel,
    images: Boolean(value?.images || addedEfforts.length),
  };
}

/**
 * Ask the running Codex app-server for its provider-backed catalog. This is
 * the important path: Codex can refresh its own remote model catalog, so Helm
 * can learn about a new model without shipping a new Helm release.
 */
async function codexAppServerCatalog(root, environment = {}) {
  const bin = ENGINES.codex?.bin ?? 'codex';
  const child = spawn(bin, ['app-server', '--stdio'], {
    env: { ...process.env, ...environment, CODEX_HOME: root },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const pending = new Map();
  let nextId = 0;
  let buffer = '';
  let exited = false;

  const rejectPending = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };

  const fail = (error) => {
    if (exited) return;
    exited = true;
    rejectPending(error);
  };

  child.stdout.setEncoding('utf8');
  // A provider may exit between app-server startup and the next request. A
  // write to its closed stdin then raises EPIPE asynchronously on the stream,
  // outside the try/catch around `write`; consume it and reject pending calls.
  child.stdin.on('error', fail);
  child.stdout.on('error', fail);
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id === undefined) continue;
      const call = pending.get(message.id);
      if (!call) continue;
      pending.delete(message.id);
      clearTimeout(call.timer);
      call.resolve(message);
    }
  });
  child.on('error', fail);
  child.on('exit', () => fail(new Error('codex app-server exited')));

  const call = (method, params = {}) => new Promise((resolve, reject) => {
    if (exited) return reject(new Error('codex app-server exited'));
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`codex ${method} timed out`));
    }, 15_000);
    pending.set(id, { resolve, reject, timer });
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });

  try {
    const init = await call('initialize', {
      clientInfo: { name: 'helm-model-discovery', title: 'Helm model discovery', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    if (init.error) throw new Error(init.error.message ?? 'codex initialize failed');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');

    const rows = [];
    let cursor = null;
    for (let page = 0; page < 100; page++) {
      const response = await call('model/list', cursor ? { cursor } : {});
      if (response.error) throw new Error(response.error.message ?? 'codex model/list failed');
      const result = response.result ?? {};
      rows.push(...(Array.isArray(result) ? result : result.data ?? []));
      const next = result.nextCursor ?? result.next_cursor ?? null;
      if (!next || next === cursor) break;
      cursor = next;
    }
    return { models: rows };
  } finally {
    rejectPending(new Error('codex model discovery stopped'));
    try { child.stdin.end(); } catch { /* already closed */ }
    if (!child.killed) child.kill('SIGTERM');
  }
}

/** Codex provider catalog with its source attached for safe cache promotion. */
async function codexCatalog(root, environment = {}) {
  void codexPublishedModels();
  const live = await codexAppServerCatalog(root, environment).catch(() => null);
  if (live?.models?.length) {
    return { catalog: mergeCodexPublishedModels(live, codexManifestCache.models), source: 'app-server' };
  }

  const bin = ENGINES.codex?.bin ?? 'codex';
  try {
    const { stdout } = await exec(bin, ['debug', 'models'], {
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ...environment, CODEX_HOME: root },
    });
    const cat = JSON.parse(stdout);
    if (cat?.models?.length) {
      return { catalog: mergeCodexPublishedModels(cat, codexManifestCache.models), source: 'debug' };
    }
  } catch { /* not installed, too old, or no network - fall back to disk */ }
  const cat = readCodexDiskCatalog(root);
  if (cat) return { catalog: mergeCodexPublishedModels(cat, codexManifestCache.models), source: 'disk' };
  return codexManifestCache.models.length
    ? { catalog: mergeCodexPublishedModels(null, codexManifestCache.models), source: 'public' }
    : { catalog: null, source: null };
}

const CLAUDE_FALLBACK_FAMILY = [
  'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5',
];

/**
 * The Claude Code CLI accepts a model id but does not expose a model-list
 * command. Models.dev is Anthropic's current public catalog, so use it as an
 * additive overlay; the configured model and an already-running ACP session
 * still win when they know more about this account.
 */
async function claudeModels(root) {
  const published = await modelsDevProvider('anthropic');
  const seen = new Set([...CLAUDE_FALLBACK_FAMILY, ...published.models]);
  let def = null;
  try {
    const cfg = JSON.parse(readFileSync(join(root, '.claude.json'), 'utf8'));
    // Top-level `model` is the account default; projects carry their own.
    if (typeof cfg.model === 'string') def = cfg.model;
    for (const p of Object.values(cfg.projects ?? {})) {
      if (typeof p?.model === 'string') seen.add(p.model);
    }
  } catch { /* no config yet */ }
  const models = [...seen];
  if (def && !models.includes(def)) models.unshift(def);
  const labels = { 'claude-opus-5-5': 'Claude Opus 5.5', ...published.labels };
  // `claude --effort`; the default depends on the model, so none is claimed.
  // Every model in the family takes image input.
  return {
    default: def, models, labels, effort: null, efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    images: true,
    imagesByModel: Object.fromEntries(models.map((m) => [m, published.imagesByModel[m] ?? true])),
  };
}

/** Read one provider's rows from the public Models.dev catalog. */
export function parseModelsDevProvider(catalog, provider) {
  const rows = catalog?.[provider]?.models;
  const models = [];
  const labels = {};
  const imagesByModel = {};
  if (!rows || typeof rows !== 'object') return { models, labels, imagesByModel };
  for (const [id, meta] of Object.entries(rows)) {
    if (!id || /review|reserve|deprecated/i.test(id)) continue;
    models.push(id);
    if (typeof meta?.name === 'string' && meta.name.trim()) labels[id] = meta.name.trim();
    if (typeof meta?.attachment === 'boolean') imagesByModel[id] = meta.attachment;
  }
  return { models, labels, imagesByModel };
}

/** Return stale public data immediately and refresh it once in the background. */
function modelsDevCatalog() {
  const now = Date.now();
  if (now - modelsDevCache.at >= MODELS_DEV_TTL_MS
      && now - modelsDevCache.checkedAt >= PUBLIC_CATALOG_RETRY_MS
      && !modelsDevInflight) {
    modelsDevCache.checkedAt = now;
    modelsDevInflight = (async () => {
      try {
        const response = await fetch(process.env.HELM_MODELS_DEV_URL || MODELS_DEV_URL, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error(`models.dev returned ${response.status}`);
        const catalog = await response.json();
        if (!catalog || typeof catalog !== 'object') throw new Error('models.dev returned no catalog');
        modelsDevCache = { at: Date.now(), checkedAt: Date.now(), catalog };
        refreshDiscoveredModels(new Set(['claude', 'gemini']));
      } catch { /* keep the last good catalog and back off before retrying */ }
    })().finally(() => { modelsDevInflight = null; });
  }
  return Promise.resolve(modelsDevCache.catalog ?? {});
}

async function modelsDevProvider(provider) {
  return parseModelsDevProvider(await modelsDevCatalog(), provider);
}

/** Only expose effort levels the provider actually advertises for a model. */
export function parseOpencodeModelCache(catalog) {
  const effortsByModel = {}, labels = {}, attachmentByModel = {};
  for (const [provider, prov] of Object.entries(catalog ?? {})) {
    for (const [id, meta] of Object.entries(prov?.models ?? {})) {
      if (!meta || typeof meta !== 'object') continue;
      const slug = `${provider}/${id}`;
      if (meta.name) labels[slug] = meta.name;
      if (typeof meta.attachment === 'boolean') attachmentByModel[slug] = meta.attachment;
      const effortOpt = (Array.isArray(meta.reasoning_options) ? meta.reasoning_options : [])
        .find((o) => o?.type === 'effort');
      if (Array.isArray(effortOpt?.values)) {
        effortsByModel[slug] = [...new Set(effortOpt.values.filter((v) => typeof v === 'string' && v))];
      } else if (meta.reasoning === false) {
        effortsByModel[slug] = [];
      }
    }
  }
  return { effortsByModel, labels, attachmentByModel };
}

async function opencodeModels(root, bin = 'opencode', environment = {}) {
  let def = null;
  for (const name of ['opencode.jsonc', 'opencode.json']) {
    try {
      // Both versions accept JSONC; v2 documents the .jsonc spelling first.
      const raw = readFileSync(join(root, 'opencode', name), 'utf8')
        .replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/,\s*([}\]])/g, '$1');
      const cfg = JSON.parse(raw);
      if (typeof cfg.model === 'string') def = cfg.model;
      break;
    } catch { /* try the other spelling */ }
  }
  let stdout;
  try {
    // The normal command reads OpenCode's existing local catalog. Only try
    // its network-refresh path when there is no usable local answer.
    ({ stdout } = await exec(bin, ['models'], {
      timeout: 8_000,
      env: { ...process.env, ...environment, XDG_CONFIG_HOME: root },
    }));
    if (!stdout.split('\n').some((line) => line.trim().includes('/'))) {
      throw new Error('opencode returned no local model rows');
    }
  } catch {
    // `--refresh` is a fallback for an empty/broken local catalog, never the
    // first step on every picker request.
    ({ stdout } = await exec(bin, ['models', '--refresh'], {
      timeout: 20_000,
      env: { ...process.env, ...environment, XDG_CONFIG_HOME: root },
    }));
  }
  const models = stdout.split('\n').map((l) => l.trim()).filter((l) => l && l.includes('/'));
  if (def && !models.includes(def)) models.unshift(def);

  // Expose correct reasoning levels from opencode's models cache (provider metadata
  // at models.dev). This is the source of truth for zen/opencode models - e.g.
  // muse-spark-1.2-contributor-free supports up to xhigh, not max (only
  // muse-spark-1.3 non-free has max). Without this the UI would offer an
  // invalid level or hide a valid one.
  let effortsByModel = {};
  let labels = {};
  let attachmentByModel = {};
  try {
    const cacheFiles = [
      join(environment.XDG_CACHE_HOME || join(environment.HOME || expand('~'), '.cache'), 'opencode', 'models.json'),
      join(root, '..', '.cache', 'opencode', 'models.json'),
    ];
    let cache = null;
    for (const f of cacheFiles) {
      if (!existsSync(f)) continue;
      try { cache = JSON.parse(readFileSync(f, 'utf8')); break; } catch { /* next */ }
    }
    // Providers sit at the top level - opencode, opencode-go, opencode-zen
    // and any custom ones - each holding model ids without the prefix.
    ({ effortsByModel, labels, attachmentByModel } = parseOpencodeModelCache(cache));
  } catch { /* the live session will advertise its actual levels */ }

  return {
    default: def,
    models,
    labels,
    efforts: [],
    effortsByModel,
    attachmentByModel,
    images: models.some((m) => attachmentByModel[m]),
    imagesByModel: { ...attachmentByModel },
  };
}

/**
 * `grok models` prints a "Default model:" line then `- id` rows with `*` on
 * the current default. The same answer sits in config.toml under [models].
 */
async function grokModels(root, environment = {}) {
  let def = null;
  let effort = null;
  try {
    const toml = readFileSync(join(root, 'config.toml'), 'utf8');
    const section = /^\s*\[models\]([\s\S]*?)(?=^\s*\[|\s*$)/m.exec(toml)?.[1] ?? '';
    def = /^\s*default\s*=\s*"([^"]+)"/m.exec(section)?.[1] ?? null;
    effort = /^\s*default_reasoning_effort\s*=\s*"([^"]+)"/m.exec(section)?.[1] ?? null;
  } catch { /* no config */ }
  let models = [];
  const labels = {};
  try {
    const { stdout } = await exec(ENGINES.grok?.bin ?? 'grok', ['models'], {
      timeout: 20_000,
      env: { ...process.env, ...environment, GROK_HOME: root },
    });
    for (const line of stdout.split('\n')) {
      const listed = /^\s*[*-]\s*(\S+)/.exec(line);
      const namedDefault = /^\s*Default model:\s*(\S+)/.exec(line);
      if (namedDefault) def ??= namedDefault[1];
      if (listed) models.push(listed[1]);
    }
  } catch { /* `grok models` may still work unauthenticated; if not, empty */ }
  models = [...new Set(models)];
  if (def && !models.includes(def)) models.unshift(def);
  return { default: def, models, labels, effort, efforts: ['low', 'medium', 'high'], images: false };
}

/**
 * Pi keeps its provider catalog on disk at <home>/models.json - reading it
 * costs no process at all. omp answers `omp models --json` with the same
 * rows plus an explicit per-model thinking ladder and input list.
 */
async function piModels(engine, root, environment = {}) {
  let def = null;
  let effort = null;
  if (engine === 'omp') {
    try {
      const yml = readFileSync(join(root, 'config.yml'), 'utf8');
      const role = /^\s*default:\s*(\S+)/m.exec(yml)?.[1];
      if (role) {
        // `provider/model:thinking` - the suffix is the effort, not the name.
        const [selector, level] = role.split(':');
        def = selector;
        effort = level ?? null;
      }
    } catch { /* no config */ }
    try {
      const { stdout } = await exec(ENGINES.omp?.bin ?? 'omp', ['models', '--json'], {
        timeout: 20_000, maxBuffer: 8 << 20,
        env: { ...process.env, ...environment },
      });
      const rows = JSON.parse(stdout)?.models ?? [];
      const models = [], labels = {}, effortsByModel = {}, imagesByModel = {};
      for (const m of rows) {
        const sel = m?.selector ?? (m?.provider && m?.id ? `${m.provider}/${m.id}` : null);
        if (!sel || models.includes(sel)) continue;
        models.push(sel);
        if (m.name) labels[sel] = m.name;
        if (Array.isArray(m.thinking) && m.thinking.length) effortsByModel[sel] = m.thinking;
        if (Array.isArray(m.input)) imagesByModel[sel] = m.input.includes('image');
      }
      if (def && !models.includes(def)) models.unshift(def);
      return {
        default: def, models, labels, effort,
        efforts: [...new Set(Object.values(effortsByModel).flat())],
        effortsByModel, images: Object.values(imagesByModel).some(Boolean), imagesByModel,
      };
    } catch { /* fall through to the pi-style disk read */ }
  } else {
    try {
      const cfg = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'));
      if (cfg.defaultModel) def = cfg.defaultProvider ? `${cfg.defaultProvider}/${cfg.defaultModel}` : cfg.defaultModel;
    } catch { /* no settings */ }
  }

  // pi's models.json: providers.<name>.models[] - id, name, reasoning,
  // input, thinkingLevelMap (the levels the model actually accepts).
  const models = [], labels = {}, effortsByModel = {}, imagesByModel = {};
  for (const file of [join(root, 'models.json'), join(root, 'models-store.json')]) {
    let cat = null;
    try { cat = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    for (const [provider, p] of Object.entries(cat?.providers ?? {})) {
      for (const m of p?.models ?? []) {
        const sel = `${provider}/${m.id}`;
        if (!m.id || models.includes(sel)) continue;
        models.push(sel);
        if (m.name) labels[sel] = m.name;
        const levels = m.thinkingLevelMap && typeof m.thinkingLevelMap === 'object'
          ? Object.keys(m.thinkingLevelMap)
          : (m.reasoning ? ['off', 'minimal', 'low', 'medium', 'high'] : null);
        if (levels?.length) effortsByModel[sel] = levels;
        if (Array.isArray(m.input)) imagesByModel[sel] = m.input.includes('image');
      }
    }
    if (models.length) break;
  }
  if (def && !models.includes(def)) models.unshift(def);
  return {
    default: def, models, labels, effort,
    efforts: [...new Set(Object.values(effortsByModel).flat())],
    effortsByModel, images: Object.values(imagesByModel).some(Boolean), imagesByModel,
  };
}

/**
 * `cursor-agent models` lists the account's models as plain lines (the
 * --format json shape is `[{"id","name",...}]`). Behind `agent login` - an
 * unauthenticated box simply offers nothing until it signs in.
 */
async function cursorModels(environment = {}) {
  const bins = [ENGINES.cursor?.bin ?? 'cursor-agent', 'agent'];
  let stdout = null;
  for (const bin of bins) {
    for (const args of [['models', '--format', 'json'], ['models'], ['--list-models']]) {
      try {
        ({ stdout } = await exec(bin, args, { timeout: 20_000, env: { ...process.env, ...environment } }));
        if (stdout?.trim()) break;
      } catch { stdout = null; }
    }
    if (stdout?.trim()) break;
  }
  const models = [];
  const labels = {};
  const trimmed = (stdout ?? '').trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const rows = JSON.parse(trimmed);
      for (const r of Array.isArray(rows) ? rows : rows?.models ?? []) {
        const id = typeof r === 'string' ? r : r?.id ?? r?.model ?? r?.slug;
        if (id && !models.includes(id)) {
          models.push(id);
          const label = typeof r === 'object' && (r?.name ?? r?.displayName ?? r?.display_name);
          if (label) labels[id] = label;
        }
      }
    } catch { /* fall through to line parsing */ }
  }
  if (!models.length) {
    for (const line of trimmed.split('\n')) {
      const id = line.trim().replace(/^[*\-\s]+/, '').replace(/\s+\(default\)$/i, '');
      if (id && !/^(available|default|error|usage)/i.test(id) && !models.includes(id)) models.push(id);
    }
  }
  return { default: null, models, labels, images: true };
}

/** gemini has no listing command; the public catalog is the only honest list. */
async function geminiModels() {
  const published = await modelsDevProvider('google');
  const models = published.models.filter((m) => m.startsWith('gemini'));
  return { default: null, models, labels: published.labels, imagesByModel: published.imagesByModel, images: true };
}

/**
 * `agy models` prints `slug<TAB>Display Name` rows. settings.json remembers
 * the default by its *display name*, not the slug - resolve it back through
 * the labels the list just printed. customModels entries are already slugs.
 * An ineligible account gets an empty list; the rows still print on one that
 * is merely signed out.
 */
async function agyModels(root, environment = {}, launcher = null) {
  let stdout = '';
  try {
    const cmd = launcher ? expand(launcher.cmd) : ENGINES.agy?.bin ?? 'agy';
    ({ stdout } = await exec(cmd, [...(launcher?.args ?? []), 'models'], {
      timeout: 20_000, env: { ...process.env, ...environment },
    }));
  } catch { /* `agy models` may still work unauthenticated; if not, empty */ }
  return agyModelsFromOutput(root, stdout);
}

/**
 * `agy models` prints `slug<TAB>Display Name` rows; `root` is the gemini home,
 * whose settings.json remembers the default by display name.
 */
export function agyModelsFromOutput(root, stdout) {
  // `root` is the gemini home; agy's own store sits under it.
  const home = join(root, 'antigravity-cli');
  const models = [];
  const labels = {};
  let defLabel = null;
  try {
    const cfg = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    if (typeof cfg.model === 'string') defLabel = cfg.model;
    for (const m of cfg.customModels ?? []) {
      if (m?.modelName && !models.includes(m.modelName)) models.push(m.modelName);
      if (m?.modelName && m?.displayName) labels[m.modelName] = m.displayName;
    }
  } catch { /* no settings */ }
  for (const line of String(stdout ?? '').split('\n')) {
    const row = line.trim();
    if (!row) continue;
    // `id\tLabel` - the label itself contains spaces, so only the first
    // column break separates them.
    const m = /^(\S+)(?:\t+|\s{2,})(.+)$/.exec(row);
    const id = m?.[1] ?? row;
    const label = m?.[2]?.trim();
    if (/^(available|default|error|usage|eligibility|fetching)/i.test(id)) continue;
    if (!models.includes(id)) models.push(id);
    if (label) labels[id] ??= label;
  }
  let def = null;
  if (defLabel) def = Object.keys(labels).find((id) => labels[id] === defLabel) ?? null;
  if (def && !models.includes(def)) models.unshift(def);
  // --effort takes low|medium|high|max; stream-json input is text-only.
  return { default: def, models, labels, effort: null, efforts: ['low', 'medium', 'high', 'max'], images: false };
}

/** `kimi provider list --json` lists the configured providers' models. */
async function kimiModels(environment = {}) {
  const { stdout } = await exec(ENGINES.kimi?.bin ?? 'kimi', ['provider', 'list', '--json'], {
    timeout: 20_000, maxBuffer: 4 << 20, env: { ...process.env, ...environment },
  });
  const models = [];
  const labels = {};
  try {
    const rows = JSON.parse(stdout);
    for (const p of Array.isArray(rows) ? rows : rows?.providers ?? []) {
      for (const m of p?.models ?? []) {
        const id = typeof m === 'string' ? m : m?.id ?? m?.model;
        if (id && !models.includes(id)) {
          models.push(id);
          if (typeof m === 'object' && m?.name) labels[id] = m.name;
        }
      }
    }
  } catch { /* shape unknown - empty is honest */ }
  return { default: null, models, labels };
}

/**
 * `devin models list` prints family headers ("Claude Opus 5 (claude-opus-5)")
 * then one indented line per model: `uid   Display Name   [meta]`. The
 * account's default sits in ~/.config/devin/config.json under agent.model.
 */
/** Parse Devin's human-readable catalogue without naming model families here. */
export function parseDevinModelList(stdout) {
  try {
    const payload = JSON.parse(String(stdout ?? ''));
    const rows = Array.isArray(payload)
      ? payload
      : [payload?.models, payload?.data, payload?.items, payload?.results]
        .find(Array.isArray) ?? [];
    if (Array.isArray(payload?.families)) {
      rows.push(...payload.families.flatMap((family) => family?.variants ?? []));
    }
    const models = [];
    const labels = {};
    const seen = new Set();
    for (const row of rows) {
      const id = typeof row === 'string'
        ? row
        : row?.model ?? row?.model_uid ?? row?.id ?? row?.uid ?? row?.slug;
      if (typeof id !== 'string' || !id.trim() || seen.has(id)) continue;
      seen.add(id);
      models.push(id);
      const label = typeof row === 'object'
        && (row.name ?? row.label ?? row.displayName ?? row.display_name);
      if (typeof label === 'string' && label.trim()) labels[id] = label.trim();
    }
    if (models.length) return { models, labels };
  } catch { /* Devin's human-readable output is the fallback */ }

  const models = [];
  const labels = {};
  const seen = new Set();
  for (const line of String(stdout ?? '').split('\n')) {
    // Family headings are flush-left. Model rows are indented and have a
    // stable two-column shape, even when Devin adds a new family or variant.
    const m = /^\s{2,}(\S+)\s{2,}(.+?)(?:\s{2,}\[.*)?\s*$/.exec(line);
    if (!m || m[1] === 'aliases:' || seen.has(m[1])) continue;
    seen.add(m[1]);
    models.push(m[1]);
    labels[m[1]] = m[2].trim();
  }
  return { models, labels };
}

async function devinModels(root, environment = {}) {
  let def = null;
  try {
    const cfg = JSON.parse(readFileSync(join(root, 'devin', 'config.json'), 'utf8'));
    if (typeof cfg?.agent?.model === 'string') def = cfg.agent.model;
  } catch { /* no config */ }
  let stdout;
  try {
    ({ stdout } = await exec(ENGINES.devin?.bin ?? 'devin', ['models', 'list', '--format', 'json'], {
      timeout: 30_000,
      maxBuffer: 4 << 20,
      env: { ...process.env, ...environment, XDG_CONFIG_HOME: root },
    }));
  } catch {
    ({ stdout } = await exec(ENGINES.devin?.bin ?? 'devin', ['models', 'list'], {
      timeout: 30_000,
      maxBuffer: 4 << 20,
      env: { ...process.env, ...environment, XDG_CONFIG_HOME: root },
    }));
  }
  const { models, labels } = parseDevinModelList(stdout);
  if (def && !models.includes(def)) models.unshift(def);
  // Devin answers `promptCapabilities.image: true` at ACP `initialize`
  // (checked against devin 3000.10.21), and that answer is per-agent rather
  // than per-model. This is only the hint the composer uses before the
  // driver is up; once it is, the driver's own answer replaces it.
  return { default: def, models, labels, images: true, imagesByModel: Object.fromEntries(models.map((m) => [m, true])) };
}

/*
 * There was a `supportsImages(engine, model)` here. Its comment described
 * asking each provider's own metadata; its body was `engine === 'claude' ||
 * engine === 'codex'`, ignoring the model entirely. So the composer offered
 * a clip for any opencode model models.dev said takes attachments, and the
 * daemon then turned those bytes into `[image: shot.jpg]` on the way to the
 * agent. The running driver answers this now (`sessions.driverTakesImages`),
 * because it is the only thing that has actually spoken to the CLI.
 */

/**
 * Turn the choices a person made in the app into the CLI's own arguments.
 * Each CLI spells "just do it" differently; nobody should have to remember.
 */
export function optionArgs(engine, { model, auto, effort } = {}) {
  const args = [];
  if (engine === 'claude') {
    if (model) args.push('--model', model);
    if (auto) args.push('--permission-mode', 'auto');
  } else if (engine === 'codex') {
    if (model) args.push('-m', model);
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    if (auto) args.push('--yolo');
  } else if (engine === 'opencode' || engine === 'opencode2') {
    if (model) args.push('-m', model);
    if (auto) args.push('--auto');
  } else if (engine === 'grok') {
    if (model) args.push('-m', model);
    if (effort) args.push('--reasoning-effort', effort);
    if (auto) args.push('--permission-mode', 'auto');
  } else if (engine === 'cursor') {
    if (model) args.push('--model', model);
    if (auto) args.push('--force');
  } else if (engine === 'gemini') {
    if (model) args.push('-m', model);
    if (auto) args.push('--yolo');
  } else if (engine === 'agy') {
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (auto) args.push('--dangerously-skip-permissions');
  } else if (engine === 'muse') {
    // muse has no model picker flag verified; --yolo is its "don't stop" switch.
    if (auto) args.push('--yolo');
  }
  return args;
}
