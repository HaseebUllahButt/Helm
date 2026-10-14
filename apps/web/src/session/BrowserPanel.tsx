import { useCallback, useEffect, useRef, useState } from 'react';
import type { Client, Environment, Session } from '../client';

type Tab = { id: string; engine: string; title: string; url: string; viewport: { width: number; height: number }; control: string | null; dialog: { type: string; message: string } | null; downloads: { id: string; name: string; status: string }[] };
const keys: Record<string, string> = { Control: 'Control', Meta: 'Meta', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ' ': 'Space' };

export default function BrowserPanel({ client, env, session }: { client: Client; env: Environment; session: Session }) {
  const [tabs, setTabs] = useState<Tab[]>([]), [chosen, setChosen] = useState(''), [address, setAddress] = useState(''), [engine, setEngine] = useState('chromium'), [bowser, setBowser] = useState(false);
  const [image, setImage] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [pageText, setPageText] = useState(''), [entry, setEntry] = useState(''), [target, setTarget] = useState('');
  const viewer = useRef(''), sequence = useRef(-1), actionQueue = useRef(Promise.resolve()), actionCount = useRef(0), pointer = useRef<{ x: number; y: number } | null>(null), tab = tabs.find(t => t.id === chosen);
  if (!viewer.current) viewer.current = [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
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
      if (!document.hidden) {
        try {
          const result = await call<{ tab: Tab; sequence: number; image?: string }>('frame', { tabId: chosen, viewer: viewer.current, since: sequence.current });
          if (!alive) return; sequence.current = result.sequence; if (result.image) setImage(result.image);
          setTabs(current => { const previous = current.find(t => t.id === result.tab.id); return JSON.stringify(previous) === JSON.stringify(result.tab) ? current : current.map(t => t.id === result.tab.id ? result.tab : t); });
        } catch (e: any) { if (alive) setError(e.message); }
      }
      if (alive) timer = setTimeout(poll, 250);
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); void call('unwatch', { tabId: chosen, viewer: viewer.current }).catch(() => {}); };
  }, [call, chosen]);
  const action = (value: Record<string, unknown>) => {
    if (!chosen) return Promise.resolve(); setBusy(true); setError(''); actionCount.current++;
    actionQueue.current = actionQueue.current.catch(() => {}).then(async () => {
      try { const result = await call<{ tab?: Tab; text?: string; value?: unknown; entries?: unknown[] }>('action', { tabId: chosen, viewer: viewer.current, action: value }); if (result.text) setPageText(result.text); if (result.value !== undefined) setPageText(JSON.stringify(result.value, null, 2)); if (result.entries) setPageText(JSON.stringify(result.entries, null, 2)); if (result.tab) setTabs(current => current.map(t => t.id === result.tab!.id ? result.tab! : t)); }
      catch (e: any) { setError(e.message); } finally { if (--actionCount.current === 0) setBusy(false); }
    });
    return actionQueue.current;
  };
  const controlled = tab?.control === viewer.current;
  const download = async (downloadId: string) => { try { const result = await call<{ name: string; data: string }>('download', { tabId: chosen, downloadId }); const bytes = Uint8Array.from(atob(result.data), c => c.charCodeAt(0)), url = URL.createObjectURL(new Blob([bytes])); const a = document.createElement('a'); a.href = url; a.download = result.name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (e: any) { setError(e.message); } };
  return <section className="browser-panel" aria-label="Browser">
    <div className="browser-tabs">{tabs.map(t => <button className={t.id === chosen ? 'selected' : ''} key={t.id} onClick={() => setChosen(t.id)} title={t.url}>{t.title || 'New tab'}</button>)}<button disabled={busy} onClick={async () => { setBusy(true); setError(''); try { const result = await call<{ tab: Tab }>('open', { engine }); await refresh(); setChosen(result.tab.id); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }}>+ New tab</button>{bowser && <select aria-label="Browser engine" value={engine} onChange={e => setEngine(e.target.value)}><option value="chromium">Isolated Chromium</option><option value="bowser">Bowser shared browser</option></select>}</div>
    {tab ? <>
      <div className="browser-toolbar"><button aria-label="Go back" disabled={busy || !controlled} onClick={() => void action({ kind: 'back' })}>←</button><button aria-label="Reload" disabled={busy || !controlled} onClick={() => void action({ kind: 'reload' })}>↻</button><form onSubmit={e => { e.preventDefault(); void action({ kind: 'navigate', url: address }); }}><input aria-label="Browser address" value={address} onChange={e => setAddress(e.target.value)} placeholder="https:// or localhost" disabled={!controlled} /><button disabled={busy || !controlled}>Go</button></form><button onClick={async () => { try { const result = await call<{ tab: Tab }>('control', { tabId: chosen, viewer: viewer.current, take: !controlled }); setTabs(current => current.map(t => t.id === chosen ? result.tab : t)); } catch (e: any) { setError(e.message); } }}>{controlled ? 'Release control' : 'Take control'}</button><button aria-label="Close browser tab" disabled={busy} onClick={async () => { try { await call('close', { tabId: chosen }); await refresh(); } catch (e: any) { setError(e.message); } }}>×</button></div>
      <p className="note">{controlled ? 'You have control. Release it when the agent should continue.' : tab.control ? 'Another viewer has control.' : 'Watching the agent’s browser. Take control to interact.'}{tab.engine === 'bowser' && ' Bowser preserves its existing browser and logins; use numbered controls below.'}</p>
      <div className="browser-screen" tabIndex={controlled ? 0 : -1} role="group" aria-label="Live browser page" onWheel={e => { if (!controlled) return; e.preventDefault(); void action({ kind: 'scroll', dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) }); }} onKeyDown={e => {
        if (!controlled || e.nativeEvent.isComposing) return; e.preventDefault();
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) void action({ kind: 'type', text: e.key });
        else if (!['Shift', 'Control', 'Meta', 'Alt'].includes(e.key)) void action({ kind: 'key', key: [e.ctrlKey ? 'Control' : '', e.metaKey ? 'Meta' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '', keys[e.key] || e.key].filter(Boolean).join('+') });
      }} onPaste={e => { if (controlled) { e.preventDefault(); void action({ kind: 'type', text: e.clipboardData.getData('text/plain') }); } }}>
        {image ? <img alt="Live browser page" src={image} draggable={false}
          onContextMenu={e => { if (!controlled || tab.engine === 'bowser') return; e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect(); void action({ kind: 'click', button: 'right', x: Math.floor((e.clientX - rect.left) * tab.viewport.width / rect.width), y: Math.floor((e.clientY - rect.top) * tab.viewport.height / rect.height) }); }}
          onPointerDown={e => { if (!controlled || tab.engine === 'bowser' || e.button !== 0) return; const rect = e.currentTarget.getBoundingClientRect(); pointer.current = { x: Math.floor((e.clientX - rect.left) * tab.viewport.width / rect.width), y: Math.floor((e.clientY - rect.top) * tab.viewport.height / rect.height) }; e.currentTarget.setPointerCapture(e.pointerId); }}
          onPointerUp={e => { if (!controlled || tab.engine === 'bowser' || e.button !== 0 || !pointer.current) return; const rect = e.currentTarget.getBoundingClientRect(), start = pointer.current; pointer.current = null; e.currentTarget.parentElement?.focus(); const x = Math.min(tab.viewport.width, Math.max(0, Math.floor((e.clientX - rect.left) * tab.viewport.width / rect.width))), y = Math.min(tab.viewport.height, Math.max(0, Math.floor((e.clientY - rect.top) * tab.viewport.height / rect.height))); void action(Math.hypot(x - start.x, y - start.y) > 8 ? { kind: 'drag', fromX: start.x, fromY: start.y, toX: x, toY: y } : { kind: 'click', x, y }); }}
          onPointerCancel={() => { pointer.current = null; }} /> : <p className="note">Starting the live preview…</p>}
      </div>
      <div className="browser-tools"><button disabled={busy} onClick={() => void action({ kind: 'look' })}>Read page & controls</button><button disabled={busy} onClick={() => void action({ kind: 'console' })}>Console</button><button disabled={busy} onClick={() => void action({ kind: 'network' })}>Network</button><button disabled={busy || !controlled || tab.engine === 'bowser'} onClick={() => void action({ kind: 'resize', width: 390, height: 844 })}>Phone viewport</button><button disabled={busy || !controlled || tab.engine === 'bowser'} onClick={() => void action({ kind: 'resize', width: 1280, height: 800 })}>Desktop viewport</button></div>
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
