/**
 * Types for the rate tables, so the app and the daemon price from one source.
 *
 * The web app needs `cacheRatesFor` to say what a mid-thread model switch
 * costs; duplicating a rate table into the bundle to get it would guarantee
 * the two drift, and the one in the bundle would be the one nobody updates.
 */

export interface Rates {
  /** $ per million fresh input tokens. */
  input: number;
  /** $ per million tokens read back out of the prompt cache. */
  cacheRead: number;
  /** $ per million tokens written to the cache - above the fresh rate. */
  cacheWrite: number;
}

export interface Cost {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  total: number;
}

export interface Tokens {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * Per-million rates for one model on a given day, or null when the model has
 * no published rate - which is reported as unpriced rather than as zero.
 *
 * `asOfDate` is an ISO date (YYYY-MM-DD) because rates move: Sonnet 5 had
 * introductory pricing until 2026-09-01, and Codex re-cut its card on
 * 2026-07-30.
 */
export function cacheRatesFor(
  modelName: string,
  engine: string,
  asOfDate?: string,
): Rates | null;

/** Cost of one bucket of raw token counts, or null if the model is unpriced. */
export function priceBucket(
  engine: string,
  modelName: string,
  tokens: Tokens,
  date: string,
): Cost | null;

/** Claude's own rate card for a model on a day, or null. */
export function claudeRatesFor(
  modelName: string,
  asOfDate: string,
): { input: number; output: number; cacheWrite: number; cacheRead: number } | null;

/** Which company bills for a model, inferred from its name. */
export function providerOf(modelName: string): string;
