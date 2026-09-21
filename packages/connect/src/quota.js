/**
 * The shared pieces of the quota cards Codex and Devin put behind /status
 * and /usage: a monospace progress bar filled by the percent consumed, and
 * the "resets …" phrasing both CLIs use - relative when it is near ("in
 * 20h 23m", the daily line), absolute with the local offset when it is far
 * ("Sep 27, 1:00 PM (UTC+5)", the weekly one).
 */

const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A `███░░░` code-span bar, filled to the percent *used*. */
export const quotaBar = (usedPercent, width = 20) => {
  const pct = Math.min(100, Math.max(0, Number(usedPercent) || 0));
  const filled = Math.round((pct * width) / 100);
  return `\`${'█'.repeat(filled)}${'░'.repeat(width - filled)}\``;
};

/** '' when there is no reset time; otherwise how it should be said. */
export function formatReset(unixSeconds, now = Date.now()) {
  const at = Number(unixSeconds);
  if (!Number.isFinite(at) || at <= 0) return '';
  const left = at * 1000 - now;
  if (left <= 0) return 'soon';
  const minutes = Math.floor(left / 60_000);
  if (minutes < 48 * 60) {
    const h = Math.floor(minutes / 60), m = minutes % 60;
    return h ? `in ${h}h ${m}m` : `in ${m}m`;
  }
  const d = new Date(at * 1000);
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const tz = `UTC${sign}${abs % 60 === 0 ? abs / 60 : `${Math.floor(abs / 60)}:${pad(abs % 60)}`}`;
  const hour = d.getHours() % 12 || 12;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${hour}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'} (${tz})`;
}

/**
 * A name for a Codex rate-limit window: the 300-minute bucket is the "5h
 * limit" and the 10080-minute one the "Weekly limit", the way Codex's own
 * status card names them.
 */
export function windowLabel(window, fallback = 'Limit') {
  const mins = Number(window?.windowDurationMins ?? window?.window_minutes);
  if (!Number.isFinite(mins) || mins <= 0) return fallback;
  if (mins % 10080 === 0) return 'Weekly limit';
  if (mins % 1440 === 0) return `${mins / 1440}d limit`;
  if (mins % 60 === 0) return `${mins / 60}h limit`;
  return `${mins}m limit`;
}

const PLAN_NAMES = {
  free: 'Free', prolite: 'Pro Lite', pro: 'Pro', plus: 'Plus',
  team: 'Team', business: 'Business', edu: 'Edu', enterprise: 'Enterprise',
};

/** Codex planType values arrive lowercase; the card prints them like the TUI. */
export const planName = (value) =>
  PLAN_NAMES[String(value ?? '').toLowerCase()]
  ?? (value ? String(value).replace(/^\w/, (c) => c.toUpperCase()) : null);
