import { useEffect, useRef } from 'react';

/**
 * An interval that pauses while the page is hidden and catches up the
 * moment it comes back.
 *
 * Every poll in the app - session lists, transcripts, a machine's last
 * word - used to keep asking while the phone sat in a pocket with the
 * screen off, on a metered connection that did not care nobody was
 * looking. A hidden tab needs no fresher answer than the one it has, and
 * on wake the first tick comes immediately rather than up to `ms` late.
 * `ms` of null means do not poll at all.
 */
export function useLiveInterval(ms: number | null, fn: () => void, deps: readonly unknown[] = []) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms == null) return;
    const tick = () => { if (!document.hidden) ref.current(); };
    const timer = setInterval(tick, ms);
    const wake = () => { if (!document.hidden) ref.current(); };
    document.addEventListener('visibilitychange', wake);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', wake); };
    // The callback is read through a ref; deps are the caller's own
    // interests, like any other effect. A new pace, or none, starts over.
  }, [ms, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
}
