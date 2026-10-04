import { useEffect, useState } from 'react';
import { reloadApp } from './reload';

/** Announce a new web build without replacing a conversation or its draft. */
export function AppUpdate({ reload = reloadApp }: { reload?: () => void }) {
  const [available, setAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    let stopped = false;
    let checking = false;
    const check = async () => {
      if (checking || document.hidden) return;
      checking = true;
      try {
        const response = await fetch('/api/version', { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
        if (!response.ok || stopped) return;
        const version = await response.json();
        const own = document.querySelector<HTMLScriptElement>('script[type="module"]')?.src;
        if (!stopped && version?.build && own && !own.endsWith(version.build)) setAvailable(true);
      } catch { /* offline, or a development server without a version route */ }
      finally { checking = false; }
    };
    void check();
    const visible = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', visible);
    window.addEventListener('pageshow', visible);
    const timer = setInterval(visible, 60_000);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('online', visible);
      window.removeEventListener('pageshow', visible);
    };
  }, []);
  if (!available || dismissed) return null;
  return (
    <div className="app-update" role="status">
      <span>Helm update ready</span>
      <button className="linkish" onClick={reload}>Reload</button>
      <button className="linkish" onClick={() => setDismissed(true)}>Later</button>
    </div>
  );
}
