import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { ENGINES, engineForCommand } from './engines.js';
import { HOME, expand, collapse } from './paths.js';

const exec = promisify(execFile);

// Values that look like credentials are never copied into a profile; we keep
// the variable NAME and leave the value where it already lives.
const SECRET_NAME = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH)/i;
const SECRET_VALUE = /^(sk-|ghp_|gho_|github_pat_|bd_live_|xox[baprs]-)/;

export const looksSecret = (name, value) =>
  SECRET_NAME.test(name) || SECRET_VALUE.test(String(value ?? ''));

// ---------------------------------------------------------------- binaries

async function which(bin) {
  try {
    const { stdout } = await exec('sh', ['-lc', `command -v ${bin}`]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Find alternate home directories for an engine - `~/.codex-personal` next to
 * `~/.codex`, and so on. These are how this machine's extra accounts are kept
 * apart, so each one we find becomes a candidate profile.
 */
function altHomes(engine) {
  if (!engine.defaultHome) return [];
  const base = expand(engine.defaultHome);
  const name = base.split('/').pop();
  const parent = base.slice(0, -name.length - 1) || HOME;
  if (!existsSync(parent)) return [];
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(parent, d.name))
      .filter((p) => p !== base && p.split('/').pop().startsWith(name + '-'))
      .map(collapse);
  } catch {
    return [];
  }
}

// ------------------------------------------------------- shell symbol table

/**
 * Ask the user's own shell what its aliases and functions actually are.
 *
 * Parsing rc files with regexes gets this wrong in practice - adjacent-quote
 * concatenation, conditionals, sourced fragments. An interactive shell has
 * already resolved all of that, and prints definitions back in a normalised,
 * re-quotable form.
 */
async function shellSymbols() {
  const symbols = new Map();
  const run = async (args) => {
    try {
      const { stdout } = await exec('bash', args, {
        timeout: 8000,
        maxBuffer: 4 << 20,
        env: { ...process.env, CON_DISCOVERY: '1' },
      });
      return stdout;
    } catch (err) {
      return err?.stdout || '';
    }
  };

  for (const line of (await run(['-ic', 'alias'])).split('\n')) {
    const m = /^alias\s+([^=]+)=(.*)$/.exec(line.trim());
    if (m) symbols.set(m[1], { kind: 'alias', body: unquote(m[2]) });
  }

  // One call for every function body: an alias may point at a function that
  // points at another function, so we need the whole table, not a filtered one.
  const dump = await run(['-ic', 'declare -f']);
  for (const chunk of dump.split(/\n(?=[A-Za-z_][A-Za-z0-9_:.-]*\s*\(\)\s*$)/m)) {
    const name = /^([A-Za-z_][A-Za-z0-9_:.-]*)\s*\(\)/.exec(chunk.trim())?.[1];
    if (name && !symbols.has(name)) symbols.set(name, { kind: 'function', body: chunk });
  }
  return symbols;
}

/** Strip one layer of shell quoting, honouring bash's '\'' escape form. */
function unquote(s) {
  const t = s.trim();
  if (t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replaceAll(`'\\''`, "'");
  }
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
  return t;
}

/** Split a command string into tokens, keeping quoted runs together. */
function tokenize(s) {
  const out = [];
  let cur = '';
  let quote = null;
  let touched = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; touched = true; continue; }
    if (/\s/.test(c)) {
      if (cur || touched) { out.push(cur); cur = ''; touched = false; }
      continue;
    }
    cur += c;
  }
  if (cur || touched) out.push(cur);
  return out;
}

/**
 * The last command in a `a && b`, `a; b` or `a || b` chain, quotes respected.
 * An alias like `clear && claude --permission-mode auto` is about claude; the
 * clear is just tidying up first.
 */
function lastCommand(s) {
  const segments = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if ((c === '&' || c === '|') && s[i + 1] === c) { segments.push(cur); cur = ''; i++; continue; }
    if (c === ';') { segments.push(cur); cur = ''; continue; }
    cur += c;
  }
  segments.push(cur);
  const real = segments.map((x) => x.trim()).filter(Boolean);
  return real[real.length - 1] ?? s;
}

/** Peel leading `VAR=value` assignments off a token list. */
function splitAssignments(tokens) {
  const env = {};
  let i = 0;
  for (; i < tokens.length; i++) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(tokens[i]);
    if (!m) break;
    env[m[1]] = m[2];
  }
  return { env, argv: tokens.slice(i) };
}

/** Reduce a function body to the same {env, argv} shape as an alias. */
function parseFunction(body) {
  const env = {};
  const unset = [];
  let argv = null;
  for (let raw of body.split('\n')) {
    const trimmed = raw.trim();
    // Drop the `name ()` header before anything else - stripping grouping
    // parens first would turn it into a bogus command.
    if (!trimmed || trimmed === '{' || trimmed === '}') continue;
    if (/^[A-Za-z_][A-Za-z0-9_:.-]*\s*\(\)\s*$/.test(trimmed)) continue;

    // Bodies routinely wrap themselves in a subshell so exports do not leak;
    // the grouping parens carry no meaning for us.
    const line = trimmed
      .replace(/^[({]\s*/, '')
      .replace(/\s*[)}]+$/, '')
      .replace(/;$/, '')
      .trim();
    if (!line) continue;

    const cleared = /^unset\s+(.+)$/.exec(line);
    if (cleared) { unset.push(...tokenize(cleared[1])); continue; }

    const assign = /^(?:export\s+|local\s+|declare\s+-x\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(line);
    if (assign) { env[assign[1]] = unquote(assign[2]); continue; }

    if (argv) continue; // first real command wins; ignore trailing cleanup
    let tokens = tokenize(line).filter((t) => t !== '$@' && t !== '$*');
    while (tokens[0] === 'command' || tokens[0] === 'exec' || tokens[0] === 'builtin') {
      tokens = tokens.slice(1);
    }
    const split = splitAssignments(tokens);
    Object.assign(env, split.env);
    if (split.argv.length) argv = split.argv;
  }
  return { env, unset, argv: argv || [] };
}

/**
 * Follow an alias through however many other aliases and functions it points
 * at until we reach a real binary, merging env and arguments on the way.
 * `d` -> `codexpx` -> `codexp --yolo` -> `CODEX_HOME=... codex --yolo`.
 */
function resolve(name, symbols, depth = 0, seen = new Set()) {
  if (depth > 6 || seen.has(name)) return null;
  seen.add(name);
  const sym = symbols.get(name);
  if (!sym) return null;

  const parsed =
    sym.kind === 'function'
      ? parseFunction(sym.body)
      : splitAssignments(tokenize(lastCommand(sym.body)));
  if (!parsed.argv.length) return null;

  const [head, ...rest] = parsed.argv;
  const inner = resolve(head, symbols, depth + 1, seen);
  if (!inner) return { env: parsed.env, unset: parsed.unset || [], argv: parsed.argv };

  // The outer definition's env wins: it is the more specific one.
  return {
    env: { ...inner.env, ...parsed.env },
    unset: [...(inner.unset || []), ...(parsed.unset || [])],
    argv: [...inner.argv, ...rest],
  };
}

// --------------------------------------------------------------- public API

/**
 * Build the profile list for this machine: what is installed, which extra
 * accounts exist, and what the user's own aliases already encode.
 */
export async function discoverProfiles() {
  const profiles = [];
  const secrets = {};
  const seen = new Set();

  const byKey = new Map();
  const add = (p) => {
    const key = [
      p.cmd,
      (p.args || []).join(' '),
      JSON.stringify(p.env || {}),
      (p.envFrom || []).join(','),
      (p.unset || []).join(','),
    ].join('|');
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, p);
      profiles.push(p);
      return;
    }
    // Same invocation reached two ways. A name the user chose themselves is
    // more meaningful than one we synthesised from a directory listing.
    if (p.source === 'alias' && existing.source === 'detected') {
      existing.id = p.id;
      existing.label = p.label;
      existing.source = 'alias';
    }
  };

  // 1. Engines actually installed on this box. One `command -v` each, asked
  // at once - they are the same question, not four.
  const installed = {};
  const paths = await Promise.all(
    Object.values(ENGINES).map((e) => (e.bin ? which(e.bin) : null))
  );
  for (const [i, engine] of Object.values(ENGINES).entries()) {
    const path = paths[i];
    if (!path) continue;
    installed[engine.id] = path;

    add({
      id: engine.id,
      label: engine.label,
      engine: engine.id,
      cmd: engine.bin,
      args: [],
      env: {},
      source: 'detected',
    });

    // 2. Extra accounts, inferred from sibling home directories.
    for (const home of altHomes(engine)) {
      const suffix = home.split('/').pop().split('-').slice(1).join('-');
      add({
        id: `${engine.id}-${suffix}`,
        label: `${engine.label} · ${suffix}`,
        engine: engine.id,
        cmd: engine.bin,
        args: [],
        env: { [engine.homeEnv]: home },
        source: 'detected',
      });
    }
  }

  // 3. A plain terminal, so the app can give you a shell next to the agents.
  add({
    id: 'shell',
    label: 'Shell',
    engine: 'shell',
    cmd: process.env.SHELL || '/bin/bash',
    args: [],
    env: {},
    source: 'builtin',
  });

  // 4. Whatever the user's shell config already says.
  const symbols = await shellSymbols();
  for (const name of symbols.keys()) {
    const resolved = resolve(name, symbols);
    if (!resolved) continue;
    const engineId = engineForCommand(resolved.argv[0]);
    if (!engineId || !installed[engineId]) continue;

    const env = {};
    const envFrom = [];
    for (const [k, v] of Object.entries(resolved.env)) {
      if (looksSecret(k, v)) {
        // Keep the name, bank the value outside the profile.
        secrets[k] = v;
        envFrom.push(k);
      } else {
        env[k] = collapse(v.replace(/^\$HOME/, HOME));
      }
    }

    add({
      id: name,
      label: name,
      engine: engineId,
      cmd: resolved.argv[0],
      args: resolved.argv.slice(1),
      env,
      envFrom,
      unset: resolved.unset || [],
      source: 'alias',
    });
  }

  return { profiles, secrets, installed };
}
