import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINES } from './engines.js';
import { HOME, expand, collapse } from './paths.js';
import { readSecrets } from './profiles.js';

/**
 * Potential credential sources for an account, with expiry metadata.
 *
 * The auth probe asks each CLI "are you signed in" and stops there - which
 * cannot see the usual multi-account accidents: a dead OAuth grant still on
 * disk next to the env token that really authenticates, a second account's
 * home directory nobody aliased, or an inherited API key. These are diagnostic
 * hints, not proof of which source a CLI chooses or whether a refresh works.
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

const readText = (path) => {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > (256 << 10)) throw new Error('not a small credential file');
  return readFileSync(path, 'utf8');
};

const readJson = (path) => {
  try {
    return JSON.parse(readText(path));
  } catch {
    return null;
  }
};

const hint = (value) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) : null;
const timestamp = (value) => {
  if (value === null || value === undefined || value === '' || !['number', 'string'].includes(typeof value)) return null;
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= 8.64e15 ? n : null;
};
const entry = (path, fields) => ({ kind: 'file', where: collapse(path), expiresAt: null,
  ...fields, account: hint(fields.account) });

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
  const expiresAt = timestamp(o.expiresAt);
  const refreshBy = timestamp(o.refreshTokenExpiresAt);
  const claims = jwtClaims(o.accessToken);
  return [entry(path, {
    detail: `oauth${hint(o.subscriptionType) ? ` ${hint(o.subscriptionType)}` : ''}`,
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
    const seconds = timestamp(claims?.exp);
    const expiresAt = seconds === null ? null : timestamp(seconds * 1000);
    out.push(entry(path, {
      detail: json.auth_mode === 'chatgpt' ? 'chatgpt oauth' : 'oauth',
      account: t.account_id ?? null,
      expiresAt,
      expired: expiresAt !== null && expiresAt <= now,
      refresh: !!t.refresh_token,
      refreshedAt: hint(json.last_refresh),
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
    const expiresAt = timestamp(cred.expires);
    out.push(entry(path, {
      detail: `${hint(provider)} ${['api', 'oauth'].includes(cred.type) ? cred.type : 'credential'}`,
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
    text = readText(path);
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
    detail: `oauth${hint(json.auth_method) ? ` ${hint(json.auth_method)}` : ''}`,
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
 * Match materialize(): saved secret references override profile values,
 * then explicit unsets win. Do not source a shell: its exports are not the
 * daemon's launch environment, and probing it would slow the account picker.
 */
export function credentialScan(profile, { environ = process.env, secrets = readSecrets(), now = Date.now() } = {}) {
  const engine = ENGINES[profile.engine];
  if (!engine || engine.plain) return [];
  const own = { ...profile.env };
  for (const name of profile.envFrom ?? []) {
    const value = secrets[profile.secretRefs?.[name] ?? name];
    if (value) own[name] = value;
  }
  for (const name of profile.unset ?? []) own[name] = '';
  const env = { ...environ, ...own };
  const expandHome = (path) => typeof path === 'string' && path.startsWith('~')
    ? join(env.HOME || HOME, path.slice(1)) : path;
  const out = [];

  // A wrapper script manufactures its own HOME (agy-profile), so a file in
  // the default home is not this account's credential - scan env only.
  if (!profile.wraps) {
    const home = expandHome(env[engine.homeEnv] || engine.defaultHome || '');
    const files = HOME_FILES[profile.engine] ?? [];
    const seen = new Set();
    for (const spec of files) {
      const path = join(home, spec.rel);
      if (!existsSync(path)) continue;
      seen.add(path);
      for (const e of spec.read(path, now)) out.push(e);
    }
    const dataHome = expandHome(env.XDG_DATA_HOME || '~/.local/share');
    for (const spec of DATA_FILES[profile.engine] ?? []) {
      const path = join(dataHome, spec.rel);
      if (!existsSync(path) || seen.has(path)) continue;
      seen.add(path);
      for (const e of spec.read(path, now)) out.push(e);
    }
    // Engines with no known layout still get detection: any credential-named
    // file in the account home is reported, value unread.
    if (!HOME_FILES[profile.engine] && !DATA_FILES[profile.engine] && home && existsSync(home)) out.push(...genericHomeFiles(home));
    // The default claude login can name its account from ~/.claude.json.
    const hint = profile.engine === 'claude' ? claudeAccountHint(home, engine) : null;
    if (hint) for (const e of out) if (!e.account) e.account = hint;
  }

  for (const name of ENV_TOKENS[profile.engine] ?? []) {
    const via = env[name] ? (Object.hasOwn(own, name) ? 'profile' : 'daemon') : null;
    if (via) out.push({ kind: 'env', where: name, via });
  }
  return out;
}

/** One-line rendering for `helm agents`: `~/.codex/auth.json (chatgpt oauth, expired)`. */
export function formatCredential(c) {
  if (c.kind === 'env') return `${c.where} (env, ${c.via})`;
  const bits = [c.detail];
  if (c.account) bits.push(c.account);
  if (c.refreshExpired) bits.push('refresh token expired');
  if (c.expired) bits.push('access token expired');
  else if (timestamp(c.expiresAt) !== null) bits.push(`expires ${new Date(c.expiresAt).toISOString().slice(0, 10)}`);
  return `${c.where} (${bits.filter(Boolean).join(', ')})`;
}
