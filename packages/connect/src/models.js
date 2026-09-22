import { readFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
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
 *             the rest is the current published family
 *   opencode  `opencode models`, which asks every configured provider
 *   devin     `devin models list` - uid plus display name per line; thinking
 *             level is baked into each model name, so there is no effort chip
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

export async function listModels(engine, home) {
  const root = expand(home ?? ENGINES[engine]?.defaultHome ?? '~');
  const key = `${engine}|${root}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let value = { default: null, models: [] };
  try {
    if (engine === 'codex') value = await codexModels(root);
    else if (engine === 'claude') value = claudeModels(root);
    else if (engine === 'opencode' || engine === 'opencode2') {
      value = await opencodeModels(root, ENGINES[engine]?.bin ?? engine);
    }
    else if (engine === 'devin') value = await devinModels(root);
  } catch { /* fall through to nothing */ }
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function codexModels(root) {
  let def = null;
  let effort = null;
  try {
    const toml = readFileSync(join(root, 'config.toml'), 'utf8');
    def = /^model\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null;
    effort = /^model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null;
  } catch { /* no config */ }

  // The catalog file is written by the TUI and simply does not exist on a
  // machine where codex has only ever run headless - which is how a VM ends
  // up offering one model, the default from config.toml. Ask the CLI first;
  // it answers the same JSON whether or not anything was ever cached.
  const catalog = await codexCatalog(root);

  const models = [];
  const labels = {};
  const effortsByModel = {};
  const speedByModel = {};
  for (const m of catalog?.models ?? []) {
    const slug = m.slug ?? m.id;
    if (!slug || /review|reserve/.test(slug) || models.includes(slug)) continue;
    models.push(slug);
    if (m.display_name) labels[slug] = m.display_name;
    const levels = (m.supported_reasoning_levels ?? [])
      .map((l) => (typeof l === 'string' ? l : l.effort))
      .filter(Boolean);
    if (levels.length) effortsByModel[slug] = levels;
    // What the TUI calls /fast: a service tier this model also answers on.
    const tiers = m.additionalSpeedTiers ?? m.additional_speed_tiers ?? [];
    if (tiers.length) speedByModel[slug] = tiers;
  }
  if (def && !models.includes(def)) models.unshift(def);

  // The union, in the order codex lists them, for a model we know nothing about.
  const order = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const union = [...new Set(Object.values(effortsByModel).flat())]
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));

  return {
    default: def ?? null,
    models,
    labels,
    effort,
    efforts: union.length ? union : ['low', 'medium', 'high', 'xhigh'],
    effortsByModel,
    speeds: [...new Set(Object.values(speedByModel).flat())],
    speedByModel,
    // Every current codex model takes image input.
    images: true,
    imagesByModel: Object.fromEntries(models.map((m) => [m, true])),
  };
}

/** codex's model catalog: from the CLI if it will answer, else from disk. */
async function codexCatalog(root) {
  const bin = ENGINES.codex?.bin ?? 'codex';
  try {
    const { stdout } = await exec(bin, ['debug', 'models'], {
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, CODEX_HOME: root },
    });
    const cat = JSON.parse(stdout);
    if (cat?.models?.length) return cat;
  } catch { /* not installed, too old, or no network - fall back to disk */ }
  for (const file of [join(root, 'model_catalog.json'), expand('~/.codex/model_catalog.json')]) {
    if (!existsSync(file)) continue;
    try {
      const cat = JSON.parse(readFileSync(file, 'utf8'));
      if (cat?.models?.length) return cat;
    } catch { /* try the next */ }
  }
  return null;
}

const CLAUDE_FAMILY = [
  'claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5',
];

function claudeModels(root) {
  const seen = new Set(CLAUDE_FAMILY);
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
  // `claude --effort`; the default depends on the model, so none is claimed.
  // Every model in the family takes image input.
  return {
    default: def, models, effort: null, efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    images: true, imagesByModel: Object.fromEntries(models.map((m) => [m, true])),
  };
}

async function opencodeModels(root, bin = 'opencode') {
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
  const { stdout } = await exec(bin, ['models'], {
    timeout: 20_000,
    env: { ...process.env, XDG_CONFIG_HOME: root },
  });
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

async function devinModels(root) {
  let def = null;
  try {
    const cfg = JSON.parse(readFileSync(join(root, 'devin', 'config.json'), 'utf8'));
    if (typeof cfg?.agent?.model === 'string') def = cfg.agent.model;
  } catch { /* no config */ }
  const { stdout } = await exec(ENGINES.devin?.bin ?? 'devin', ['models', 'list'], {
    timeout: 30_000,
    maxBuffer: 4 << 20,
    env: { ...process.env, XDG_CONFIG_HOME: root },
  });
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
