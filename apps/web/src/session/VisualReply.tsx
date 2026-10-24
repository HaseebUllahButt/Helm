import { errorMessage } from '../errors';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { visualDocument } from '@helm/protocol/visual';
import { useDialog } from '../useDialog';
import { Icon } from '../Icon';
import type { Visual } from './types';

export type VisualReader = (ref: string) => Promise<{ html: string }>;
export const Visuals = createContext<VisualReader | undefined>(undefined);
/** The chat's canvas, when it has one: which page it shows, and how to show another. */
export interface CanvasVisuals { shown?: string; show: (visual: Visual) => void }
export const CanvasContext = createContext<CanvasVisuals | undefined>(undefined);

/** A live page is only ever a plain web address: never `javascript:` or a login inside it. */
export function liveUrl(visual: Visual) {
  if (!visual.url) return undefined;
  try {
    const url = new URL(visual.url);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

export function currentTheme() {
  const style = getComputedStyle(document.documentElement);
  const theme: Record<string, string> = { scheme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark' };
  for (const key of ['--bg', '--card', '--raised', '--text', '--text-dim', '--mutedfg', '--line', '--primary', '--primary-q', '--amber', '--amber-text', '--sky', '--emerald', '--red']) theme[key] = style.getPropertyValue(key).trim();
  return theme;
}

export function VisualFrame({ html, title, height = 420, expanded = false, onEscape, onPicture }: { html: string; title: string; height?: number; expanded?: boolean; onEscape?: () => void; onPicture?: (width: number) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const token = useMemo(() => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`, []);
  const [measured, setMeasured] = useState(height);
  const escape = useRef(onEscape);
  escape.current = onEscape;
  const picture = useRef(onPicture);
  picture.current = onPicture;
  const doc = useMemo(() => visualDocument(html, { token, theme: currentTheme(), expanded }), [html, token, expanded]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== ref.current?.contentWindow || event.data?.type !== 'helm.visual' || event.data.token !== token) return;
      if (typeof event.data.height === 'number' && Number.isFinite(event.data.height)) setMeasured(Math.max(120, Math.min(1200, Math.ceil(event.data.height))));
      if (typeof event.data.picture === 'number' && Number.isFinite(event.data.picture) && event.data.picture > 0) picture.current?.(Math.ceil(event.data.picture));
      if (event.data.escape) escape.current?.();
      if (typeof event.data.href === 'string' && /^https?:\/\//i.test(event.data.href) && navigator.userActivation?.isActive) window.open(event.data.href, '_blank', 'noopener,noreferrer');
    };
    const theme = () => ref.current?.contentWindow?.postMessage({ type: 'helm.visual.theme', token, theme: currentTheme() }, '*');
    const observer = new MutationObserver(theme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
    window.addEventListener('message', receive);
    return () => { observer.disconnect(); window.removeEventListener('message', receive); };
  }, [token]);
  return <iframe key={html} ref={ref} className="visual-frame" title={title} src="/helm/visual-frame" onLoad={() => ref.current?.contentWindow?.postMessage({ type: 'helm.visual.load', html: doc }, '*')} sandbox="allow-scripts" referrerPolicy="no-referrer" style={expanded ? undefined : { height: measured }} />;
}

function VisualDialog({ html, visual, onClose, onSave }: { html: string; visual: Visual; onClose: () => void; onSave: () => void }) {
  const ref = useDialog(onClose);
  const [source, setSource] = useState(false);
  return <div className="modal-back visual-back" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={ref} className="visual-dialog" role="dialog" aria-modal="true" aria-label={source ? `${visual.title} source` : visual.title} tabIndex={-1}>
      <div className="visual-bar"><strong>{visual.title}{source ? ' · Source' : ''}</strong><span className="visual-actions"><button aria-pressed={source} onClick={() => setSource(!source)}>{source ? 'Picture' : 'Source'}</button><button onClick={onSave}>Save</button><button onClick={onClose} aria-label="Close visual">Close</button></span></div>
      {source ? <pre className="visual-source" tabIndex={0}><code>{html}</code></pre> : <VisualFrame html={html} title={visual.title} expanded onEscape={onClose} />}
    </div>
  </div>;
}

/** Reads a saved page once `active`; Retry asks again. */
export function useVisualHtml(read: VisualReader | undefined, ref: string, active: boolean) {
  const [html, setHtml] = useState<string>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!active) return;
    let stale = false;
    setHtml(undefined); setError('');
    if (!read) { setError('Connect to this chat’s machine to load the image or page.'); return; }
    read(ref).then(result => { if (!stale) setHtml(result.html); }).catch(err => { if (!stale) setError(errorMessage(err, { fallback: 'Helm cannot load this visual.' })); });
    return () => { stale = true; };
  }, [active, read, ref, retry]);
  return { html, error, retry: () => setRetry(value => value + 1) };
}

export function saveVisual(html: string, title: string) {
  const url = URL.createObjectURL(new Blob([visualDocument(html, { theme: currentTheme(), expanded: true })], { type: 'text/html;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = `${title.replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 80) || 'visual'}.html`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Each device remembers which saved pages its owner folded away in the chat. */
function useFolded(ref: string) {
  const key = `helm.visual.folded.${ref}`;
  const [folded, setFolded] = useState(() => { try { return localStorage.getItem(key) === '1'; } catch { return false; } });
  const fold = (next: boolean) => {
    setFolded(next);
    try { if (next) localStorage.setItem(key, '1'); else localStorage.removeItem(key); } catch { /* private mode */ }
  };
  return [folded, fold] as const;
}

/** Lazy snapshot reads keep pages out of the chat's event/cache payloads. */
export function VisualReply({ visual, read: supplied }: { visual: Visual; read?: VisualReader }) {
  const context = useContext(Visuals), read = supplied ?? context;
  const canvas = useContext(CanvasContext);
  const live = visual.url !== undefined, url = liveUrl(visual);
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const { html, error, retry } = useVisualHtml(read, visual.ref, visible && !live);
  const [open, setOpen] = useState(false);
  // A picture on its own: the frame shrinks to it instead of spanning the chat.
  const [pictureWidth, setPictureWidth] = useState<number>();
  const [folded, fold] = useFolded(visual.ref);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: '300px' });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const inCanvas = canvas?.shown === visual.ref;
  const toCanvas = canvas && <button className="visual-open" aria-label={`Open ${visual.title} in canvas`} title={inCanvas ? 'In canvas' : 'Open in canvas'} aria-pressed={inCanvas}
    onClick={() => canvas.show(visual)}><Icon name="canvas" size={14} /></button>;
  // A live page runs only in the canvas or its own tab: a running site in
  // the middle of the conversation would load and play for every reader.
  if (live) return <div ref={ref} className="visual-reply visual-link">
    <span className="visual-link-text"><strong>{visual.title}</strong>{url ? <small>{url}</small> : <small role="alert">This page address is not allowed.</small>}</span>
    <span className="visual-actions">
      {url && <a href={url} target="_blank" rel="noopener noreferrer">Open in new tab</a>}
      {url && canvas && <button aria-pressed={inCanvas} onClick={() => canvas.show(visual)}>{inCanvas ? 'In canvas' : 'Open in canvas'}</button>}
    </span>
  </div>;
  // The page shows in one place at a time: while the canvas has it, the chat
  // keeps only a line, and the page comes back when the canvas closes.
  if (inCanvas || folded) return <div ref={ref} className="visual-reply visual-folded">
    <span className="visual-link-text"><strong>{visual.title}</strong><small>{inCanvas ? 'Shown in canvas' : 'Collapsed'}</small></span>
    {!inCanvas && <span className="visual-actions">
      {canvas && <button onClick={() => canvas.show(visual)}>Open in canvas</button>}
      <button aria-expanded={false} onClick={() => fold(false)}>Show</button>
    </span>}
  </div>;
  return <div ref={ref} className="visual-reply" style={pictureWidth ? { maxWidth: pictureWidth + 2 } : undefined}>
    {/* No title bar: the picture is the reply. Small corner buttons put it
        in the canvas or open it full size, where its source and Save live. */}
    {html && <span className="visual-corner">
      <button className="visual-open" aria-label={`Collapse ${visual.title}`} aria-expanded title="Collapse" onClick={() => fold(true)}><Icon name="up" size={14} /></button>
      {toCanvas}
      <button className="visual-open" aria-label={`Expand ${visual.title}`} title="Expand" onClick={() => setOpen(true)}><Icon name="popout" size={14} /></button>
    </span>}
    {html ? <VisualFrame html={html} title={visual.title} height={visual.height} onPicture={setPictureWidth} /> : <div className="visual-placeholder" style={{ minHeight: Math.min(visual.height, 420) }} role={error ? 'alert' : 'status'}>
      {error ? <><span>{error}</span><button onClick={retry}>Retry</button></> : 'Loading visual…'}
    </div>}
    {open && html && <VisualDialog html={html} visual={visual} onClose={() => setOpen(false)} onSave={() => saveVisual(html, visual.title)} />}
  </div>;
}
