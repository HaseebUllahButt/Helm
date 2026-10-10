import { materialize } from './profiles.js';
import { accountKey } from './settings.js';
import { expand } from './paths.js';
import { ENGINES } from './engines.js';

const AUTH_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'];

/** A shared config folder can hold several logins; never save defaults to the first alias by accident. */
export function nativeClaudeAccount(session, profiles, { env = null, spec = materialize } = {}) {
  const candidates = profiles.filter(profile => profile.engine === 'claude'
    && expand(profile.env?.CLAUDE_CONFIG_DIR || '~/.claude') === expand(session.nativeHome || '~/.claude'));
  const known = candidates.find(profile => profile.id === session.profileId);
  if (known && !env) return known;
  const matching = env ? candidates.filter(profile => {
    const expected = spec(profile).env;
    return AUTH_KEYS.every(key => (expected[key] || '') === (env[key] || ''));
  }) : candidates;
  if (known && matching.includes(known)) return known;
  return new Set(matching.map(accountKey)).size === 1 ? matching[0] : null;
}

/** Defaults may be written only after the native account is uniquely identified. */
export function nativeAccount(session, profiles, { env = null, spec = materialize } = {}) {
  if (session.engine === 'claude') return nativeClaudeAccount(session, profiles, { env, spec });
  const engine = ENGINES[session.engine];
  if (!engine) return null;
  const candidates = profiles.filter(profile => profile.engine === session.engine
    && expand(spec(profile).env?.[engine.homeEnv] || engine.defaultHome) === expand(session.nativeHome || engine.defaultHome));
  const known = candidates.find(profile => profile.id === session.profileId);
  if (known && !env) return known;
  const matching = env ? candidates.filter(profile => {
    const expected = spec(profile).env;
    const keys = new Set([...Object.keys(expected), ...Object.keys(env)].filter(key => /(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|BASE_URL)$/.test(key)));
    return [...keys].every(key => (expected[key] || '') === (env[key] || ''));
  }) : candidates;
  if (known && matching.includes(known)) return known;
  return new Set(matching.map(accountKey)).size === 1 ? matching[0] : null;
}
