import type { Recache } from './recache';

export const WORTH_SAYING: number;

export interface Recache {
  /** Size of the cached prefix that would have to be written again. */
  tokens: number;
  /** What writing it again costs, or null when the model has no published rate. */
  costUsd: number | null;
}

/** A turn as the session log keeps it; only the usage on its end is read. */
export interface RecacheTurn {
  done?: { usage?: { cacheRead?: number } };
}

export function cachedTokens(turns: RecacheTurn[]): number;

export function recacheCost(
  turns: RecacheTurn[],
  model: string,
  engine: string,
  asOfDate?: string,
): Recache | null;

export function recacheWarning(kind: 'model' | 'effort', r: Recache): string;
