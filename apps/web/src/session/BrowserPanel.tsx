import { useCallback, useEffect, useRef, useState } from 'react';
import type { Client, Environment, Session } from '../client';
import { useDialog } from '../useDialog';
import { Icon } from '../Icon';
import { previewForLink, previewDelay, previewLease, type BrowserPreview, type ConnectionHint } from './browserPreview';

type Tab = { id: string; engine: string; title: string; url: string; viewport: { width: number; height: number }; control: string | null; controlEpoch: number; dialog: { type: string; message: string } | null; downloads: { id: string; name: string; status: string }[] };
const keys: Record<string, string> = { Control: 'Control', Meta: 'Meta', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ' ': 'Space' };

export function BrowserDrawer({ client, env, session, onClose }: { client: Client; env: Environment; session: Session; onClose: () => void }) {
  const ref = useDialog(onClose);
  return <div className="thread-details-back" onClick={e => { if (e.target === e.currentTarget) onClose(); }}><div className="thread-details" ref={ref} role="dialog" aria-modal="true" aria-label="Browser" tabIndex={-1}><div className="details-heading"><div><h2>Browser</h2><p>{session.title}</p></div><button className="iconbtn" aria-label="Close browser viewer" onClick={onClose}><Icon name="close" size={18} /></button></div><div className="details-content"><BrowserPanel client={client} env={env} session={session} /></div></div></div>;
}

export default function BrowserPanel({ client, env, session }: { client: Client; env: Environment; session: Session }) {
  const [tabs, setTabs] = useState<Tab[]>([]), [chosen, setChosen] = useState(''), [address, setAddress] = useState(''), [engine, setEngine] = useState('chromium'), [bowser, setBowser] = useState(false);
  const [image, setImage] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [pageText, setPageText] = useState(''), [entry, setEntry] = useState(''), [target, setTarget] = useState('');
  const [preview, setPreview] = useState<BrowserPreview | 'auto'>('auto'), [effectivePreview, setEffectivePreview] = useState<BrowserPreview>('full');
  const connectionHint = () => (navigator as Navigator & { connection?: ConnectionHint }).connection;
  const previewChoice = useRef(preview); previewChoice.current = preview;
  const autoPreview = useRef({ mode: previewForLink(0, innerWidth < 600, connectionHint()), samples: [] as number[], changedAt: 0, elapsed: 0 });
  const viewer = useRef(''), sequence = useRef(-1), actionQueue = useRef(Promise.resolve()), actionCount = useRef(0), hoverAt = useRef(0), pointer = useRef<{ x: number; y: number } | null>(null), tab = tabs.find(t => t.id === chosen);
  const viewEpoch = useRef(0), typed = useRef(''), typeTimer = useRef<ReturnType<typeof setTimeout>>(), wheel = useRef({ dx: 0, dy: 0 }), wheelTimer = useRef<ReturnType<typeof setTimeout>>();
  if (!viewer.current) viewer.current = [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
  useEffect(() => () => { viewEpoch.current++; clearTimeout(typeTimer.current); clearTimeout(wheelTimer.current); typed.current = ''; wheel.current = { dx: 0, dy: 0 }; }, [chosen]);
  const call = useCallback(<T,>(method: string, params: Record<string, unknown> = {}) => client.rpc<T>(env.id, `browser.${method}`, { id: session.id, ...params }, 60000), [client, env.id, session.id]);
  const refresh = useCallback(async () => { const result = await call<{ tabs: Tab[]; bowser: boolean }>('list'); setTabs(result.tabs); setBowser(result.bowser); setChosen(current => result.tabs.some(t => t.id === current) ? current : result.tabs[0]?.id || ''); }, [call]);
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, [refresh]);
  useEffect(() => { if (tab?.url) setAddress(tab.url === 'about:blank' ? '' : tab.url); }, [chosen, tab?.url]);
  useEffect(() => {
    if (!chosen) { setImage(''); return; }
    let alive = true, timer: ReturnType<typeof setTimeout>;
    sequence.current = -1; setImage(''); setPageText('');
    const poll = async () => {
      if (!alive) return;
      let elapsed = 0;
      const mode = previewChoice.current === 'auto' ? autoPreview.current.mode : previewChoice.current;
      if (!document.hidden) {
        try {
          const started = performance.now();
          const result = await call<{ tab: Tab; sequence: number; image?: string; preview?: BrowserPreview }>('frame', { tabId: chosen, viewer: viewer.current, since: sequence.current, preview: mode, leaseMs: previewLease(autoPreview.current.elapsed) });
          elapsed = performance.now() - started;
          if (!alive) return;
          if (result.image) { const decoded = new Image(); decoded.src = result.image; await decoded.decode(); if (!alive) return; setImage(result.image); }
          sequence.current = mode === 'text' ? -1 : result.sequence; setEffectivePreview(result.preview || mode);
          const adaptive = autoPreview.current; adaptive.elapsed = elapsed; adaptive.samples.push(elapsed); if (adaptive.samples.length > 4) adaptive.samples.shift();
          if (adaptive.samples.length >= 2) {
            const average = adaptive.samples.reduce((sum, value) => sum + value, 0) / adaptive.samples.length;
            const next = previewForLink(average, innerWidth < 600, connectionHint());
            const rank = { low: 0, balanced: 1, full: 2, text: 0 };
            if (next !== adaptive.mode && (rank[next] < rank[adaptive.mode] || Date.now() - adaptive.changedAt > 15000)) { adaptive.mode = next; adaptive.changedAt = Date.now(); }
          }
          setTabs(current => { const previous = current.find(t => t.id === result.tab.id); return JSON.stringify(previous) === JSON.stringify(result.tab) ? current : current.map(t => t.id === result.tab.id ? result.tab : t); });
        } catch (e: any) { if (alive) { setError(e.message); if (/tab not found|thread not found/i.test(e.message)) await refresh().catch(() => {}); } }
      }
      if (alive) timer = setTimeout(poll, document.hidden ? 2000 : previewDelay(mode, elapsed));
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); void call('unwatch', { tabId: chosen, viewer: viewer.current }).catch(() => {}); };
  }, [call, chosen, refresh]);
  const action = (value: Record<string, unknown>) => {
    const controlEpoch = tab?.controlEpoch;
    if (value.kind === 'dialog') return call('action', { tabId: chosen, viewer: viewer.current, controlEpoch, action: value }).then(() => refresh()).catch((e: any) => setError(e.message));
    if (actionCount.current >= 64) { setError('Browser input is catching up. Wait before sending more.'); return Promise.resolve(); }
    if (!chosen) return Promise.resolve(); setBusy(true); setError(''); actionCount.current++;
    const epoch = viewEpoch.current;
    actionQueue.current = actionQueue.current.catch(() => {}).then(async () => {
      if (epoch !== viewEpoch.current) { if (--actionCount.current === 0) setBusy(false); return; }
      try { const result = await call<{ tab?: Tab; text?: string; value?: unknown; entries?: unknown[] }>('action', { tabId: chosen, viewer: viewer.current, controlEpoch, action: value }); if (result.text) setPageText(result.text); if (result.value !== undefined) setPageText(JSON.stringify(result.value, null, 2)); if (result.entries) setPageText(JSON.stringify(result.entries, null, 2)); if (result.tab) setTabs(current => current.map(t => t.id === result.tab!.id ? result.tab! : t)); }
      catch (e: any) { setError(e.message); } finally { if (--actionCount.current === 0) setBusy(false); }
    });
    return actionQueue.current;
  };
  const flushTyped = () => { clearTimeout(typeTimer.current); typeTimer.current = undefined; const value = typed.current; typed.current = ''; if (value) void action({ kind: 'type', text: value }); };
  const flushWheel = () => { clearTimeout(wheelTimer.current); wheelTimer.current = undefined; const { dx, dy } = wheel.current; wheel.current = { dx: 0, dy: 0 }; if (dx || dy) void action({ kind: 'scroll', dx: Math.max(-20000, Math.min(20000, dx)), dy: Math.max(-20000, Math.min(20000, dy)) }); };
  const controlled = tab?.control === viewer.current;
  const download = async (downloadId: string) => { try { const result = await call<{ name: string; data: string }>('download', { tabId: chosen, downloadId }); const bytes = Uint8Array.from(atob(result.data), c => c.charCodeAt(0)), url = URL.createObjectURL(new Blob([bytes])); const a = document.createElement('a'); a.href = url; a.download = result.name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (e: any) { setError(e.message); } };
  return <section className="browser-panel" aria-label="Browser">
    <div className="browser-tabs">{tabs.map(t => <button className={t.id === chosen ? 'selected' : ''} key={t.id} onClick={() => setChosen(t.id)} title={t.url}>{t.title || 'New tab'}</button>)}<button disabled={busy} onClick={async () => { setBusy(true); setError(''); try { const result = await call<{ tab: Tab }>('open', { engine }); await refresh(); setChosen(result.tab.id); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }}>+ New tab</button>{bowser && <select aria-label="Browser engine" value={engine} onChange={e => setEngine(e.target.value)}><option value="chromium">Isolated Chromium</option><option value="bowser">Bowser shared browser</option></select>}</div>
    {tab ? <>
      <div className="browser-toolbar"><button aria-label="Go back" disabled={busy || !controlled} onClick={() => void action({ kind: 'back' })}><Icon name="back" size={14} /></button><button aria-label="Go forward" disabled={busy || !controlled || tab.engine === 'bowser'} onClick={() => void action({ kind: 'forward' })}><Icon name="forward" size={14} /></button><button aria-label="Reload" disabled={busy || !controlled} onClick={() => void action({ kind: 'reload' })}><Icon name="refresh" size={14} /></button><form onSubmit={e => { e.preventDefault(); void action({ kind: 'navigate', url: address }); }}><input aria-label="Browser address" value={address} onChange={e => setAddress(e.target.value)} placeholder="https:// or localhost" disabled={!controlled} /><button disabled={busy || !controlled}>Go</button></form><button onClick={async () => { try { const result = await call<{ tab: Tab }>('control', { tabId: chosen, viewer: viewer.current, take: !controlled }); setTabs(current => current.map(t => t.id === chosen ? result.tab : t)); } catch (e: any) { setError(e.message); } }}>{controlled ? 'Release control' : 'Take control'}</button><button aria-label="Close browser tab" disabled={busy} onClick={async () => { try { await call('close', { tabId: chosen }); await refresh(); } catch (e: any) { setError(e.message); } }}><Icon name="close" size={14} /></button></div>
      <p className="note">{controlled ? 'You have control. Release it when the agent should continue.' : tab.control ? 'Another viewer has control.' : 'Watching the agent’s browser. Take control to interact.'}{tab.engine === 'bowser' && ' Bowser preserves its existing browser and logins; use numbered controls below.'}</p>
      <div className="browser-preview"><label>Preview <select aria-label="Browser preview quality" value={preview} onChange={e => setPreview(e.target.value as BrowserPreview | 'auto')}><option value="auto">Auto</option><option value="low">Low data</option><option value="balanced">Balanced</option><option value="full">Full quality</option><option value="text">Text only</option></select></label>{preview === 'auto' && effectivePreview === 'low' && <span className="note">Low data preview for this connection.</span>}</div>
      <div className="browser-screen" tabIndex={controlled ? 0 : -1} role="group" aria-label="Live browser page" onWheel={e => { if (!controlled) return; flushTyped(); e.preventDefault(); wheel.current.dx += Math.round(e.deltaX); wheel.current.dy += Math.round(e.deltaY); if (!wheelTimer.current) wheelTimer.current = setTimeout(() => { wheelTimer.current = undefined; flushWheel(); }, 40); }} onKeyDown={e => {
        if (!controlled || e.nativeEvent.isComposing) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { flushTyped(); return; }
        e.preventDefault(); flushWheel();
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { typed.current += e.key; if (typed.current.length >= 1000) flushTyped(); else if (!typeTimer.current) typeTimer.current = setTimeout(() => { typeTimer.current = undefined; flushTyped(); }, 40); }
        else if (!['Shift', 'Control', 'Meta', 'Alt'].includes(e.key)) { flushTyped(); void action({ kind: 'key', key: [e.ctrlKey ? 'Control' : '', e.metaKey ? 'Meta' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '', keys[e.key] || e.key].filter(Boolean).join('+') }); }
      }} onPaste={e => { if (controlled) { flushTyped(); e.preventDefault(); void action({ kind: 'type', text: e.clipboardData.getData('text/plain') }); } }}>
        {preview === 'text' ? <p className="note">Live images are off. Read page & controls below to browse with text.</p> : image ? <img alt="Live browser page" src={image} draggable={false}
          onContextMenu={e => { if (!controlled || tab.engine === 'bowser') return; e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect(); void action({ kind: 'click', button: 'right', x: Math.floor((e.clientX - rect.left) * tab.viewport.width / rect.width), y: Math.floor((e.clientY - rect.top) * tab.viewport.height / rect.height) }); }}
          onPointerDown={e => { if (!controlled || tab.engine === 'bowser' || e.button !== 0) return; const rect = e.currentTarget.getBoundingClientRect(); pointer.current = { x: Math.floor((e.clientX - rect.left) * tab.viewport.width / rect.width), y: Math.floor((e.clientY - rect.top) * tab.viewport.height / rect.height) }; e.currentTarget.setPointerCapture(e.pointerId); }}
          onPointerMove={e => { if (!controlled || busy || tab.engine === 'bowser' || pointer.current || e.pointerType !== 'mouse' || Date.now() - hoverAt.current < 200) return; hoverAt.current = Date.now(); const rect = e.currentTarget.getBoundingClientRect(); void action({ kind: 'hover', x: Math.floor((e.clientX - rect.left) * tab.viewport.width / rect.width), y: Math.floor((e.clientY - rect.top) * tab.viewport.height / rect.height) }); }}
          onPointerUp={e => { if (!controlled || tab.engine === 'bowser' || e.button !== 0 || !pointer.current) return; const rect = e.currentTarget.getBoundingClientRect(), start = pointer.current; pointer.current = null; e.currentTarget.parentElement?.focus(); const x = Math.min(tab.viewport.width, Math.max(0, Math.floor((e.clientX - rect.left) * tab.viewport.width / rect.width))), y = Math.min(tab.viewport.height, Math.max(0, Math.floor((e.clientY - rect.top) * tab.viewport.height / rect.height))); void action(Math.hypot(x - start.x, y - start.y) > 8 ? e.pointerType === 'touch' ? { kind: 'scroll', dx: start.x - x, dy: start.y - y } : { kind: 'drag', fromX: start.x, fromY: start.y, toX: x, toY: y } : { kind: 'click', x, y }); }}
          onPointerCancel={() => { pointer.current = null; }} /> : <p className="note">Starting the live preview…</p>}
      </div>
      <div className="browser-tools"><button disabled={busy} onClick={() => void action({ kind: 'look' })}>Read page & controls</button><button disabled={busy} onClick={() => void action({ kind: 'console' })}>Console</button><button disabled={busy} onClick={() => void action({ kind: 'network' })}>Network</button><button disabled={busy || !controlled || tab.engine === 'bowser'} onClick={() => void action({ kind: 'resize', width: 390, height: 844 })}>Phone viewport</button><button disabled={busy || !controlled || tab.engine === 'bowser'} onClick={() => void action({ kind: 'resize', width: 1280, height: 800 })}>Desktop viewport</button></div>
      {controlled && tab.engine === 'chromium' && <button disabled={busy} onClick={async () => { try { const result = await call<{ text: string }>('action', { tabId: chosen, viewer: viewer.current, controlEpoch: tab.controlEpoch, action: { kind: 'clipboard' } }); setPageText(result.text); if (navigator.clipboard) await navigator.clipboard.writeText(result.text); } catch (e: any) { setError(e.message); } }}>Copy browser clipboard</button>}
      {controlled && <div className="browser-input"><input aria-label="Element number" value={target} onChange={e => setTarget(e.target.value)} placeholder="Element # (optional)" /><input aria-label="Text to type into browser" value={entry} onChange={e => setEntry(e.target.value)} placeholder="Type or paste text" /><button disabled={busy || !entry} onClick={() => { void action({ kind: 'type', text: entry, ...(target ? { ref: Number(target) } : {}) }); setEntry(''); }}>Type</button><button disabled={busy || !target} onClick={() => void action({ kind: 'click', ref: Number(target) })}>Click #</button><label className="ctl">Upload<input type="file" hidden multiple onChange={async e => {
        const files = [...(e.target.files || [])]; e.target.value = ''; if (!files.length) return;
        if (!target) { setError('Read the page and enter its file input element number first.'); return; }
        if (files.length > 10 || files.reduce((sum, file) => sum + file.size, 0) > 8 * 1024 * 1024) { setError('Upload up to 10 files, 8 MiB total.'); return; }
        try { const uploads = await Promise.all(files.map(async file => { const bytes = new Uint8Array(await file.arrayBuffer()); let value = ''; for (let i = 0; i < bytes.length; i += 32768) value += String.fromCharCode(...bytes.subarray(i, i + 32768)); return { name: file.name, data: btoa(value) }; })); await action({ kind: 'upload', ref: Number(target), uploads }); } catch (e: any) { setError(e.message); }
      }} /></label></div>}
      {tab.dialog && <div className="browser-dialog"><p>{tab.dialog.message}</p><button disabled={!controlled} onClick={() => void action({ kind: 'dialog', accept: true, text: entry })}>Accept</button><button disabled={!controlled} onClick={() => void action({ kind: 'dialog', accept: false })}>Dismiss</button></div>}
      {tab.downloads.map(d => <div key={d.id}><button disabled={d.status !== 'ready'} onClick={() => void download(d.id)}>{d.name} · {d.status === 'ready' ? 'Save download' : d.status}</button></div>)}
      {pageText && <pre className="browser-text">{pageText}</pre>}
    </> : <p className="note">Open a tab to browse with your agent. The browser runs on {env.name}; localhost reaches servers there. Chromium starts only when you open the first tab.</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
