import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Client, Environment, Session } from '../client';
import BrowserLogins from './BrowserLogins';
import { Icon } from '../Icon';
import { previewForLink, previewWait, previewDelay, previewLease, type BrowserPreview, type ConnectionHint } from './browserPreview';
import { isDockKey } from './BrowserDock';
import { BrowserPointer, type Pointer } from './BrowserPointer';

type Tab = { id: string; engine: string; title: string; url: string; window?: boolean; viewport: { width: number; height: number }; control: string | null; controlEpoch: number; dialog: { type: string; message: string } | null; downloads: { id: string; name: string; status: string }[]; pointer?: Pointer | null; fit?: boolean; loading?: boolean; problem?: { url: string; message: string } | null };
const keys: Record<string, string> = { Control: 'Control', Meta: 'Meta', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ' ': 'Space' };
const clamp = (value: number, min: number, max: number) => Math.round(Math.max(min, Math.min(max, value)));
const near = (a: { width: number; height: number }, b: { width: number; height: number }) => Math.abs(a.width - b.width) < 24 && Math.abs(a.height - b.height) < 24;
const host = (url: string) => { try { const u = new URL(url); return u.protocol === 'about:' ? '' : u.host; } catch { return url; } };

export default function BrowserPanel({ client, env, session, onClose }: { client: Client; env: Environment; session: Session; onClose?: () => void }) {
  const [tabs, setTabs] = useState<Tab[]>([]), [chosen, setChosen] = useState(''), [address, setAddress] = useState(''), [engine, setEngine] = useState('chromium'), [bowser, setBowser] = useState(false);
  const [windowed, setWindowed] = useState(false), [canWindow, setCanWindow] = useState(false);
  const [image, setImage] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [pageText, setPageText] = useState(''), [entry, setEntry] = useState(''), [target, setTarget] = useState('');
  const [preview, setPreview] = useState<BrowserPreview | 'auto'>('auto'), [effectivePreview, setEffectivePreview] = useState<BrowserPreview>('full');
  const [tools, setTools] = useState(false), [natural, setNatural] = useState<{ width: number; height: number } | null>(null), [dismissed, setDismissed] = useState(0);
  const connectionHint = () => (navigator as Navigator & { connection?: ConnectionHint }).connection;
  const previewChoice = useRef(preview); previewChoice.current = preview;
  const autoPreview = useRef({ mode: previewForLink(0, innerWidth < 600, connectionHint()), samples: [] as number[], changedAt: 0, elapsed: 0 });
  const viewer = useRef(''), sequence = useRef(-1), actionQueue = useRef(Promise.resolve()), actionCount = useRef(0), hoverAt = useRef(0), press = useRef<{ x: number; y: number } | null>(null), tab = tabs.find(t => t.id === chosen);
  const viewEpoch = useRef(0), typed = useRef(''), typeTimer = useRef<ReturnType<typeof setTimeout>>(), wheel = useRef({ dx: 0, dy: 0 }), wheelTimer = useRef<ReturnType<typeof setTimeout>>();
  const latest = useRef(tab), taking = useRef<Promise<number> | null>(null), screen = useRef<HTMLDivElement>(null); latest.current = tab;
  const panel = useRef<HTMLElement>(null), nav = useRef<HTMLDivElement>(null), fitted = useRef(new Map<string, { width: number; height: number }>()), fitTimer = useRef<ReturnType<typeof setTimeout>>();
  if (!viewer.current) viewer.current = [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
  useEffect(() => () => { viewEpoch.current++; clearTimeout(typeTimer.current); clearTimeout(wheelTimer.current); typed.current = ''; wheel.current = { dx: 0, dy: 0 }; }, [chosen]);
  // Whatever goes wrong is said in words: no terminal colour codes or call logs.
  const plain = (message: string) => message.replace(/\u001b\[[0-9;]*m/g, '').replace(/\s*Call log:[\s\S]*$/, '').replace(/^page\.\w+: /, '').trim();
  const call = useCallback(<T,>(method: string, params: Record<string, unknown> = {}) => client.rpc<T>(env.id, `browser.${method}`, { id: session.id, ...params }, 60000), [client, env.id, session.id]);
  const listed = useCallback((result: { tabs: Tab[]; bowser?: boolean; window?: boolean; canWindow?: boolean }) => { setTabs(result.tabs); if (result.bowser !== undefined) setBowser(result.bowser); setWindowed(!!result.window); setCanWindow(!!result.canWindow); setChosen(current => result.tabs.some(t => t.id === current) ? current : result.tabs[0]?.id || ''); }, []);
  const refresh = useCallback(async () => { const result = await call<{ tabs: Tab[]; bowser: boolean; window?: boolean; canWindow?: boolean }>('list', { warm: true }); listed(result); }, [call, listed]);
  // In a window, the owner opens and closes tabs there, or closes the window: keep the list current.
  useEffect(() => { if (!windowed) return; const timer = setInterval(() => void refresh().catch(() => {}), 2000); return () => clearInterval(timer); }, [windowed, refresh]);
  /**
   * The tabs move into a real Chromium window on the chat's machine. It is
   * placed over this panel, where the owner was already looking; a window
   * manager that places windows itself (a tiling one) puts it beside Helm.
   */
  const toWindow = async (open: boolean) => {
    setBusy(true); setError('');
    let place: { x: number; y: number; width: number; height: number } | undefined;
    const box = panel.current?.getBoundingClientRect();
    if (open && box && matchMedia('(pointer: fine)').matches) {
      const left = screenX + Math.max(0, outerWidth - innerWidth), top = screenY + Math.max(0, outerHeight - innerHeight);
      place = { x: Math.round(left + box.left), y: Math.round(top + box.top), width: Math.max(400, Math.round(box.width)), height: Math.max(300, Math.round(box.height)) };
    }
    // A picture request cut short by the move is not worth saying anything about.
    try { listed(await call<{ tabs: Tab[]; window: boolean; canWindow: boolean }>('window', { open, tabId: chosen || undefined, ...(place ? { place } : {}) })); setError(''); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, [refresh]);
  // The agent opened a tab here: list it and follow it.
  useEffect(() => client.on((id, kind, payload: any) => {
    if (id !== env.id || kind !== 'browser.tab' || payload?.id !== session.id) return;
    void refresh().then(() => { if (!payload.viewer) setChosen(payload.tabId); }).catch(() => {});
  }), [client, env.id, session.id, refresh]);
  // What the owner is typing stays put while the page under it moves on.
  const typingAddress = useRef(false);
  useEffect(() => { if (tab?.url && !typingAddress.current) setAddress(tab.url === 'about:blank' ? '' : tab.url); }, [chosen, tab?.url]);
  useEffect(() => { setNatural(null); }, [chosen]);
  useEffect(() => {
    if (!chosen || windowed) { setImage(''); return; }
    let alive = true, oldServer = false, timer: ReturnType<typeof setTimeout>;
    sequence.current = -1; setImage(''); setPageText('');
    const poll = async () => {
      if (!alive) return;
      let elapsed = 0, held = false;
      const wanted = previewChoice.current === 'auto' ? autoPreview.current.mode : previewChoice.current, mode = wanted === 'smooth' && oldServer ? 'full' : wanted;
      if (!document.hidden) {
        try {
          const started = performance.now();
          const result = await call<{ tab: Tab; sequence: number; image?: string; preview?: BrowserPreview; waited?: number }>('frame', { tabId: chosen, viewer: viewer.current, since: sequence.current, preview: mode, waitMs: previewWait(mode), leaseMs: previewLease(autoPreview.current.elapsed) });
          held = result.waited !== undefined; elapsed = Math.max(1, performance.now() - started - (result.waited || 0));
          if (!alive) return;
          if (result.image) { const decoded = new Image(); decoded.src = result.image; await decoded.decode(); if (!alive) return; setImage(result.image); }
          sequence.current = mode === 'text' ? -1 : result.sequence; setEffectivePreview(result.preview || mode);
          const adaptive = autoPreview.current; adaptive.elapsed = elapsed; adaptive.samples.push(elapsed); if (adaptive.samples.length > 4) adaptive.samples.shift();
          if (adaptive.samples.length >= 2) {
            const average = adaptive.samples.reduce((sum, value) => sum + value, 0) / adaptive.samples.length;
            const next = previewForLink(average, innerWidth < 600, connectionHint());
            const rank = { low: 0, balanced: 1, full: 2, smooth: 3, text: 0 };
            if (next !== adaptive.mode && (rank[next] < rank[adaptive.mode] || Date.now() - adaptive.changedAt > 15000)) { adaptive.mode = next; adaptive.changedAt = Date.now(); }
          }
          setTabs(current => { const previous = current.find(t => t.id === result.tab.id); return JSON.stringify(previous) === JSON.stringify(result.tab) ? current : current.map(t => t.id === result.tab.id ? result.tab : t); });
        } catch (e: any) { if (alive && mode === 'smooth' && /invalid browser preview/.test(e.message)) oldServer = true; else if (alive) { setError(e.message); if (/tab not found|thread not found/i.test(e.message)) await refresh().catch(() => {}); } }
      }
      if (alive) timer = setTimeout(poll, document.hidden ? 2000 : previewDelay(mode, elapsed, held));
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); void call('unwatch', { tabId: chosen, viewer: viewer.current }).catch(() => {}); };
  }, [call, chosen, refresh, windowed]);
  // The page is as big as the live area below the nav bar, like a real
  // browser window. Sent on first view of a tab and after the panel settles
  // at a new size; this viewer's own last size is the yardstick, so two
  // viewers of different sizes never answer each other.
  const liveSize = () => {
    const box = panel.current, bar = nav.current;
    if (!box || !bar) return null;
    return { width: clamp(box.clientWidth, 240, 1920), height: clamp(box.getBoundingClientRect().bottom - bar.getBoundingClientRect().bottom, 200, 1200) };
  };
  useEffect(() => {
    const box = panel.current;
    if (!box || !chosen || latest.current?.engine !== 'chromium' || windowed) return;
    const fit = () => {
      const current = latest.current, size = liveSize();
      if (!current || !size || current.fit === false || current.control && current.control !== viewer.current) return;
      if (near(fitted.current.get(current.id) || current.viewport, size)) return;
      fitted.current.set(current.id, size);
      void call<{ tab: Tab }>('action', { tabId: current.id, viewer: viewer.current, action: { kind: 'fit', mode: 'panel', auto: true, ...size } })
        .then(result => setTabs(list => list.map(t => t.id === result.tab.id ? result.tab : t)), (e: any) => setError(e.message));
    };
    fit();
    const observer = new ResizeObserver(() => { clearTimeout(fitTimer.current); fitTimer.current = setTimeout(fit, 300); });
    observer.observe(box);
    return () => { observer.disconnect(); clearTimeout(fitTimer.current); };
  }, [call, chosen, !!tab, windowed]); // eslint-disable-line react-hooks/exhaustive-deps -- the tab is read fresh; a fit choice made elsewhere must not trigger a send here
  const size = (mode: 'panel' | 'phone' | 'desktop') => {
    const live = mode === 'panel' ? liveSize() : null;
    if (mode === 'panel' && !live) return;
    if (live) fitted.current.set(chosen, live);
    void action({ kind: 'fit', mode, ...(live || {}) });
  };
  const action = (value: Record<string, unknown>, epoch?: number) => {
    const controlEpoch = epoch ?? tab?.controlEpoch;
    if (value.kind === 'dialog') return call('action', { tabId: chosen, viewer: viewer.current, controlEpoch, action: value }).then(() => refresh()).catch((e: any) => setError(e.message));
    if (actionCount.current >= 64) { setError('Browser input is catching up. Wait before sending more.'); return Promise.resolve(); }
    if (!chosen) return Promise.resolve(); setError(''); actionCount.current++;
    // Sent at once, never behind the reply to the one before: the machine
    // keeps each tab's actions in order, and a slow link no longer turns
    // every key and click into a round trip of its own.
    const sent = call<{ tab?: Tab; text?: string; value?: unknown; entries?: unknown[] }>('action', { tabId: chosen, viewer: viewer.current, controlEpoch, action: value });
    actionQueue.current = actionQueue.current.catch(() => {}).then(async () => {
      try { const result = await sent; if (result.text) setPageText(result.text); if (result.value !== undefined) setPageText(JSON.stringify(result.value, null, 2)); if (result.entries) setPageText(JSON.stringify(result.entries, null, 2)); if (result.tab) setTabs(current => current.map(t => t.id === result.tab!.id ? result.tab! : t)); }
      catch (e: any) { setError(e.message); } finally { actionCount.current--; }
    });
    return actionQueue.current;
  };
  // Clicking or typing on the page is how the owner takes over; the agent
  // waits until they hand it back.
  const takeControl = () => {
    const current = latest.current;
    if (!current) return Promise.reject(new Error('Open a tab first.'));
    if (current.control === viewer.current) return Promise.resolve(current.controlEpoch);
    return taking.current ||= call<{ tab: Tab }>('control', { tabId: current.id, viewer: viewer.current, take: true })
      .then(result => { latest.current = result.tab; setTabs(list => list.map(t => t.id === result.tab.id ? result.tab : t)); return result.tab.controlEpoch; })
      .finally(() => { taking.current = null; });
  };
  // In a window the owner is at the page already: the panel's buttons just go.
  const act = (value: Record<string, unknown>) => latest.current?.window ? action(value) : takeControl().then(epoch => action(value, epoch), (e: any) => setError(/another viewer/.test(e.message) ? 'Someone else is using this tab right now.' : e.message));
  const handBack = async () => { try { const result = await call<{ tab: Tab }>('control', { tabId: chosen, viewer: viewer.current, take: false }); setTabs(current => current.map(t => t.id === chosen ? result.tab : t)); } catch (e: any) { setError(e.message); } };
  const flushTyped = () => { clearTimeout(typeTimer.current); typeTimer.current = undefined; const value = typed.current; typed.current = ''; if (value) void act({ kind: 'type', text: value }); };
  const flushWheel = () => { clearTimeout(wheelTimer.current); wheelTimer.current = undefined; const { dx, dy } = wheel.current; wheel.current = { dx: 0, dy: 0 }; if (dx || dy) void act({ kind: 'scroll', dx: Math.max(-20000, Math.min(20000, dx)), dy: Math.max(-20000, Math.min(20000, dy)) }); };
  const controlled = tab?.control === viewer.current, othersHave = !!tab?.control && !controlled, direct = tab?.engine === 'chromium';
  const download = async (downloadId: string) => { try { const result = await call<{ name: string; data: string }>('download', { tabId: chosen, downloadId }); const bytes = Uint8Array.from(atob(result.data), c => c.charCodeAt(0)), url = URL.createObjectURL(new Blob([bytes])); const a = document.createElement('a'); a.href = url; a.download = result.name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (e: any) { setError(e.message); } };
  const openTab = async (url?: string) => { setBusy(true); setError(''); try { const result = await call<{ tab: Tab }>('open', { engine, viewer: viewer.current, ...(url ? { url } : {}) }); await refresh(); setChosen(result.tab.id); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  const closeTab = async (id: string) => { try { await call('close', { tabId: id }); await refresh(); } catch (e: any) { setError(e.message); } };
  const at = (e: { clientX: number; clientY: number; currentTarget: Element }, view: { width: number; height: number }) => { const rect = e.currentTarget.getBoundingClientRect(); return { x: Math.min(view.width, Math.max(0, Math.floor((e.clientX - rect.left) * view.width / rect.width))), y: Math.min(view.height, Math.max(0, Math.floor((e.clientY - rect.top) * view.height / rect.height))) }; };
  const ready = tab?.downloads.filter(d => d.status === 'ready').length || 0;
  const frame = natural || tab?.viewport || { width: 1280, height: 800 };
  // On the page picture when there is one, so it sits where the eyes are.
  const controlState = controlled ? <div className="bp-pill" role="status">You’re in control<span aria-hidden="true">·</span><button onClick={() => void handBack()}>Hand back</button></div>
    : othersHave ? <div className="bp-pill" role="status">Someone else is in control</div>
    : direct && image && preview !== 'text' ? <div className="bp-hint" aria-hidden="true">Click, scroll or type to take over</div> : null;
  const sized = (width: number, height: number) => tab?.fit === false && tab.viewport.width === width && tab.viewport.height === height;
  return <section ref={panel} className="browser-panel" aria-label="Browser">
    <div className="bp-tabs" role="tablist" aria-label="Browser tabs">
      {tabs.map(t => <div className={`bp-tab${t.id === chosen ? ' selected' : ''}`} key={t.id}>
        <button role="tab" aria-selected={t.id === chosen} onClick={() => setChosen(t.id)} title={t.url}>{t.title || host(t.url) || 'New tab'}</button>
        {t.id === chosen && <button className="bp-tab-close" aria-label="Close browser tab" title="Close tab" disabled={busy} onClick={() => void closeTab(t.id)}><Icon name="close" size={12} /></button>}
      </div>)}
      <button className="bp-icon" aria-label="New tab" title="New tab" disabled={busy} onClick={() => void openTab()}><Icon name="plus" size={15} /></button>
      {onClose && <button className="bp-icon bp-close" aria-label="Close browser" title="Close browser (Ctrl/⌘ Shift B)" onClick={onClose}><Icon name="close" size={16} /></button>}
    </div>
    <div ref={nav} className="bp-nav">
      <button className="bp-icon" aria-label="Go back" title="Back" disabled={busy || !tab} onClick={() => void act({ kind: 'back' })}><Icon name="back" size={15} /></button>
      <button className="bp-icon" aria-label="Go forward" title="Forward" disabled={busy || !tab || tab.engine === 'bowser'} onClick={() => void act({ kind: 'forward' })}><Icon name="forward" size={15} /></button>
      {tab?.loading ? <button className="bp-icon" aria-label="Stop loading" title="Stop" onClick={() => void act({ kind: 'stop' })}><Icon name="close" size={15} /></button>
        : <button className="bp-icon" aria-label="Reload" title="Reload" disabled={busy || !tab} onClick={() => void act({ kind: 'reload' })}><Icon name="refresh" size={15} /></button>}
      {/* With no tab yet, the address opens one there. */}
      <form onSubmit={e => { e.preventDefault(); const url = address.trim(); if (!url) return; if (tab) void act({ kind: 'navigate', url }); else void openTab(url); screen.current?.focus(); }}><input aria-label="Browser address" value={address} onChange={e => setAddress(e.target.value)} onFocus={e => { typingAddress.current = true; e.currentTarget.select(); }} onBlur={() => { typingAddress.current = false; if (tab?.url) setAddress(tab.url === 'about:blank' ? '' : tab.url); }} placeholder="Search or type an address" spellCheck={false} autoCapitalize="off" enterKeyHint="go" autoFocus={!tab && innerWidth >= 600} /></form>
      {canWindow && !windowed && engine === 'chromium' && <button className="bp-icon" aria-label="Open in a window" title={`Open in a real window on ${env.name}`} disabled={busy} onClick={() => void toWindow(true)}><Icon name="popout" size={15} /></button>}
      <BrowserLogins key={`${env.id}:${session.id}`} client={client} env={env} session={session} />
      {tab && <button className={`bp-icon${tools ? ' on' : ''}`} aria-label="More browser tools" title="More tools" aria-expanded={tools} onClick={() => setTools(v => !v)}><Icon name="more" size={16} />{ready > 0 && <b className="bp-dot" aria-hidden="true" />}</button>}
      {tab?.loading && <span className="bp-loading" role="progressbar" aria-label="Loading page" />}
    </div>
    {tab ? <>
      <div className="bp-stage">
        {windowed && tab.window ? <div className="bp-window" role="status">
          <Icon name="popout" size={22} />
          <p>Open in a window on {env.name}.</p>
          <p className="note">You and the agent share its tabs. The agent waits while you click or type there.</p>
          <span><button onClick={() => void toWindow(true)} disabled={busy}>Show window</button><button onClick={() => void toWindow(false)} disabled={busy}>Bring back here</button></span>
        </div> : <div ref={screen} className={`browser-screen${controlled ? ' controlled' : ''}${direct ? ' direct' : ''}`} tabIndex={0} role="group" aria-label="Live browser page" onWheel={e => { if (othersHave || !controlled && !(direct && image)) return; flushTyped(); e.preventDefault(); wheel.current.dx += Math.round(e.deltaX); wheel.current.dy += Math.round(e.deltaY); if (!wheelTimer.current && !actionCount.current) flushWheel(); else if (!wheelTimer.current) wheelTimer.current = setTimeout(() => { wheelTimer.current = undefined; flushWheel(); }, 40); }} onKeyDown={e => {
          // Keys on the pill's own button (Hand back) belong to that button.
          if (e.nativeEvent.isComposing || isDockKey(e) || (e.target as HTMLElement).closest('button, input, select, textarea, a')) return;
          const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
          // Watching, Tab still moves focus on; only typing takes over.
          if (!controlled && !printable && !['Enter', 'Backspace'].includes(e.key)) return;
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { flushTyped(); return; }
          e.preventDefault(); flushWheel();
          if (printable) { typed.current += e.key; if (typed.current.length >= 1000 || !typeTimer.current && !actionCount.current) flushTyped(); else if (!typeTimer.current) typeTimer.current = setTimeout(() => { typeTimer.current = undefined; flushTyped(); }, 40); }
          else if (!['Shift', 'Control', 'Meta', 'Alt'].includes(e.key)) { flushTyped(); void act({ kind: 'key', key: [e.ctrlKey ? 'Control' : '', e.metaKey ? 'Meta' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : '', keys[e.key] || e.key].filter(Boolean).join('+') }); }
        }} onPaste={e => { flushTyped(); e.preventDefault(); void act({ kind: 'type', text: e.clipboardData.getData('text/plain') }); }}>
          {preview === 'text' ? <p className="note">Live picture is off. Open ⋯ and read the page as text.</p> : image ? <div className="bp-frame" style={{ '--fw': frame.width, '--fh': frame.height } as CSSProperties}>
            <img alt="Live browser page" src={image} draggable={false}
              onLoad={e => { const { naturalWidth: width, naturalHeight: height } = e.currentTarget; setNatural(n => n?.width === width && n.height === height ? n : { width, height }); }}
              onContextMenu={e => { if (!direct) return; e.preventDefault(); void act({ kind: 'click', button: 'right', ...at(e, tab.viewport) }); }}
              onPointerDown={e => { if (!direct || e.button !== 0) return; press.current = at(e, tab.viewport); e.currentTarget.setPointerCapture(e.pointerId); }}
              onPointerMove={e => { if (!controlled || actionCount.current > 0 || !direct || press.current || e.pointerType !== 'mouse' || Date.now() - hoverAt.current < 200) return; hoverAt.current = Date.now(); void action({ kind: 'hover', ...at(e, tab.viewport) }); }}
              onPointerUp={e => { if (!direct || e.button !== 0 || !press.current) return; const start = press.current, { x, y } = at(e, tab.viewport); press.current = null; screen.current?.focus(); if (tab.pointer?.by === 'guide') setDismissed(tab.pointer.seq); void act(Math.hypot(x - start.x, y - start.y) > 8 ? e.pointerType === 'touch' ? { kind: 'scroll', dx: start.x - x, dy: start.y - y } : { kind: 'drag', fromX: start.x, fromY: start.y, toX: x, toY: y } : { kind: 'click', x, y }); }}
              onPointerCancel={() => { press.current = null; }} />
            <BrowserPointer key={tab.id} pointer={tab.pointer} viewport={tab.viewport} dismissed={dismissed} />
            {controlState}
          </div> : <p className="note">Starting the live picture…</p>}
        </div>}
        {tab.problem && !tab.loading && <div className="bp-problem" role="alert"><p>{tab.problem.message}</p><button onClick={() => void act({ kind: 'navigate', url: tab.problem!.url })}>Try again</button></div>}
        {tab.dialog && <div className="bp-dialog" role="alertdialog" aria-label="Page message"><p>{tab.dialog.message}</p><span><button onClick={() => void takeControl().then(epoch => action({ kind: 'dialog', accept: false }, epoch), (e: any) => setError(e.message))}>Dismiss</button><button className="primary" onClick={() => void takeControl().then(epoch => action({ kind: 'dialog', accept: true, text: entry }, epoch), (e: any) => setError(e.message))}>OK</button></span></div>}
        {!(image && preview !== 'text') && controlState}
      </div>
      {tools && <div className="bp-drawer">
        <div className="bp-row">
          <button disabled={busy} onClick={() => void action({ kind: 'look' })}>Read page</button>
          <button disabled={busy} onClick={() => void action({ kind: 'console' })}>Console</button>
          <button disabled={busy} onClick={() => void action({ kind: 'network' })}>Network</button>
          {direct && <button disabled={busy} onClick={async () => { try { const epoch = await takeControl(); const result = await call<{ text: string }>('action', { tabId: chosen, viewer: viewer.current, controlEpoch: epoch, action: { kind: 'clipboard' } }); setPageText(result.text); if (navigator.clipboard) await navigator.clipboard.writeText(result.text); } catch (e: any) { setError(e.message); } }}>Copy page clipboard</button>}
        </div>
        {direct && !tab.window && <div className="bp-row" role="group" aria-label="Page size">
          <span>Page size</span>
          <button className="bp-choice" aria-pressed={tab.fit !== false} disabled={busy} onClick={() => size('panel')}>Fit to panel</button>
          <button className="bp-choice" aria-pressed={sized(390, 844)} disabled={busy} onClick={() => size('phone')}>Phone</button>
          <button className="bp-choice" aria-pressed={sized(1280, 800)} disabled={busy} onClick={() => size('desktop')}>Desktop</button>
        </div>}
        <div className="bp-row">
          <label>Picture <select aria-label="Browser preview quality" value={preview} onChange={e => setPreview(e.target.value as BrowserPreview | 'auto')}><option value="auto">Auto</option><option value="smooth">Smooth</option><option value="full">Full quality</option><option value="balanced">Balanced</option><option value="low">Low data</option><option value="text">Text only</option></select></label>
          {preview === 'auto' && effectivePreview === 'low' && <span className="note">Low data for this connection.</span>}
          {bowser && <label>New tabs use <select aria-label="Browser engine" value={engine} onChange={e => setEngine(e.target.value)}><option value="chromium">Isolated Chromium</option><option value="bowser">Bowser shared browser</option></select></label>}
        </div>
        <div className="bp-row bp-input"><input aria-label="Element number" value={target} onChange={e => setTarget(e.target.value)} placeholder="Element #" inputMode="numeric" /><input aria-label="Text to type into browser" value={entry} onChange={e => setEntry(e.target.value)} placeholder="Text to type" /><button disabled={busy || !entry} onClick={() => { void act({ kind: 'type', text: entry, ...(target ? { ref: Number(target) } : {}) }); setEntry(''); }}>Type</button><button disabled={busy || !target} onClick={() => void act({ kind: 'click', ref: Number(target) })}>Click #</button><label className="ctl">Upload<input type="file" hidden multiple onChange={async e => {
          const files = [...(e.target.files || [])]; e.target.value = ''; if (!files.length) return;
          if (!target) { setError('Read the page and enter its file input element number first.'); return; }
          if (files.length > 10 || files.reduce((sum, file) => sum + file.size, 0) > 8 * 1024 * 1024) { setError('Upload up to 10 files, 8 MiB total.'); return; }
          try { const uploads = await Promise.all(files.map(async file => { const bytes = new Uint8Array(await file.arrayBuffer()); let value = ''; for (let i = 0; i < bytes.length; i += 32768) value += String.fromCharCode(...bytes.subarray(i, i + 32768)); return { name: file.name, data: btoa(value) }; })); await act({ kind: 'upload', ref: Number(target), uploads }); } catch (e: any) { setError(e.message); }
        }} /></label></div>
        {tab.engine === 'bowser' && <p className="note">Bowser keeps its own browser and logins. Use Read page, then the element numbers here.</p>}
        {tab.downloads.length > 0 && <div className="bp-row">{tab.downloads.map(d => <button key={d.id} disabled={d.status !== 'ready'} onClick={() => void download(d.id)}>{d.name} · {d.status === 'ready' ? 'Save' : d.status}</button>)}</div>}
        {pageText && <pre className="browser-text">{pageText}</pre>}
      </div>}
    </> : <p className="note bp-empty">Open a tab to browse with your agent. The browser runs on {env.name}, so localhost reaches servers there.</p>}
    {error && <p role="alert" className="error bp-error" onClick={() => setError('')}>{plain(error)}</p>}
  </section>;
}
