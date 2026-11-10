import { errorMessage } from '../errors';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { visualDocument } from '@helm/protocol/visual';
import { useDialog } from '../useDialog';
import { Icon } from '../Icon';
import type { Visual } from './types';

/** A saved page comes back as HTML. A PDF gives its page list, then one page picture per call. */
/** `download`: the machine kept the PDF itself, so Download can save it. */
export interface PdfPages { total: number; pages: { width: number; height: number }[]; download?: boolean }
/**
 * Reads a saved page, a PDF's page list, one page picture, or with 'file' one
 * piece of the original file from `offset`. An older machine sends the whole
 * file and no `size`.
 */
export type VisualReader = (ref: string, page?: number | 'file', offset?: number) => Promise<{ html?: string; image?: string; file?: string; offset?: number; size?: number; name?: string; mime?: string } & Partial<PdfPages>>;
/** The `session.visual` options for one read. */
export const visualPart = (page?: number | 'file', offset?: number) => page === 'file' ? { file: true, ...(offset === undefined ? {} : { offset }) } : page === undefined ? {} : { page };
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
  for (const key of ['--bg', '--card', '--raised', '--text', '--text-dim', '--mutedfg', '--line', '--primary', '--primary-q', '--amber', '--amber-text', '--sky', '--emerald', '--red', '--radius']) theme[key] = style.getPropertyValue(key).trim();
  // The page writes in the chat's own font; a see-through divider gets a faint one so tables and cards still show edges.
  theme['--font-sans'] = getComputedStyle(document.body).fontFamily;
  theme['--font-mono'] = style.getPropertyValue('--mono').trim();
  if (!theme['--line'] || theme['--line'] === 'transparent') theme['--line'] = theme.scheme === 'light' ? 'rgb(26 29 36 / 12%)' : 'rgb(255 255 255 / 10%)';
  return theme;
}

export function VisualFrame({ html, title, height = 420, expanded = false, onEscape }: { html: string; title: string; height?: number; expanded?: boolean; onEscape?: () => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const token = useMemo(() => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`, []);
  const [measured, setMeasured] = useState(height);
  const escape = useRef(onEscape);
  escape.current = onEscape;
  const doc = useMemo(() => visualDocument(html, { token, theme: currentTheme(), expanded }), [html, token, expanded]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== ref.current?.contentWindow || event.data?.type !== 'helm.visual' || event.data.token !== token) return;
      if (typeof event.data.height === 'number' && Number.isFinite(event.data.height)) setMeasured(Math.max(120, Math.min(1200, Math.ceil(event.data.height))));
      if (event.data.escape) escape.current?.();
      // A Ctrl/Cmd key pressed in the page: Helm's own shortcuts still work.
      const key = event.data.key;
      if (key && typeof key.key === 'string' && typeof key.code === 'string' && (key.ctrlKey || key.metaKey)) {
        ref.current?.dispatchEvent(new KeyboardEvent('keydown', { key: key.key, code: key.code, ctrlKey: !!key.ctrlKey, metaKey: !!key.metaKey, shiftKey: !!key.shiftKey, altKey: !!key.altKey, bubbles: true, cancelable: true }));
      }
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
    read(ref).then(result => { if (!stale) setHtml(result.html ?? ''); }).catch(err => { if (!stale) setError(errorMessage(err, { fallback: 'Helm cannot load this visual.' })); });
    return () => { stale = true; };
  }, [active, read, ref, retry]);
  return { html, error, retry: () => setRetry(value => value + 1) };
}

/** Reads a PDF's page list; Retry asks again. */
export function usePdfPages(read: VisualReader | undefined, ref: string) {
  const [list, setList] = useState<PdfPages>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let stale = false;
    setList(undefined); setError('');
    if (!read) { setError('Connect to this chat’s machine to load the PDF.'); return; }
    read(ref).then(result => {
      if (stale) return;
      if (!Array.isArray(result.pages)) { setError('Update Helm on this machine to show PDFs.'); return; }
      setList({ total: result.total ?? result.pages.length, pages: result.pages, download: result.download === true });
    }).catch(err => { if (!stale) setError(errorMessage(err, { fallback: 'Helm cannot load this PDF.' })); });
    return () => { stale = true; };
  }, [read, ref, retry]);
  return { list, error, retry: () => setRetry(value => value + 1) };
}

export function saveVisual(html: string, title: string, name?: string) {
  const blob = new Blob([visualDocument(html, { theme: currentTheme(), expanded: true })], { type: 'text/html;charset=utf-8' });
  if (name && /\.html?$/i.test(name)) saveNamed(blob, name); else saveBlob(blob, title, 'html');
}

/** A file's bytes from base64, for a Blob. */
function bytesOf(data: string) {
  const text = atob(data), bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/**
 * Reads a whole file in pieces: each call gives the piece at `offset` and
 * the file's whole size. A reply with no size is the whole file at once.
 */
export async function readPieces(piece: (offset: number) => Promise<{ data?: string; size?: number }>, onProgress?: (done: number, size: number) => void) {
  const parts: Uint8Array[] = [];
  let offset = 0, size: number | undefined;
  do {
    const r = await piece(offset);
    if (typeof r.data !== 'string') throw new Error('Update Helm on this machine to download files.');
    const bytes = bytesOf(r.data);
    parts.push(bytes);
    offset += bytes.length;
    if (typeof r.size !== 'number') return parts;
    size = r.size;
    onProgress?.(offset, size);
    if (!bytes.length && offset < size) throw new Error('The file got shorter while Helm read it. Try again.');
  } while (offset < size);
  return parts;
}

/** Downloads a visual's original file, as the machine kept it. */
export async function downloadOriginal(read: VisualReader, visual: Visual, fallback: { title: string; extension: string; mime: string }, onProgress?: (done: number, size: number) => void) {
  let name = visual.name, mime = visual.file?.mime ?? fallback.mime;
  const parts = await readPieces(async (offset) => {
    const r = await read(visual.ref, 'file', offset);
    if (r.name) name = r.name;
    if (r.mime) mime = r.mime;
    return { data: r.file, size: r.size };
  }, onProgress);
  const blob = new Blob(parts as BlobPart[], { type: mime });
  if (name) saveNamed(blob, name); else saveBlob(blob, fallback.title, fallback.extension);
}

/** Saves a file to the device's downloads under its own name. */
export function saveNamed(blob: Blob, name: string) {
  const clean = name.replace(/[\\/\u0000-\u001f]/g, '').trim();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = clean || 'file';
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Saves a file to the device's downloads, named after the page. */
export function saveBlob(blob: Blob, title: string, extension: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = `${title.replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 80) || 'visual'}.${extension}`;
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
  const { html, error, retry } = useVisualHtml(read, visual.ref, visible && !live && visual.kind !== 'pdf');
  const [open, setOpen] = useState(false);
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
  // A PDF opens beside the chat, never inside it: the card only names it.
  if (visual.kind === 'pdf') return <div ref={ref} className="visual-reply visual-link">
    <span className="visual-link-text"><strong>{visual.title}</strong><small>{inCanvas ? 'Shown in canvas' : `PDF · ${visual.total ?? visual.pages ?? 1} ${(visual.total ?? visual.pages) === 1 ? 'page' : 'pages'}`}</small></span>
    {canvas && !inCanvas && <span className="visual-actions"><button onClick={() => canvas.show(visual)}>Open in canvas</button></span>}
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
  return <div ref={ref} className="visual-reply">
    {/* No title bar: the picture is the reply. Small corner buttons put it
        in the canvas or open it full size, where its source and Save live. */}
    {html && <span className="visual-corner">
      <button className="visual-open" aria-label={`Collapse ${visual.title}`} aria-expanded title="Collapse" onClick={() => fold(true)}><Icon name="up" size={14} /></button>
      {toCanvas}
      <button className="visual-open" aria-label={`Expand ${visual.title}`} title="Expand" onClick={() => setOpen(true)}><Icon name="popout" size={14} /></button>
    </span>}
    {html ? <VisualFrame html={html} title={visual.title} height={visual.height} /> : <div className="visual-placeholder" style={{ minHeight: Math.min(visual.height, 420) }} role={error ? 'alert' : 'status'}>
      {error ? <><span>{error}</span><button onClick={retry}>Retry</button></> : 'Loading visual…'}
    </div>}
    {open && html && <VisualDialog html={html} visual={visual} onClose={() => setOpen(false)} onSave={() => saveVisual(html, visual.title)} />}
  </div>;
}
