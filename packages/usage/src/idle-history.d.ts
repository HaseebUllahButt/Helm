export const BIG_HISTORY: number;
export const DEFAULT_CACHE_TTL: number;
export function cacheTtlOf(usage: { cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } } | null | undefined): number | undefined;
export interface StaleHistory {
  /** How big the history is. */
  tokens: number;
  /** How long since the chat's last request to Claude. */
  idleMs: number;
}
export function staleHistory(
  chat: { engine?: string; status?: string; context?: { used?: number; at?: number; ttl?: number; compacted?: boolean } } | null | undefined,
  now?: number,
): StaleHistory | null;
export function historySize(n: number): string;
