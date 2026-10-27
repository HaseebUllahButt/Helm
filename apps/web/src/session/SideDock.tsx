import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

const MIN = 360, CHAT_MIN = 380;
const WIDE = '(min-width: 1000px)';

export const readLocal = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
export const writeLocal = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } };
const fit = (width: number, room: number) => Math.round(Math.max(MIN, Math.min(width, room - CHAT_MIN)));

export function useWide() {
  const [wide, setWide] = useState(() => matchMedia(WIDE).matches);
  useEffect(() => { const query = matchMedia(WIDE), on = () => setWide(query.matches); query.addEventListener('change', on); return () => query.removeEventListener('change', on); }, []);
  return wide;
}

/** A column beside the chat on a wide screen, or a full screen on a phone.
 * Drag its left edge to set its width. Double-click to use the default width.
 */
export function SideDock({ label, widthKey, className, share = 0.45, escapeCloses = false, onClose, children }: {
  label: string; widthKey: string; className: string;
  /** How much of the room it takes before the owner drags it. */
  share?: number;
  /** Escape anywhere in the chat closes the column too, not only the phone sheet. */
  escapeCloses?: boolean;
  onClose: () => void; children: ReactNode;
}) {
  const wide = useWide();
  const drag = useRef<(() => void) | null>(null);
  useEffect(() => () => { drag.current?.(); }, [wide]);
  const box = useRef<HTMLElement>(null), close = useRef(onClose); close.current = onClose;
  const [width, setWidth] = useState(() => Number(readLocal(widthKey)) || 0);
  // On a phone it is a sheet over the chat: Escape closes it. Focus goes to
  // the sheet, not a field in it, so no keyboard pops up.
  useEffect(() => {
    const sheet = box.current;
    if (wide || !sheet) return;
    sheet.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && [...document.querySelectorAll('[aria-modal="true"]')].at(-1) === sheet && !(e.target as HTMLElement).closest?.('textarea')) { e.preventDefault(); close.current(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [wide]);
  // Beside the chat, Escape closes it from anywhere, unless something else
  // wants the key: a dialog, an open menu, or a terminal.
  // On window, so every handler on the page has had its turn first.
  useEffect(() => {
    if (!wide || !escapeCloses) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      if (document.querySelector('[aria-modal="true"], [aria-haspopup][aria-expanded="true"]')) return;
      if ((e.target as HTMLElement).closest?.('.xterm')) return;
      e.preventDefault(); close.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wide, escapeCloses]);
  // The chat makes room through its own padding; the dock sits in that gap.
  useLayoutEffect(() => {
    const main = box.current?.parentElement;
    if (!wide || !main) return;
    const apply = () => main.style.setProperty('--side-dock-w', `${fit(width || main.clientWidth * share, main.clientWidth)}px`);
    apply(); main.classList.add('with-side-dock');
    const observer = new ResizeObserver(apply); observer.observe(main);
    return () => { observer.disconnect(); main.classList.remove('with-side-dock'); main.style.removeProperty('--side-dock-w'); };
  }, [wide, width, share]);
  const resize = (next: number) => { const main = box.current?.parentElement; if (!main) return; const w = fit(next, main.clientWidth); main.style.setProperty('--side-dock-w', `${w}px`); return w; };
  const save = (w?: number) => { if (!w) return; setWidth(w); writeLocal(widthKey, String(w)); };
  const current = () => box.current?.getBoundingClientRect().width || 0;
  return <aside ref={box} className={`side-dock ${className} ${wide ? 'side-dock-side' : 'side-dock-full'}`} aria-label={label} {...(wide ? {} : { role: 'dialog', 'aria-modal': true, tabIndex: -1 })}>
    {wide && <div className="side-dock-handle" role="separator" aria-orientation="vertical" aria-label={`Resize ${label.toLowerCase()}`} tabIndex={0} aria-valuenow={Math.round(current())}
      onPointerDown={e => {
        if (e.button !== 0) return;
        drag.current?.();
        e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); document.body.classList.add('side-dock-dragging');
        const right = box.current!.getBoundingClientRect().right; let last: number | undefined;
        const move = (m: PointerEvent) => { last = resize(right - m.clientX); };
        const cleanup = () => { document.body.classList.remove('side-dock-dragging'); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); drag.current = null; };
        const up = () => { cleanup(); save(last); };
        drag.current = cleanup;
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
      }}
      onDoubleClick={() => { setWidth(0); writeLocal(widthKey, ''); }}
      onKeyDown={e => { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault(); save(resize(current() + (e.key === 'ArrowLeft' ? 32 : -32))); }} />}
    {children}
  </aside>;
}
