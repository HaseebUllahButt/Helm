import { materialize } from './profiles.js';
import { accountKey } from './settings.js';
import { expand } from './paths.js';

const AUTH_KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'];

/** A shared config folder can hold several logins; never save defaults to the first alias by accident. */
export function nativeClaudeAccount(session, profiles, { env = null, spec = materialize } = {}) {
  const candidates = profiles.filter(profile => profile.engine === 'claude'
    && expand(profile.env?.CLAUDE_CONFIG_DIR || '~/.claude') === expand(session.nativeHome || '~/.claude'));
  const known = candidates.find(profile => profile.id === session.profileId);
  if (known) return known;
  const matching = env ? candidates.filter(profile => {
    const expected = spec(profile).env;
    return AUTH_KEYS.every(key => (expected[key] || '') === (env[key] || ''));
  }) : candidates;
  return new Set(matching.map(accountKey)).size === 1 ? matching[0] : null;
}
