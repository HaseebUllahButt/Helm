import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { visualDocument } from '@helm/protocol/visual';
import { useDialog } from '../useDialog';
import type { Visual } from './types';

export type VisualReader = (ref: string) => Promise<{ html: string }>;
export const Visuals = createContext<VisualReader | undefined>(undefined);

function currentTheme() {
  const style = getComputedStyle(document.documentElement);
  const theme: Record<string, string> = { scheme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark' };
  for (const key of ['--bg', '--card', '--raised', '--text', '--text-dim', '--mutedfg', '--line', '--primary', '--primary-q', '--amber', '--amber-text', '--sky', '--emerald', '--red']) theme[key] = style.getPropertyValue(key).trim();
  return theme;
}

function VisualFrame({ html, title, height = 420, expanded = false, onEscape }: { html: string; title: string; height?: number; expanded?: boolean; onEscape?: () => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const token = useMemo(() => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`, []);
  const [measured, setMeasured] = useState(height);
  const escape = useRef(onEscape);
  escape.current = onEscape;
  const doc = useMemo(() => visualDocument(html, { token, theme: currentTheme() }), [html, token]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== ref.current?.contentWindow || event.data?.type !== 'helm.visual' || event.data.token !== token) return;
      if (typeof event.data.height === 'number' && Number.isFinite(event.data.height)) setMeasured(Math.max(120, Math.min(1200, Math.ceil(event.data.height))));
      if (event.data.escape) escape.current?.();
      if (typeof event.data.href === 'string' && /^https?:\/\//i.test(event.data.href) && navigator.userActivation?.isActive) window.open(event.data.href, '_blank', 'noopener,noreferrer');
    };
    const theme = () => ref.current?.contentWindow?.postMessage({ type: 'helm.visual.theme', token, theme: currentTheme() }, '*');
    const observer = new MutationObserver(theme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
    window.addEventListener('message', receive);
    return () => { observer.disconnect(); window.removeEventListener('message', receive); };
  }, [token]);
  return <iframe ref={ref} className="visual-frame" title={title} srcDoc={doc} sandbox="allow-scripts" referrerPolicy="no-referrer" style={expanded ? undefined : { height: measured }} />;
}

function VisualDialog({ html, visual, source, onClose, onSave }: { html: string; visual: Visual; source: boolean; onClose: () => void; onSave: () => void }) {
  const ref = useDialog(onClose);
  return <div className="modal-back visual-back" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={ref} className="visual-dialog" role="dialog" aria-modal="true" aria-label={source ? `${visual.title} source` : visual.title} tabIndex={-1}>
      <div className="visual-bar"><strong>{visual.title}{source ? ' · Source' : ''}</strong><span className="visual-actions"><button onClick={onSave}>Save</button><button onClick={onClose} aria-label="Close visual">Close</button></span></div>
      {source ? <pre className="visual-source" tabIndex={0}><code>{html}</code></pre> : <VisualFrame html={html} title={visual.title} expanded onEscape={onClose} />}
    </div>
  </div>;
}

/** Lazy snapshot reads keep pages out of the chat's event/cache payloads. */
export function VisualReply({ visual, read: supplied }: { visual: Visual; read?: VisualReader }) {
  const context = useContext(Visuals), read = supplied ?? context;
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [html, setHtml] = useState<string>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [dialog, setDialog] = useState<'expand' | 'source' | null>(null);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: '300px' });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let stale = false;
    setHtml(undefined); setError('');
    if (!read) { setError('Connect to the chat’s machine to load this visual.'); return; }
    read(visual.ref).then(result => { if (!stale) setHtml(result.html); }).catch(err => { if (!stale) setError(err.message || 'Could not load this visual.'); });
    return () => { stale = true; };
  }, [visible, read, visual.ref, retry]);
  const save = () => {
    if (!html) return;
    const url = URL.createObjectURL(new Blob([visualDocument(html, { theme: currentTheme() })], { type: 'text/html;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = `${visual.title.replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 80) || 'visual'}.html`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
  return <div ref={ref} className="visual-reply">
    <div className="visual-bar"><strong>{visual.title}</strong><span className="visual-actions">
      <button disabled={!html} onClick={() => setDialog('expand')}>Expand</button>
      <button disabled={!html} onClick={() => setDialog('source')}>Source</button>
      <button disabled={!html} onClick={save}>Save</button>
    </span></div>
    {html ? <VisualFrame html={html} title={visual.title} height={visual.height} /> : <div className="visual-placeholder" style={{ minHeight: Math.min(visual.height, 420) }} role={error ? 'alert' : 'status'}>
      {error ? <><span>{error}</span><button onClick={() => setRetry(value => value + 1)}>Retry</button></> : 'Loading visual…'}
    </div>}
    {dialog && html && <VisualDialog html={html} visual={visual} source={dialog === 'source'} onClose={() => setDialog(null)} onSave={save} />}
  </div>;
}
