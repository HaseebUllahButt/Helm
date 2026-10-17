import { useEffect, useRef } from 'react';
import type { Client } from './client';
import type { MainView } from './App';

export function useViewingReport(client: Client, view: MainView, selected: string | null) {
  /**
   * Which session this window is looking at, told to the service worker so
   * a push about it stays silent: the sheet already on screen is the
   * notification. Posted on every navigation, including the one back to a
   * list - "looking at nothing" is real information.
   */
  useEffect(() => {
    navigator.serviceWorker?.controller?.postMessage({
      type: 'helm:viewing',
      envId: view?.kind === 'session' ? selected : null,
      sessionId: view?.kind === 'session' ? view.session.id : null,
    });
  }, [view, selected]);

  /**
   * The same, told to this computer's own hub, which shows desktop
   * notifications itself (desktop-notify.js) - and which answers this
   * request with a chat to open when one of them is clicked.
   */
  const viewingNow = useRef<{ envId: string | null; sessionId: string | null }>({ envId: null, sessionId: null });
  const desktopNudge = useRef<() => void>(() => {});
  useEffect(() => {
    viewingNow.current = {
      envId: view?.kind === 'session' ? selected : null,
      sessionId: view?.kind === 'session' ? view.session.id : null,
    };
    desktopNudge.current();
  }, [view, selected]);
  useEffect(() => {
    if (!/^(127(?:\.\d{1,3}){3}|localhost|\[::1\])$/.test(location.hostname)) return;
    const windowId = Math.random().toString(36).slice(2, 10);
    let stopped = false;
    let abort: AbortController | null = null;
    const nudge = () => abort?.abort();
    desktopNudge.current = nudge;
    const loop = async () => {
      let failures = 0;
      while (!stopped) {
        abort = new AbortController();
        try {
          const { open } = await client.desktopWait({
            window: windowId,
            focused: document.visibilityState === 'visible' && document.hasFocus(),
            ...viewingNow.current,
          }, abort.signal);
          failures = 0;
          if (open?.envId && open.sessionId) {
            window.dispatchEvent(new MessageEvent('helm:open', { data: { type: 'helm:open', ...open } }));
          }
        } catch {
          if (stopped) return;
          if (abort.signal.aborted) continue;
          // A hub without this, or one restarting: back off and try again.
          failures += 1;
          await new Promise((r) => setTimeout(r, Math.min(60_000, 2000 * failures)));
        }
      }
    };
    loop();
    window.addEventListener('focus', nudge);
    window.addEventListener('blur', nudge);
    document.addEventListener('visibilitychange', nudge);
    return () => {
      stopped = true;
      abort?.abort();
      desktopNudge.current = () => {};
      window.removeEventListener('focus', nudge);
      window.removeEventListener('blur', nudge);
      document.removeEventListener('visibilitychange', nudge);
    };
  }, [client]);
}
