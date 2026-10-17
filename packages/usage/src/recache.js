import { cacheRatesFor } from './pricing.js';

/**
 * What changing the model or the thinking level mid-conversation throws away.
 *
 * The provider's prompt cache is a prefix match, and two of the chips in the
 * composer break that prefix: switching model moves to a different cache
 * namespace entirely (caches are model-scoped, with no escape hatch), and
 * changing effort invalidates the messages cache on every model. Either way
 * the whole conversation is written to cache again on the next turn, at the
 * write rate - which on Claude is 1.25x the fresh-input rate.
 *
 * On a short thread that is nothing. On a long one it is the largest single
 * thing a tap can cost, and it happens silently: the turn just comes back more
 * expensive. So the tap says so first.
 *
 * Whether a change breaks the cache is the CLI's to say, not Helm's guess.
 * A model switch always does (caches belong to one model). A thinking-level
 * change does not on Claude Opus 5.5 and its peers when the CLI sends effort
 * inside the conversation; Claude says so in its start-up message
 * (`per_turn_effort_active`), and the app warns only when it says false.
 *
 * A model switch is priced by Claude itself where it can be: Claude Code
 * runs a PreModelSwitch hook before a switch, saying whether its cache is
 * still warm and what writing it again costs (Helm's Claude driver and its
 * terminal chats both listen). The estimate below is only for chats where
 * no CLI says anything - Codex, the ACP agents, an older Claude, or a
 * Claude chat whose process is not running.
 *
 * Measured across this owner's whole history, mid-thread switches accounted
 * for about 0.53M cache-write tokens - real, but small. This exists to keep it
 * small on the thread where it would not be.
 *
 * Lives here rather than in the app so the daemon's rate table and the
 * sentence the app shows cannot drift, and so this is testable without a
 * browser.
 */

/**
 * Below this, re-caching costs a cent or two and a confirmation would be
 * noise - and a dialog people dismiss without reading is worse than none.
 * A quarter of a million tokens at Opus write rates is about $1.50.
 */
export const WORTH_SAYING = 250_000;

/** The size of the cached prefix, from the most recent turn that reported one. */
export function cachedTokens(turns = []) {
  for (let i = turns.length - 1; i >= 0; i--) {
    const u = turns[i]?.done?.usage;
    if (u?.cacheRead) return u.cacheRead;
  }
  return 0;
}

/**
 * What a switch would cost on this thread, or null when it is not worth
 * saying. A model with no published rate gives a token figure and no dollar
 * figure, rather than an invented one.
 */
export function recacheCost(turns, model, engine, asOfDate = new Date().toISOString().slice(0, 10), size) {
  // The size the CLI reports for the conversation now beats the last turn's
  // cache reads: those are summed over every request in the turn, and they
  // still show the old size after a compaction.
  const tokens = typeof size === 'number' ? size : cachedTokens(turns);
  if (tokens < WORTH_SAYING) return null;
  const rates = cacheRatesFor(model, engine, asOfDate);
  return { tokens, costUsd: rates ? (tokens * rates.cacheWrite) / 1e6 : null };
}

const fmtTokens = (n) =>
  (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);

/**
 * The sentence the confirmation asks: what happens, then what it costs.
 * `fromCli` is a model switch Claude itself priced (its PreModelSwitch hook):
 * it said the cache is still warm, and `r` holds its figures, not Helm's.
 */
export function recacheWarning(kind, r, fromCli = false) {
  const what = fromCli
    ? "Claude says this conversation's prompt cache is still warm, and switching model starts it again."
    : kind === 'model'
      ? "Switching model starts this conversation's prompt cache again - caches belong to one model."
      : "The agent says changing the thinking level now rewrites this conversation's prompt cache.";
  const price = r.costUsd == null
    ? `About ${fmtTokens(r.tokens)} cached tokens would be written again (this model has no published rate, so the cost is not known).`
    : `About ${fmtTokens(r.tokens)} cached tokens would be written again, roughly $${r.costUsd.toFixed(2)} on the next turn.`;
  return `${what}\n\n${price}\n\nContinue?`;
}
