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
 *
 * `home` is the account's home directory (CODEX_HOME etc.), so a personal
 * account reports its own default.
 *
 * Asking the CLI costs a process, so an answer is held briefly: a phone
 * opening a picker should not spawn one every time.
 */
const CACHE_MS = 60_000;
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
    else if (engine === 'opencode') value = await opencodeModels(root);
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
  return { default: def, models, effort: null, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] };
}

async function opencodeModels(root) {
  let def = null;
  try {
    // opencode's config is JSONC: strip comments before parsing.
    const raw = readFileSync(join(root, 'opencode', 'opencode.json'), 'utf8')
      .replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const cfg = JSON.parse(raw);
    if (typeof cfg.model === 'string') def = cfg.model;
  } catch { /* no config */ }
  const { stdout } = await exec('opencode', ['models'], {
    timeout: 20_000,
    env: { ...process.env, XDG_CONFIG_HOME: root },
  });
  const models = stdout.split('\n').map((l) => l.trim()).filter((l) => l && l.includes('/'));
  if (def && !models.includes(def)) models.unshift(def);
  return { default: def, models };
}

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
  } else if (engine === 'opencode') {
    if (model) args.push('-m', model);
    if (auto) args.push('--auto');
  }
  return args;
}
