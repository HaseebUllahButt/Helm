import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { Client, Environment, Session } from '../client';
import { SideDock, readLocal as read, writeLocal as write } from './SideDock';

const BrowserPanel = lazy(() => import('./BrowserPanel'));
const WIDTH_KEY = 'helm.browser-dock-width';
const openKey = (env: string, session: string) => `helm.browser-dock.${env}:${session}`;

/** Ctrl/Cmd+Shift+B. Chrome hands it to the page first (only Ctrl+N/T/W style keys never arrive). */
export function isDockKey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'> & { isComposing?: boolean }) {
  return (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && !e.isComposing && e.key.toLowerCase() === 'b';
}

/** At a computer, the browser is the Chromium window itself, not a panel. */
const atComputer = () => matchMedia('(pointer: fine)').matches;

/**
 * The chat's browser. At a computer, Ctrl/Cmd+Shift+B and the Browser button
 * bring up the chat's Chromium window and nothing opens in Helm; only when the
 * chat's machine has no screen does the panel open instead. On a phone the
 * panel is the browser, remembered open per chat on this device. The agent
 * opening a tab puts a dot on the Browser button; on a wide touch screen it
 * opens the panel instead, once per tab, unless the owner closed it here.
 */
export function useBrowserDock(client: Client, env: Environment, session: Session, enabled = true) {
  const key = openKey(env.id, session.id);
  const [open, setOpenState] = useState(() => read(key) === '1' && !atComputer()), [dot, setDot] = useState(false);
  const isOpen = useRef(open); isOpen.current = open;
  const seen = useRef(new Set<string>());
  const setPanel = useCallback((next: boolean) => { isOpen.current = next; setOpenState(next); write(key, next ? '1' : '0'); if (next) setDot(false); }, [key]);
  const setOpen = useCallback((next: boolean) => {
    if (!next || isOpen.current || !atComputer()) { setPanel(next); return; }
    setDot(false);
    // No screen on the chat's machine (or Chromium would not start): the panel says so.
    client.rpc(env.id, 'browser.show', { id: session.id }, 60000).catch(() => setPanel(true));
  }, [client, env.id, session.id, setPanel]);
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isDockKey(e) || (e.target as HTMLElement | null)?.closest?.('.xterm')) return;
      // Stops Chrome toggling its bookmarks bar.
      e.preventDefault();
      if (e.repeat) return;
      const modal = [...document.querySelectorAll('[aria-modal="true"]')].at(-1);
      if (modal && !modal.matches('.side-dock')) return;
      setOpen(!isOpen.current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, setOpen]);
  useEffect(() => client.on((id, kind, payload: any) => {
    if (!enabled || id !== env.id || kind !== 'browser.tab' || payload?.id !== session.id || payload.viewer || seen.current.has(payload.tabId)) return;
    seen.current.add(payload.tabId);
    if (isOpen.current) return;
    if (matchMedia('(min-width: 1000px)').matches && !atComputer() && read(key) !== '0') setPanel(true); else setDot(true);
  }), [enabled, client, env.id, session.id, key, setPanel]);
  return { open, dot, setOpen, toggle: () => setOpen(!isOpen.current) };
}

/** The browser beside the chat on a wide screen, the whole screen on a phone. */
export function BrowserDock({ client, env, session, onClose }: { client: Client; env: Environment; session: Session; onClose: () => void }) {
  return <SideDock label="Browser" widthKey={WIDTH_KEY} className="browser-dock" onClose={onClose}>
    <Suspense fallback={<p className="note browser-dock-loading">Opening browser…</p>}><BrowserPanel client={client} env={env} session={session} onClose={onClose} /></Suspense>
  </SideDock>;
}
