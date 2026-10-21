import { openPrivateLink } from '../privateLink';
import { useEffect, useState } from 'react';
import { Client } from '../client';

/**
 * `#share=<name>&host=<host>&next=<path>`: a private link sent this browser
 * here to sign in (see apps/relay/src/share.js). Nothing secret is in it.
 */
type ShareHopTarget = { name: string; host: string; next: string };

export function shareHopTarget(): ShareHopTarget | null {
  const p = new URLSearchParams(location.hash.replace(/^#\/?/, ''));
  const name = p.get('share'), host = p.get('host');
  return name && host ? { name, host, next: p.get('next') || '/' } : null;
}

/**
 * Signed in, on the way to a private link: get a pass and go. The hub that
 * served this page is asked first - it built the way here, so it knows how -
 * and this device's own hub after it.
 */
export function ShareHop({ client, target, onDone }: { client: Client; target: ShareHopTarget; onDone: () => void }) {
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const failures: string[] = [];
      // Three rounds a second apart: the first visit once came back refused
      // and the very next one went through, so one answer is not the last word.
      for (let round = 0; round < 3 && !cancelled; round++) {
        if (round) await new Promise((r) => setTimeout(r, 1000));
        for (const base of [location.origin, undefined]) {
          try {
            const pass = await client.shareGrant(target, base);
            if (cancelled) return;
            // Back from the link should land in Helm, not bounce out again.
            history.replaceState(null, '', location.pathname + location.search);
            openPrivateLink(pass);
            return;
          } catch (err: any) {
            failures.push(`${base ? new URL(base).host : 'this device’s Helm home'}: ${err?.message || 'no answer'}`);
          }
        }
      }
      if (!cancelled) setError([...new Set(failures)].join('; ') || 'Helm cannot open the link.');
    })();
    return () => { cancelled = true; };
  }, [client, target]);
  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <img src="/icon.svg" alt="" />
          <h1>helm</h1>
          <p>{error ? `Helm cannot open ${target.name}: ${error}` : `Opening ${target.name}…`}</p>
        </div>
        {error && <button className="primary" onClick={onDone}>Open Helm</button>}
      </div>
    </div>
  );
}
