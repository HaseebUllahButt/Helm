/**
 * How much of an account's rate limits is used, for the line beside the
 * chips: "5h 9% · 7d 40%", the way Claude Code's own status line says it.
 *
 * The numbers are what the CLI itself reported during a chat - Claude's
 * `rate_limit_event`, Codex's `account/rateLimits/updated` - so they cost
 * nothing to get. They are remembered per account, so a new chat on the same
 * account shows them before its first reply.
 */

import type { LimitWindow } from '@helm/protocol/limits';
export type { LimitWindow } from '@helm/protocol/limits';
export { limitWindows } from '@helm/protocol/limits';

/** An expired reading says nothing about usage in the new window. */
export function current(windows: LimitWindow[], now = Date.now()): LimitWindow[] {
  return windows.filter((w) => !w.resetsAt || w.resetsAt * 1000 > now);
}

const KEY = 'helm.limits.v1';
type Store = Record<string, { windows: LimitWindow[]; at: number }>;

const read = (): Store => {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') ?? {}; } catch { return {}; }
};

/** What an account last reported, from any chat on it. */
export function rememberedLimits(account: string): LimitWindow[] {
  return read()[account]?.windows ?? [];
}

export function rememberLimits(account: string, windows: LimitWindow[]) {
  if (!windows.length) return;
  const store = read();
  store[account] = { windows, at: Date.now() };
  try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* storage full or off: shown, not kept */ }
}

/**
 * "resets in 2h 3m, at 3:20 PM", "resets in 1d 16h, Sun 3:00 AM",
 * "resets Wed 3:00 AM": how long to wait and the clock time, so neither has
 * to be worked out from the other.
 */
export function resetPhrase(resetsAt?: number, now = Date.now()) {
  if (!resetsAt) return '';
  const at = resetsAt * 1000;
  const left = at - now;
  if (left <= 0) return 'resets now';
  const when = new Date(at);
  const today = when.toDateString() === new Date(now).toDateString();
  const clock = when.toLocaleString(undefined, today ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const minutes = Math.round(left / 60_000);
  if (minutes >= 48 * 60) return `resets ${clock}`;
  const d = Math.floor(minutes / 1440), h = Math.floor(minutes / 60) % 24, m = minutes % 60;
  const wait = d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  return `resets in ${wait}, ${today ? 'at ' : ''}${clock}`;
}
