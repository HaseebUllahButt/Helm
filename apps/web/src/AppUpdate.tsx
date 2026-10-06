import { useEffect } from 'react';
import { reloadApp } from './reload';

/** How long nobody has typed, tapped or scrolled before a reload is safe. */
const QUIET_MS = 20_000;

/**
 * A new web build reloads the page by itself, at a moment nobody will feel:
 * straight away while the page is in the background, otherwise once the
 * owner has stopped touching it and is not in the middle of typing or a
 * dialog. Drafts are saved as they are typed, so nothing is lost either way.
 */
export function AppUpdate({ reload = reloadApp, quietMs = QUIET_MS }: { reload?: () => void; quietMs?: number }) {
  useEffect(() => {
    let stopped = false;
    let checking = false;
    let ready = false;
    let lastTouch = Date.now();
    const busy = () => {
      const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
      const typing = !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable) && !!el.value;
      return typing || !!document.querySelector('[role="dialog"], [aria-modal="true"]');
    };
    const maybeReload = () => {
      if (!ready || stopped) return;
      if (document.hidden || (Date.now() - lastTouch >= quietMs && !busy())) { stopped = true; reload(); }
    };
    const check = async () => {
      if (checking || ready) return;
      checking = true;
      try {
        const response = await fetch('/api/version', { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
        if (!response.ok || stopped) return;
        const version = await response.json();
        const own = document.querySelector<HTMLScriptElement>('script[type="module"]')?.src;
        if (version?.build && own && !own.endsWith(version.build)) { ready = true; maybeReload(); }
      } catch { /* offline, or a development server without a version route */ }
      finally { checking = false; }
    };
    const touched = () => { lastTouch = Date.now(); };
    const visible = () => { if (document.visibilityState === 'visible') void check(); else maybeReload(); };
    void check();
    const touches = ['keydown', 'pointerdown', 'wheel', 'touchstart'] as const;
    touches.forEach((type) => window.addEventListener(type, touched, { passive: true, capture: true }));
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', visible);
    window.addEventListener('pageshow', visible);
    const poll = setInterval(() => { void check(); }, 60_000);
    const settle = setInterval(maybeReload, 5_000);
    return () => {
      stopped = true;
      clearInterval(poll); clearInterval(settle);
      touches.forEach((type) => window.removeEventListener(type, touched, { capture: true }));
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('online', visible);
      window.removeEventListener('pageshow', visible);
    };
  }, [reload, quietMs]);
  return null;
}
