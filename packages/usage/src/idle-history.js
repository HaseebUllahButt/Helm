/**
 * When a message to an idle Claude chat re-reads a big history at full price.
 *
 * Claude keeps a conversation in its prompt cache for a while after each
 * request: an hour on a subscription, five minutes on an API key (Claude
 * says which in each reply's `cache_creation` counts). After that the next
 * message sends the whole history again and writes it to the cache again.
 * On 2026-11-10 one message to an old chat re-read 510k tokens that way.
 *
 * T3 Code's answer, copied here: past 200k tokens and past the cache time,
 * a send becomes "Compact and send" - Claude shortens the history first -
 * with "Send with full history" one tap away. 200k is also Claude Code's own
 * idle-compaction size.
 *
 * Claude Code has the same question built in (`resume_return`), but it is
 * behind Anthropic's own feature flags and a 70-minute wait, so Helm does
 * not rely on it.
 *
 * Shared by the daemon (what a send does) and the app (what the send button
 * says), so the two cannot disagree.
 */

/** Below this, a cold re-read costs little and a choice would be noise. */
export const BIG_HISTORY = 200_000;

/** Claude's cache time when no reply has said: the subscription default. */
export const DEFAULT_CACHE_TTL = 60 * 60_000;

/** The cache time one reply's usage shows, or undefined when it wrote nothing. */
export function cacheTtlOf(usage) {
  const c = usage?.cache_creation;
  if (!c) return undefined;
  if (c.ephemeral_1h_input_tokens > 0) return 60 * 60_000;
  if (c.ephemeral_5m_input_tokens > 0) return 5 * 60_000;
  return undefined;
}

/**
 * The cold big history a send to this chat would re-read, or null.
 * `chat` is a session record: `engine`, `status`, `context` (`used`, `at`,
 * `ttl`, `compacted`). A chat that works or waits on a prompt is not idle,
 * and its cache is warm anyway.
 */
export function staleHistory(chat, now = Date.now()) {
  if (chat?.engine !== 'claude') return null;
  if (chat.status === 'working' || chat.status === 'blocked') return null;
  const c = chat.context;
  if (!c || c.compacted || !(c.used >= BIG_HISTORY) || !(c.at > 0)) return null;
  const idleMs = now - c.at;
  if (idleMs < (c.ttl > 0 ? c.ttl : DEFAULT_CACHE_TTL)) return null;
  return { tokens: c.used, idleMs };
}

/** `512k`, `1.2M`: the size the send button and notes show. */
export const historySize = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`);
