import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Client, Environment, Session } from '../client';

const BrowserPanel = lazy(() => import('./BrowserPanel'));
const WIDTH_KEY = 'helm.browser-dock-width';
const MIN = 360, CHAT_MIN = 380;
const WIDE = '(min-width: 1000px)';

const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };
const openKey = (env: string, session: string) => `helm.browser-dock.${env}:${session}`;
const fit = (width: number, room: number) => Math.round(Math.max(MIN, Math.min(width, room - CHAT_MIN)));

/** Ctrl/Cmd+Shift+B. Chrome hands it to the page first (only Ctrl+N/T/W style keys never arrive). */
export function isDockKey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'> & { isComposing?: boolean }) {
  return (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && !e.isComposing && e.key.toLowerCase() === 'b';
}

function useWide() {
  const [wide, setWide] = useState(() => matchMedia(WIDE).matches);
  useEffect(() => { const query = matchMedia(WIDE), on = () => setWide(query.matches); query.addEventListener('change', on); return () => query.removeEventListener('change', on); }, []);
  return wide;
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
      if (modal && !modal.matches('.browser-dock')) return;
      setOpen(!isOpen.current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, setOpen]);
  useEffect(() => client.on((id, kind, payload: any) => {
    if (!enabled || id !== env.id || kind !== 'browser.tab' || payload?.id !== session.id || payload.viewer || seen.current.has(payload.tabId)) return;
    seen.current.add(payload.tabId);
    if (isOpen.current) return;
    if (matchMedia(WIDE).matches && !atComputer() && read(key) !== '0') setPanel(true); else setDot(true);
  }), [enabled, client, env.id, session.id, key, setPanel]);
  return { open, dot, setOpen, toggle: () => setOpen(!isOpen.current) };
}

/** The browser beside the chat on a wide screen, the whole screen on a phone. */
export function BrowserDock({ client, env, session, onClose }: { client: Client; env: Environment; session: Session; onClose: () => void }) {
  const wide = useWide();
  const box = useRef<HTMLElement>(null), close = useRef(onClose); close.current = onClose;
  const [width, setWidth] = useState(() => Number(read(WIDTH_KEY)) || 0);
  // On a phone it is a sheet over the chat: Escape closes it. Focus goes to
  // the sheet, not its address bar, so no keyboard pops up.
  useEffect(() => {
    const sheet = box.current;
    if (wide || !sheet) return;
    sheet.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && [...document.querySelectorAll('[aria-modal="true"]')].at(-1) === sheet && !(e.target as HTMLElement).closest?.('.browser-screen')) { e.preventDefault(); close.current(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [wide]);
  // The chat makes room through its own padding; the dock sits in that gap.
  useLayoutEffect(() => {
    const main = box.current?.parentElement;
    if (!wide || !main) return;
    const apply = () => main.style.setProperty('--browser-dock-w', `${fit(width || main.clientWidth * 0.45, main.clientWidth)}px`);
    apply(); main.classList.add('with-browser-dock');
    const observer = new ResizeObserver(apply); observer.observe(main);
    return () => { observer.disconnect(); main.classList.remove('with-browser-dock'); main.style.removeProperty('--browser-dock-w'); };
  }, [wide, width]);
  const resize = (next: number) => { const main = box.current?.parentElement; if (!main) return; const w = fit(next, main.clientWidth); main.style.setProperty('--browser-dock-w', `${w}px`); return w; };
  const save = (w?: number) => { if (!w) return; setWidth(w); write(WIDTH_KEY, String(w)); };
  const current = () => box.current?.getBoundingClientRect().width || 0;
  return <aside ref={box} className={`browser-dock ${wide ? 'browser-dock-side' : 'browser-dock-full'}`} aria-label="Browser" {...(wide ? {} : { role: 'dialog', 'aria-modal': true, tabIndex: -1 })}>
    {wide && <div className="browser-dock-handle" role="separator" aria-orientation="vertical" aria-label="Resize browser" tabIndex={0} aria-valuenow={Math.round(current())}
      onPointerDown={e => {
        if (e.button !== 0) return;
        e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); document.body.classList.add('browser-dock-dragging');
        const right = box.current!.getBoundingClientRect().right; let last: number | undefined;
        const move = (m: PointerEvent) => { last = resize(right - m.clientX); };
        const up = () => { document.body.classList.remove('browser-dock-dragging'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); save(last); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
      }}
      onDoubleClick={() => { setWidth(0); write(WIDTH_KEY, ''); }}
      onKeyDown={e => { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault(); save(resize(current() + (e.key === 'ArrowLeft' ? 32 : -32))); }} />}
    <Suspense fallback={<p className="note browser-dock-loading">Opening browser…</p>}><BrowserPanel client={client} env={env} session={session} onClose={onClose} /></Suspense>
  </aside>;
}
