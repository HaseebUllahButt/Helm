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
 *   codex     ~/.codex/model_catalog.json (slugs) + config.toml `model`
 *   claude    the account's .claude.json remembers the last model per project;
 *             the rest is the current published family
 *   opencode  `opencode models`, which asks every configured provider
 *
 * `home` is the account's home directory (CODEX_HOME etc.), so a personal
 * account reports its own default.
 */
export async function listModels(engine, home) {
  const root = expand(home ?? ENGINES[engine]?.defaultHome ?? '~');
  try {
    if (engine === 'codex') return codexModels(root);
    if (engine === 'claude') return claudeModels(root);
    if (engine === 'opencode') return await opencodeModels(root);
  } catch { /* fall through to nothing */ }
  return { default: null, models: [] };
}

function codexModels(root) {
  let def = null;
  let effort = null;
  try {
    const toml = readFileSync(join(root, 'config.toml'), 'utf8');
    def = /^model\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null;
    effort = /^model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null;
  } catch { /* no config */ }
  const models = [];
  for (const file of [join(root, 'model_catalog.json'), expand('~/.codex/model_catalog.json')]) {
    if (!existsSync(file)) continue;
    try {
      const cat = JSON.parse(readFileSync(file, 'utf8'));
      for (const m of cat.models ?? []) {
        const slug = m.slug ?? m.id;
        if (slug && !/review|reserve/.test(slug) && !models.includes(slug)) models.push(slug);
      }
      if (models.length) break;
    } catch { /* try the next */ }
  }
  if (def && !models.includes(def)) models.unshift(def);
  return { default: def, models, effort, efforts: ['low', 'medium', 'high', 'xhigh'] };
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
  return { default: def, models };
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
