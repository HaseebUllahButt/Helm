/**
 * How much of an account's rate limits is used, for the line beside the
 * chips: "5h 9% · 7d 40%", the way Claude Code's own status line says it.
 *
 * The numbers are what the CLI itself reported during a chat - Claude's
 * `rate_limit_event`, Codex's `account/rateLimits/updated` - so they cost
 * nothing to get. They are remembered per account, so a new chat on the same
 * account shows them before its first reply.
 */

export interface LimitWindow {
  /** "5h", "7d" - what the window is called in the status line. */
  label: string;
  /** Percent used, 0-100. */
  used: number;
  /** Unix seconds when it starts over, if known. */
  resetsAt?: number;
}

const name = (minutes: number) => {
  if (minutes >= 10_080 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
};

const pct = (n: unknown, scale = 1) => {
  const v = Number(n) * scale;
  return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null;
};

/** The windows a session's `limits` state describes, shortest first. */
export function limitWindows(limits: any): LimitWindow[] {
  const out: LimitWindow[] = [];
  const claude = limits?.claude;
  if (claude) {
    const windows = claude.unifiedWindows ?? {};
    for (const [key, label] of [['five_hour', '5h'], ['seven_day', '7d']] as const) {
      const used = pct(windows[key]?.utilization, 100);
      if (used !== null) out.push({ label, used, resetsAt: Number(windows[key]?.resetsAt) || undefined });
    }
    // Older CLIs name only the window that is closest to running out.
    if (!out.length && claude.utilization !== undefined) {
      const used = pct(claude.utilization, 100);
      const label = claude.rateLimitType === 'seven_day' ? '7d' : '5h';
      if (used !== null) out.push({ label, used, resetsAt: Number(claude.resetsAt) || undefined });
    }
  }
  const codex = limits?.codex;
  if (codex) {
    for (const w of [codex.primary, codex.secondary]) {
      const used = pct(w?.usedPercent);
      if (used === null || !w?.windowDurationMins) continue;
      out.push({ label: name(Number(w.windowDurationMins)), used, resetsAt: Number(w.resetsAt) || undefined });
    }
  }
  return out;
}

/** A window that has started over is at nothing, whatever was last heard. */
export function current(windows: LimitWindow[], now = Date.now()): LimitWindow[] {
  return windows.map((w) => (w.resetsAt && w.resetsAt * 1000 <= now ? { ...w, used: 0, resetsAt: undefined } : w));
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

/** "resets in 2h 3m", "resets Fri 9:00" - for the tooltip. */
export function resetPhrase(resetsAt?: number, now = Date.now()) {
  if (!resetsAt) return '';
  const left = resetsAt * 1000 - now;
  if (left <= 0) return 'resets now';
  const minutes = Math.round(left / 60_000);
  if (minutes < 48 * 60) {
    const h = Math.floor(minutes / 60), m = minutes % 60;
    return `resets in ${h ? `${h}h ${m}m` : `${m}m`}`;
  }
  return `resets ${new Date(resetsAt * 1000).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}
