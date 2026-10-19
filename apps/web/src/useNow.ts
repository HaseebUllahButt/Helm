import { useEffect, useState } from 'react';

/**
 * One clock for every "Working 42s" and "Waiting 12m" on screen. It ticks on
 * the whole second, so every counter turns over together, in one redraw,
 * instead of each row waking on its own schedule. It runs at the fastest
 * pace anyone showing asks for (a seconds counter needs 1s, a "5m ago"
 * 15s), and each user is redrawn only when its own pace turns over. The
 * clock only exists while something is subscribed.
 */
const paces = new Map<(now: number) => void, number>();
let timer: ReturnType<typeof setTimeout> | null = null;
let timerPace = 0;

function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!paces.size) return;
  timerPace = Math.min(...paces.values());
  // To the next whole step on the wall clock, not one step from now.
  timer = setTimeout(() => {
    timer = null;
    const now = Date.now();
    paces.forEach((_pace, tell) => tell(now));
    schedule();
  }, timerPace - (Date.now() % timerPace) + 5);
}

/** The time, redrawn every `ms` (on the whole step) while `active`. */
export function useNow(ms = 15_000, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const step = (t: number) => setNow((was) => (Math.floor(was / ms) === Math.floor(t / ms) ? was : t));
    // A clock switched on late must not show the time it was mounted at.
    step(Date.now());
    paces.set(step, ms);
    if (!timer || ms < timerPace) schedule();
    return () => {
      paces.delete(step);
      if (!paces.size) schedule();
    };
  }, [ms, active]);
  return now;
}

/** "3m", "1h", "just now" - short enough to sit inside a row of metadata. */
export function waitingSince(ts: number | undefined | null, now = Date.now()): string {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 45) return 'just now';
  // 45-59s is past "just now" but not yet a minute; "0m" read as a bug.
  const m = Math.max(1, Math.floor(s / 60));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
