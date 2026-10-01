import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINES } from './engines.js';
import { HOME, expand, collapse } from './paths.js';

/**
 * Where an account's credentials actually are, and whether they look alive.
 *
 * The auth probe asks each CLI "are you signed in" and stops there - which
 * cannot see the usual multi-account accidents: a dead OAuth grant still on
 * disk next to the env token that really authenticates, a second account's
 * home directory nobody aliased, an `export ANTHROPIC_API_KEY` in an rc file
 * silently feeding every default profile. This scan is the other half of
 * that answer: the credential sources each profile would pick up.
 *
 * Everything here is metadata - location, kind, expiry, an account hint.
 * Token values never enter the result, let alone the wire.
 */

const jwtClaims = (token) => {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

const entry = (path, fields) => ({ kind: 'file', where: collapse(path), account: null, expiresAt: null, ...fields });

/** Claude: `claudeAiOauth` is the login; `mcpOAuth` entries are server grants, not one. */
function readClaude(path, now) {
  const json = readJson(path);
  if (!json) return [entry(path, { detail: 'unreadable file' })];
  const o = json.claudeAiOauth;
  if (!o) {
    const mcp = Object.keys(json.mcpOAuth ?? {}).length;
    return [entry(path, {
      detail: mcp ? `mcp server tokens only (${mcp}) - no Claude login` : 'no Claude login',
      state: 'empty',
    })];
  }
  // Note: expiresAt can legitimately be 0 - Number.isFinite, not truthiness.
  const expiresAt = Number.isFinite(Number(o.expiresAt)) ? Number(o.expiresAt) : null;
  const refreshBy = Number.isFinite(Number(o.refreshTokenExpiresAt)) ? Number(o.refreshTokenExpiresAt) : null;
  const claims = jwtClaims(o.accessToken);
  return [entry(path, {
    detail: `oauth${o.subscriptionType ? ` ${o.subscriptionType}` : ''}`,
    account: o.emailAddress ?? claims?.email ?? null,
    expiresAt,
    expired: expiresAt !== null && expiresAt <= now,
    refreshExpired: refreshBy !== null && refreshBy <= now,
  })];
}

/** Codex: auth.json is either a ChatGPT oauth bundle or a bare api key. */
function readCodex(path, now) {
  const json = readJson(path);
  if (!json) return [entry(path, { detail: 'unreadable file' })];
  const out = [];
  const t = json.tokens;
  if (t && typeof t === 'object') {
    const claims = jwtClaims(t.access_token);
    const expiresAt = claims?.exp ? claims.exp * 1000 : null;
    out.push(entry(path, {
      detail: json.auth_mode === 'chatgpt' ? 'chatgpt oauth' : (json.auth_mode || 'oauth'),
      account: t.account_id ?? null,
      expiresAt,
      expired: expiresAt !== null && expiresAt <= now,
      refresh: !!t.refresh_token,
      refreshedAt: json.last_refresh ?? null,
    }));
  }
  if (json.OPENAI_API_KEY) out.push(entry(path, { detail: 'openai api key' }));
  if (!out.length) out.push(entry(path, { detail: 'no usable token', state: 'empty' }));
  return out;
}

/** opencode keeps one entry per provider in its data-home auth.json. */
function readOpencode(path, now) {
  const json = readJson(path);
  if (!json || typeof json !== 'object') return [entry(path, { detail: 'unreadable file' })];
  const out = [];
  for (const [provider, cred] of Object.entries(json)) {
    if (!cred || typeof cred !== 'object') continue;
    const expiresAt = Number.isFinite(Number(cred.expires)) ? Number(cred.expires) : null;
    out.push(entry(path, {
      detail: `${provider} ${cred.type ?? 'credential'}`,
      account: cred.accountId ?? null,
      expiresAt,
      expired: expiresAt !== null && expiresAt <= now,
    }));
  }
  return out.length ? out : [entry(path, { detail: 'no providers', state: 'empty' })];
}

/** Devin's credentials.toml: report which credential keys exist, not values. */
function readDevin(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [entry(path, { detail: 'unreadable file' })];
  }
  const keys = [...text.matchAll(/^([A-Za-z_][\w-]*)\s*=/gm)]
    .map((m) => m[1])
    .filter((k) => /key|token|secret/i.test(k));
  return [entry(path, { detail: keys.length ? `keys: ${keys.join(', ')}` : 'no credential keys' })];
}

/** Google-style stores: { token: { access_token, refresh_token, expiry } , id_token }. */
function readGoogleOauth(path, now) {
  const json = readJson(path);
  if (!json) return [entry(path, { detail: 'unreadable file' })];
  const tok = json.token && typeof json.token === 'object' ? json.token : json;
  const rawExpiry = tok.expiry ?? tok.expiry_date ?? tok.expires_at;
  const expiresAt = typeof rawExpiry === 'string' ? Date.parse(rawExpiry)
    : Number.isFinite(rawExpiry) ? Number(rawExpiry) : null;
  const claims = jwtClaims(json.id_token ?? tok.id_token);
  return [entry(path, {
    detail: `oauth${json.auth_method ? ` ${json.auth_method}` : ''}`,
    account: claims?.email ?? null,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    expired: Number.isFinite(expiresAt) && expiresAt <= now,
    refresh: !!(tok.refresh_token),
  })];
}

/** Engines whose credential files live under the account home (homeEnv). */
const HOME_FILES = {
  claude: [{ rel: '.credentials.json', read: readClaude }],
  codex: [{ rel: 'auth.json', read: readCodex }],
  agy: [{ rel: 'antigravity-cli/antigravity-oauth-token', read: readGoogleOauth }],
  antigravity: [{ rel: 'antigravity-cli/antigravity-oauth-token', read: readGoogleOauth }],
  gemini: [{ rel: 'oauth_creds.json', read: readGoogleOauth }],
};

/** Engines whose store sits under XDG_DATA_HOME rather than the config home. */
const DATA_FILES = {
  opencode: [{ rel: 'opencode/auth.json', read: readOpencode }],
  opencode2: [{ rel: 'opencode/auth.json', read: readOpencode }],
  devin: [{ rel: 'devin/credentials.toml', read: readDevin }],
};

/**
 * Variables that authenticate a run on their own. These are the shadowing
 * hazards: an exported token beats the file the CLI shows in its settings.
 */
const ENV_TOKENS = {
  claude: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  opencode: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
  opencode2: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
  devin: ['DEVIN_API_KEY'],
  agy: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  antigravity: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  gemini: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  grok: ['XAI_API_KEY', 'GROK_API_KEY'],
  cursor: ['CURSOR_API_KEY'],
  kimi: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  rovo: ['ATLASSIAN_API_TOKEN', 'ROVO_API_KEY'],
};

export const CREDENTIAL_ENV_NAMES = [...new Set(Object.values(ENV_TOKENS).flat())];

/** Claude's ~/.claude.json remembers which account the default login is. */
function claudeAccountHint(home, engine) {
  if (home !== expand(engine.defaultHome)) return null;
  const account = readJson(join(HOME, '.claude.json'))?.oauthAccount?.emailAddress;
  return typeof account === 'string' && account ? account : null;
}

/** A cred-looking filename in an engine home we have no reader for. */
const CRED_NAME = /cred|token|oauth|api[-_]?key|secret/i;

function genericHomeFiles(home) {
  let names;
  try {
    names = readdirSync(home, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const d of names) {
    if (!d.isFile() || !CRED_NAME.test(d.name)) continue;
    const p = join(home, d.name);
    try {
      if (statSync(p).size > 256 << 10) continue;
    } catch { continue; }
    out.push(entry(p, { detail: 'credential file' }));
  }
  return out;
}

/**
 * The variables an interactive login shell exports - where an rc-file
 * `export FOO_TOKEN=…` that no alias captured still turns up. One probe is
 * shared by every profile in a scan pass.
 */
export function shellEnv() {
  return new Promise((resolve) => {
    execFile('bash', ['-ic', 'env'], {
      timeout: 8000,
      maxBuffer: 1 << 20,
      env: { ...process.env, HELM_DISCOVERY: '1' },
    }, (err, stdout) => {
      if (err && !stdout) return resolve(new Set());
      const names = new Set();
      for (const line of String(stdout).split('\n')) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
        if (m) names.add(m[1]);
      }
      resolve(names);
    });
  });
}

/**
 * Every credential source a profile would run with. `shellNames` is the
 * shared shellEnv() set; `environ` defaults to the daemon's environment so a
 * token the daemon itself exports is visible too.
 */
export function credentialScan(profile, { shellNames = null, environ = process.env, now = Date.now() } = {}) {
  const engine = ENGINES[profile.engine];
  if (!engine || engine.plain) return [];
  const env = profile.env ?? {};
  const out = [];

  // A wrapper script manufactures its own HOME (agy-profile), so a file in
  // the default home is not this account's credential - scan env only.
  if (!profile.wraps) {
    const home = expand(env[engine.homeEnv] ?? engine.defaultHome ?? '');
    const files = HOME_FILES[profile.engine] ?? [];
    const seen = new Set();
    for (const spec of files) {
      const path = join(home, spec.rel);
      if (!existsSync(path)) continue;
      seen.add(path);
      for (const e of spec.read(path, now)) out.push(e);
    }
    const dataHome = expand(env.XDG_DATA_HOME ?? '~/.local/share');
    for (const spec of DATA_FILES[profile.engine] ?? []) {
      const path = join(dataHome, spec.rel);
      if (!existsSync(path) || seen.has(path)) continue;
      seen.add(path);
      for (const e of spec.read(path, now)) out.push(e);
    }
    // Engines with no known layout still get detection: any credential-named
    // file in the account home is reported, value unread.
    if (!out.length && home && existsSync(home)) out.push(...genericHomeFiles(home));
    // The default claude login can name its account from ~/.claude.json.
    const hint = profile.engine === 'claude' ? claudeAccountHint(home, engine) : null;
    if (hint) for (const e of out) if (!e.account) e.account = hint;
  }

  const unset = new Set(profile.unset ?? []);
  const wired = new Set([...(profile.envFrom ?? []), ...Object.keys(env)]);
  for (const name of ENV_TOKENS[profile.engine] ?? []) {
    if (unset.has(name)) continue;
    const via = wired.has(name) ? 'profile' : shellNames?.has(name) ? 'shell' : environ[name] ? 'daemon' : null;
    if (via) out.push({ kind: 'env', where: name, via });
  }
  return out;
}

/** One-line rendering for `helm agents`: `~/.codex/auth.json (chatgpt oauth, expired)`. */
export function formatCredential(c) {
  if (c.kind === 'env') return `${c.where} (env, ${c.via})`;
  const bits = [c.detail];
  if (c.account) bits.push(c.account);
  if (c.refreshExpired) bits.push('refresh token dead');
  if (c.expired) bits.push('expired');
  else if (c.expiresAt) bits.push(`expires ${new Date(c.expiresAt).toISOString().slice(0, 10)}`);
  return `${c.where} (${bits.filter(Boolean).join(', ')})`;
}
