import { useEffect, useState } from 'react';

/** Announce a new web build without replacing a conversation or its draft. */
export function AppUpdate({ reload = () => location.reload() }: { reload?: () => void }) {
  const [available, setAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    let stopped = false;
    const check = async () => {
      try {
        const response = await fetch('/api/version', { cache: 'no-store' });
        if (!response.ok || stopped) return;
        const version = await response.json();
        const own = document.querySelector<HTMLScriptElement>('script[type="module"]')?.src;
        if (!stopped && version?.build && own && !own.endsWith(version.build)) setAvailable(true);
      } catch { /* offline, or a development server without a version route */ }
    };
    void check();
    const visible = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', visible);
    return () => { stopped = true; document.removeEventListener('visibilitychange', visible); };
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
