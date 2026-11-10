import { balance } from '@helm/protocol/balance';
import type { Account } from './accounts';
import type { LimitWindow } from './session/limits';

/** One account as `usage.limits` reports it: enough to find its windows. */
export interface LimitReading { engine: string; aliases: string[]; windows: LimitWindow[] }

/** The limit windows of a picker account, matched by any alias they share. */
export function windowsOf(account: Account, readings: LimitReading[] = []): LimitWindow[] {
  const ids = new Set([account.profile.id, ...account.aliases]);
  return readings.find((r) => r.engine === account.engine && r.aliases.some((id) => ids.has(id)))?.windows ?? [];
}

export interface Balanced {
  /** The account new work goes to. */
  account: Account;
  /** The usual account, when it is out of limit and work moved off it. */
  from?: Account;
  /** When the usual account is out: when it can work again (Unix seconds), or null. */
  until?: number | null;
}

/**
 * The limit balancer for a new chat (protocol/balance.js): the usual
 * account, unless it is out of limit and another account of the same tool
 * has limit left. Only for a choice nobody made by hand.
 */
export function balanced(accounts: Account[], usual: Account, readings: LimitReading[] = [], now = Date.now()): Balanced {
  const pool = accounts.map((a) => ({ key: a.key, engine: a.engine, windows: windowsOf(a, readings) }));
  const result = balance(pool, usual.key, now);
  if (!result.switched) return { account: usual, ...(result.until !== undefined ? { until: result.until } : {}) };
  return { account: accounts.find((a) => a.key === result.key) ?? usual, from: usual, until: result.until ?? null };
}
