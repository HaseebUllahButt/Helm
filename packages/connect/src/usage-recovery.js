import { limitWindows } from '@helm/protocol/limits';

// Only absolute provider timestamps are safe to restore across time zones/restarts.
export function resetTimestamp(value) {
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) {
    if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
    value = Date.parse(value);
  } else value = Number(value);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value < 100_000_000_000 ? value * 1000 : value;
}
export function isUsageLimit(event) {
  return /rate.?limit|usage.?limit|quota|too many requests|\b429\b|(?:you(?:'ve| have)? (?:hit|reached) (?:your )?limit)/i.test([event.error, event.message, event.errorCode, event.errorKind].filter(Boolean).join(' '));
}
export function mergeUsageLimits(previous, event) {
  const normalize = value => Array.isArray(value) ? value : limitWindows(value || {});
  const windows = new Map(normalize(previous).map(w => [w.label, w]));
  for (const w of normalize(event)) windows.set(w.label, { ...w, resetsAt: resetTimestamp(w.resetsAt) });
  if (event.claude?.status === 'rejected' && !normalize(event).length) windows.set(event.claude.rateLimitType || 'usage',
    { label: event.claude.rateLimitType || 'usage', used: 100, resetsAt: resetTimestamp(event.claude.resetsAt) });
  return [...windows.values()].slice(-16);
}
export function usageResetAt(event, limits, failedAt = Date.now()) {
  const explicit = resetTimestamp(event.usageLimitResetAt ?? event.resetAt ?? event.resetsAt);
  const epoch = /\|(\d{10})\b/.exec(event.error || event.message || '');
  const iso = /\b(\d{4}-\d\d-\d\dT[^\s|]+(?:Z|[+-]\d\d:\d\d))/.exec(event.error || event.message || '');
  const reported = explicit ?? (epoch ? Number(epoch[1]) * 1000 : iso ? resetTimestamp(iso[1]) : null);
  if (reported != null && reported <= failedAt) return null;
  const exhausted = (Array.isArray(limits) ? limits : limitWindows(limits || {})).filter(w => w.used >= 100);
  const windows = exhausted.map(w => resetTimestamp(w.resetsAt));
  if (!reported && windows.some(at => at == null)) return null;
  const candidates = [reported, ...windows].filter(at => at > failedAt);
  const at = candidates.length ? Math.max(...candidates) : null;
  // A past reset or far-off malformed epoch must never cause a retry loop.
  return at > failedAt && at <= failedAt + 366 * 86400000 ? at : null;
}
export function recoveryDue(session, now) {
  const r = session.recovery;
  return !!(session.autoResumeLimited && r?.kind === 'limited' && r.resetAt > r.at && r.resetAt <= now
    && !r.autoResumeError && !r.autoResumeCancelled && !session.archived && !session.stoppedAt && !session.external && session.driver);
}
