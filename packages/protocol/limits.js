/** Normalize provider reports without treating missing values as zero usage. */
const name = minutes => {
  if (minutes >= 10080 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
};
const percent = (n, scale = 1) => typeof n === 'number' && Number.isFinite(n) && n >= 0
  ? Math.max(0, Math.min(100, Math.round(n * scale * 10) / 10)) : null;
const reset = n => typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;

export function limitWindows(limits) {
  const out = [];
  const claude = limits?.claude;
  if (claude) {
    const windows = claude.unifiedWindows ?? {};
    for (const [key, label] of [['five_hour', '5h'], ['seven_day', '7d']]) {
      const used = percent(windows[key]?.utilization, 100);
      if (used !== null) out.push({ label, used, resetsAt: reset(windows[key]?.resetsAt) });
    }
    // Older CLIs report only the window nearest its limit.
    if (!out.length) {
      const used = percent(claude.utilization, 100);
      const label = claude.rateLimitType === 'seven_day' ? '7d'
        : claude.rateLimitType === 'five_hour' ? '5h' : (claude.rateLimitType || 'usage');
      if (used !== null) out.push({ label, used, resetsAt: reset(claude.resetsAt) });
    }
  }
  const codex = limits?.codex;
  if (codex) {
    for (const w of [codex.primary, codex.secondary]) {
      const used = percent(w?.usedPercent);
      if (used === null || !Number.isFinite(w?.windowDurationMins) || w.windowDurationMins <= 0) continue;
      // Separate model-specific allowances from the general Codex allowance.
      const prefix = codex.limitId && codex.limitId !== 'codex' ? `${codex.limitId} ` : '';
      out.push({ label: prefix + name(w.windowDurationMins), used, resetsAt: reset(w.resetsAt) });
    }
  }
  return out;
}
