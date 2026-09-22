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
 *   opencode  `opencode models --refresh`, which refreshes every configured
 *             provider through OpenCode's Models.dev catalog
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
let codexManifestCache = { at: 0, models: [] };
let modelsDevCache = { at: 0, catalog: null };

export async function listModels(engine, home, environment = {}) {
  const root = expand(home ?? ENGINES[engine]?.defaultHome ?? '~');
  const key = `${engine}|${root}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let value = { default: null, models: [] };
  try {
    if (engine === 'codex') value = await codexModels(root, environment);
    else if (engine === 'claude') value = await claudeModels(root, environment);
    else if (engine === 'opencode' || engine === 'opencode2') {
      value = await opencodeModels(root, ENGINES[engine]?.bin ?? engine, environment);
    }
    else if (engine === 'devin') value = await devinModels(root, environment);
  } catch {
    // A transient provider or CLI failure should not make a previously known
    // model disappear from the picker. The next expiry will try discovery
    // again, while this answer keeps the app useful in the meantime.
    if (hit?.value) return hit.value;
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function codexModels(root, environment) {
  let def = null;
  let effort = null;
  try {
    const toml = readFileSync(join(root, 'config.toml'), 'utf8');
    def = /^model\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null;
    effort = /^model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null;
  } catch { /* no config */ }

  // The catalog file is written by the TUI and simply does not exist on a
  // machine where codex has only ever run headless - which is how a VM ends
  // up offering one model, the default from config.toml. Ask app-server first;
  // its model/list response is the provider-backed answer for this account.
  const catalog = await codexCatalog(root, environment);
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

/** Fetch T3's provider-maintained current-model overlay; stale data is safe. */
async function codexPublishedModels() {
  if (Date.now() - codexManifestCache.at < CODEX_MANIFEST_TTL_MS) {
    return codexManifestCache.models;
  }
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
    codexManifestCache = { at: Date.now(), models };
  } catch { /* the last good manifest or the provider catalog is enough */ }
  return codexManifestCache.models;
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

  child.stdout.setEncoding('utf8');
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
  child.on('error', (error) => {
    exited = true;
    rejectPending(error);
  });
  child.on('exit', () => {
    exited = true;
    rejectPending(new Error('codex app-server exited'));
  });

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

/** codex's model catalog: live app-server first, CLI/disk fallback. */
async function codexCatalog(root, environment = {}) {
  const [live, published] = await Promise.all([
    codexAppServerCatalog(root, environment).catch(() => null),
    codexPublishedModels(),
  ]);
  if (live?.models?.length) return mergeCodexPublishedModels(live, published);

  const bin = ENGINES.codex?.bin ?? 'codex';
  try {
    const { stdout } = await exec(bin, ['debug', 'models'], {
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ...environment, CODEX_HOME: root },
    });
    const cat = JSON.parse(stdout);
    if (cat?.models?.length) return mergeCodexPublishedModels(cat, published);
  } catch { /* not installed, too old, or no network - fall back to disk */ }
  for (const file of [join(root, 'model_catalog.json'), expand('~/.codex/model_catalog.json')]) {
    if (!existsSync(file)) continue;
    try {
      const cat = JSON.parse(readFileSync(file, 'utf8'));
      if (cat?.models?.length) return mergeCodexPublishedModels(cat, published);
    } catch { /* try the next */ }
  }
  return published.length ? mergeCodexPublishedModels(null, published) : null;
}

const CLAUDE_FALLBACK_FAMILY = [
  'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5',
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
  const labels = { ...published.labels };
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

/** Fetch the shared public provider catalog, retaining the last good copy. */
async function modelsDevCatalog() {
  if (Date.now() - modelsDevCache.at < MODELS_DEV_TTL_MS && modelsDevCache.catalog) {
    return modelsDevCache.catalog;
  }
  try {
    const response = await fetch(process.env.HELM_MODELS_DEV_URL || MODELS_DEV_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`models.dev returned ${response.status}`);
    const catalog = await response.json();
    if (!catalog || typeof catalog !== 'object') throw new Error('models.dev returned no catalog');
    modelsDevCache = { at: Date.now(), catalog };
  } catch { /* provider CLI/local cache remains authoritative when available */ }
  return modelsDevCache.catalog ?? {};
}

async function modelsDevProvider(provider) {
  return parseModelsDevProvider(await modelsDevCatalog(), provider);
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
    // OpenCode documents --refresh as the way to update its Models.dev cache.
    ({ stdout } = await exec(bin, ['models', '--refresh'], {
      timeout: 20_000,
      env: { ...process.env, ...environment, XDG_CONFIG_HOME: root },
    }));
  } catch {
    // Older OpenCode builds may not know --refresh; their normal command still
    // reads the best local/provider catalog they have.
    ({ stdout } = await exec(bin, ['models'], {
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
      join(expand('~'), '.cache', 'opencode', 'models.json'),
      join(root, '..', '.cache', 'opencode', 'models.json'),
    ];
    let cache = null;
    for (const f of cacheFiles) {
      if (!existsSync(f)) continue;
      try { cache = JSON.parse(readFileSync(f, 'utf8')); break; } catch { /* next */ }
    }
    // Providers sit at the top level - opencode, opencode-go, opencode-zen
    // and any custom ones - each holding model ids without the prefix.
    for (const [provider, prov] of Object.entries(cache ?? {})) {
      for (const [id, meta] of Object.entries(prov?.models ?? {})) {
        const slug = `${provider}/${id}`;
        if (meta.name) labels[slug] = meta.name;
        if (meta.attachment) attachmentByModel[slug] = true;
        const effortOpt = (meta.reasoning_options ?? []).find((o) => o.type === 'effort');
        if (effortOpt?.values?.length) effortsByModel[slug] = effortOpt.values;
      }
    }
  } catch { /* cache unavailable - fall back to generic efforts */ }

  const order = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const union = [...new Set(Object.values(effortsByModel).flat())].sort((a, b) => order.indexOf(a) - order.indexOf(b));

  return {
    default: def,
    models,
    labels,
    efforts: union.length ? union : ['low', 'medium', 'high', 'xhigh'],
    effortsByModel,
    attachmentByModel,
    images: models.some((m) => attachmentByModel[m]),
    imagesByModel: { ...attachmentByModel },
  };
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
  }
  return args;
}
