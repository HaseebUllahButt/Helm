import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ENGINES, engineForCommand } from './engines.js';
import { antigravityInstall } from './antigravity.js';
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
        env: { ...process.env, HELM_DISCOVERY: '1' },
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

// ------------------------------------------------------------ wrapper scripts

/**
 * The engine a wrapper script launches, or null. People keep extra accounts
 * behind scripts as well as aliases - `a1='agy-profile 1'`, where agy-profile
 * points HOME at ~/.config/google-cli-profiles/agy-1 and then `exec`s agy.
 * Nothing about that is visible from the alias, so read the script: when it
 * ends by exec-ing an engine's binary, the alias is an account of that engine,
 * run through the script. Variables the script assigns are substituted so
 * `exec "$agy_bin" "$@"` still names agy.
 */
export function wrappedEngine(path) {
  let text;
  try {
    if (!statSync(path).isFile() || statSync(path).size > 64 << 10) return null;
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  if (!text.startsWith('#!')) return null;

  const vars = { HOME };
  const sub = (s) => s.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)(?::?[-=?][^}]*)?\}?/g, (m, name) => vars[name] ?? m);
  let engine = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const assign = /^(?:export\s+|local\s+|readonly\s+|declare\s+(?:-\w+\s+)?)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (assign) {
      const value = tokenize(assign[2])[0];
      if (value !== undefined) vars[assign[1]] = sub(value);
      continue;
    }
    const run = /^exec\s+(.*)$/.exec(line);
    if (!run) continue;
    let argv = splitAssignments(tokenize(run[1])).argv;
    // `exec env VAR=x agy` runs agy just the same.
    if (argv[0] === 'env') argv = splitAssignments(argv.slice(1).filter((t) => !t.startsWith('-'))).argv;
    if (argv.length) engine = engineForCommand(sub(argv[0])) ?? engine;
  }
  return engine;
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
      JSON.stringify(p.secretRefs || {}),
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
    } else if (p.source === 'alias' && existing.source === 'alias') {
      // Preserve the names people use even when two aliases launch alike.
      profiles.push(p);
    }
  };

  // 1. Engines actually installed on this box. One `command -v` each, asked
  // at once - they are the same question, not four. An engine may ship under
  // an older name (cursor-agent used to be `agent`), so probe its altBins.
  const installed = {};
  const paths = await Promise.all(
    Object.values(ENGINES).map(async (e) => {
      // A managed engine ships no PATH binary; it is "installed" when the
      // runtime helm downloaded is in place (antigravity's ACP agent).
      if (e.managed) {
        const install = antigravityInstall();
        return install ? { bin: install.exe, path: install.exe } : null;
      }
      if (!e.bin) return null;
      for (const bin of [e.bin, ...(e.altBins ?? [])]) {
        const path = await which(bin);
        if (path) return { bin, path };
      }
      return null;
    })
  );
  for (const [i, engine] of Object.values(ENGINES).entries()) {
    const hit = paths[i];
    if (!hit) continue;
    installed[engine.id] = hit.path;

    add({
      id: engine.id,
      label: engine.label,
      engine: engine.id,
      cmd: hit.bin,
      args: [],
      // A managed engine's own home must be set on every profile: with no
      // GEMINI_HOME the agent would share the user's real ~/.gemini.
      env: engine.managed && engine.homeEnv ? { [engine.homeEnv]: engine.defaultHome } : {},
      source: 'detected',
    });

    // 2. Extra accounts, inferred from sibling home directories. Only an
    // engine with an env-isolated home can run a second account this way;
    // without one there is no variable to point at the sibling directory.
    for (const home of engine.homeEnv ? altHomes(engine) : []) {
      const suffix = home.split('/').pop().split('-').slice(1).join('-');
      add({
        id: `${engine.id}-${suffix}`,
        label: `${engine.label} · ${suffix}`,
        engine: engine.id,
        // hit.bin is the engine's own bin, or the managed exe path when
        // there is no PATH binary at all (antigravity's ACP agent).
        cmd: hit.bin,
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
  const aliases = await discoverAliasProfiles(symbols, installed);
  Object.assign(secrets, aliases.secrets);
  for (const profile of aliases.profiles) add(profile);

  return { profiles, secrets, installed };
}

/** Import alias credentials by reference, preserving distinct token accounts. */
export async function discoverAliasProfiles(symbols, installed) {
  const profiles = [];
  const secrets = {};
  for (const name of symbols.keys()) {
    const resolved = resolve(name, symbols);
    if (!resolved) continue;
    let engineId = engineForCommand(resolved.argv[0]);
    // Not an engine itself: maybe a script that launches one.
    let wraps = null;
    if (!engineId) {
      const path = resolved.argv[0].includes('/') ? expand(resolved.argv[0]) : await which(resolved.argv[0]);
      engineId = path ? wrappedEngine(path) : null;
      // Keep the script's full path: the daemon's PATH may not reach it.
      if (engineId) { wraps = engineId; resolved.argv[0] = collapse(path); }
    }
    if (!engineId || !installed[engineId]) continue;

    const env = {};
    const envFrom = [];
    const secretRefs = {};
    for (const [k, v] of Object.entries(resolved.env)) {
      if (looksSecret(k, v)) {
        // Keep the name, bank the value outside the profile.
        // The same variable can hold a different token in every alias. A
        // content-addressed local slot also lets aliases of one token share
        // their account settings, without putting the token in a profile.
        const ref = `HELM_SECRET_${createHash('sha256').update(k + '\0' + v).digest('hex')}`;
        secrets[ref] = v;
        envFrom.push(k);
        secretRefs[k] = ref;
      } else {
        env[k] = collapse(v.replace(/^\$HOME/, HOME));
      }
    }

    profiles.push({
      id: name,
      label: name,
      engine: engineId,
      cmd: resolved.argv[0],
      args: resolved.argv.slice(1),
      env,
      envFrom,
      ...(envFrom.length ? { secretRefs } : {}),
      unset: resolved.unset || [],
      source: 'alias',
      // Launched through a script: anything that runs the engine's own binary
      // for this account (listing models) has to go through it too.
      ...(wraps ? { wraps } : {}),
    });
  }

  return { profiles, secrets };
}
