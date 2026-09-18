import { useEffect, useState } from 'react';

/**
 * "Waiting 12m" ages while you look at it. A shared ticker so a row and a
 * sheet asking the same question do not each run their own clock - the
 * interval only exists while something is subscribed, and re-renders are
 * once a tick rather than once a frame.
 */
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    listeners.add(tick);
    timer ??= setInterval(() => listeners.forEach((fn) => fn()), ms);
    return () => {
      listeners.delete(tick);
      if (!listeners.size && timer) { clearInterval(timer); timer = null; }
    };
  }, [ms]);
  return now;
}

/** "3m", "1h", "just now" - short enough to sit inside a row of metadata. */
export function waitingSince(ts: number | undefined | null, now = Date.now()): string {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
