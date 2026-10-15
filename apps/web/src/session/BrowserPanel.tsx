import { useCallback, useEffect, useRef, useState } from 'react';
import type { Client, Environment, Session } from '../client';
import BrowserLogins from './BrowserLogins';
import { Icon } from '../Icon';

type Tab = { id: string; engine: string; title: string; url: string; window?: boolean; asleep?: boolean; dialog: { type: string; message: string } | null; downloads: { id: string; name: string; status: string }[]; loading?: boolean; problem?: { url: string; message: string } | null };
type Listed = { tabs: Tab[]; canWindow?: boolean; open?: boolean };
const host = (url: string) => { try { const u = new URL(url); return ['about:', 'chrome:'].includes(u.protocol) ? '' : u.host; } catch { return url; } };

/**
 * The chat's browser. On a machine with a screen it is a real Chromium
 * window there, and this panel is its remote: the tabs, an address bar,
 * Show window. Without a screen the agent's browser is hidden, and the panel
 * shows its tabs and, as text, what the agent sees.
 */
export default function BrowserPanel({ client, env, session, onClose }: { client: Client; env: Environment; session: Session; onClose?: () => void }) {
  const [tabs, setTabs] = useState<Tab[]>([]), [chosen, setChosen] = useState(''), [address, setAddress] = useState('');
  const [canWindow, setCanWindow] = useState<boolean | null>(null), [open, setOpen] = useState(false);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [pageText, setPageText] = useState('');
  const viewer = useRef(''), typingAddress = useRef(false), shown = useRef(false);
  if (!viewer.current) viewer.current = [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
  const tab = tabs.find(t => t.id === chosen);
  // Whatever goes wrong is said in words: no terminal colour codes or call logs.
  const plain = (message: string) => message.replace(/\u001b\[[0-9;]*m/g, '').replace(/\s*Call log:[\s\S]*$/, '').replace(/^page\.\w+: /, '').trim();
  const call = useCallback(<T,>(method: string, params: Record<string, unknown> = {}) => client.rpc<T>(env.id, `browser.${method}`, { id: session.id, ...params }, 60000), [client, env.id, session.id]);
  const listed = useCallback((result: Listed) => {
    setTabs(result.tabs); setCanWindow(!!result.canWindow); setOpen(!!result.open);
    setChosen(current => result.tabs.some(t => t.id === current) ? current : result.tabs[0]?.id || '');
  }, []);
  const refresh = useCallback(async () => listed(await call<Listed>('list', { warm: true })), [call, listed]);
  // The window is used directly, so the list follows it: titles, new tabs, a closed window.
  useEffect(() => {
    void refresh().catch(e => setError(e.message));
    const timer = setInterval(() => { if (!document.hidden) void refresh().catch(() => {}); }, 2000);
    return () => clearInterval(timer);
  }, [refresh]);
  // The agent opened a tab here: list it and follow it.
  useEffect(() => client.on((id, kind, payload: any) => {
    if (id !== env.id || kind !== 'browser.tab' || payload?.id !== session.id) return;
    void refresh().then(() => { if (!payload.viewer) setChosen(payload.tabId); }).catch(() => {});
  }), [client, env.id, session.id, refresh]);
  useEffect(() => { if (!typingAddress.current) setAddress(!tab?.url || tab.url === 'about:blank' || tab.url.startsWith('chrome://') ? '' : tab.url); }, [chosen, tab?.url]);
  const show = useCallback(async (tabId?: string) => {
    setBusy(true); setError('');
    try { listed(await call<Listed>('show', tabId ? { tabId } : {})); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }, [call, listed]);
  // Opening the browser at a computer brings its window up. On a phone the
  // window would only appear on the other machine's screen, so it waits to be asked.
  useEffect(() => {
    if (!canWindow || shown.current || !matchMedia('(pointer: fine)').matches) return;
    shown.current = true; void show(chosen || undefined);
  }, [canWindow]); // eslint-disable-line react-hooks/exhaustive-deps -- once, when the machine says it has a screen
  const act = async (action: Record<string, unknown>, tabId = chosen) => {
    setError('');
    try {
      const result = await call<{ tab?: Tab; text?: string }>('action', { tabId, viewer: viewer.current, action });
      if (result.text) setPageText(result.text);
      if (result.tab) setTabs(current => current.map(t => t.id === result.tab!.id ? result.tab! : t));
    } catch (e: any) { setError(e.message); }
  };
  const openTab = async (url?: string) => {
    setBusy(true); setError('');
    try { const result = await call<{ tab: Tab }>('open', { viewer: viewer.current, ...(url ? { url } : {}) }); await refresh(); setChosen(result.tab.id); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const closeTab = async (id: string) => { try { await call('close', { tabId: id }); await refresh(); } catch (e: any) { setError(e.message); } };
  const download = async (downloadId: string) => { try { const result = await call<{ name: string; data: string }>('download', { tabId: chosen, downloadId }); const bytes = Uint8Array.from(atob(result.data), c => c.charCodeAt(0)), url = URL.createObjectURL(new Blob([bytes])); const a = document.createElement('a'); a.href = url; a.download = result.name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (e: any) { setError(e.message); } };
  return <section className="browser-panel" aria-label="Browser">
    <div className="bp-head">
      <strong>Browser</strong>
      <span className="note">{canWindow === null ? '' : canWindow ? `A Chromium window on ${env.name}` : `Hidden, on ${env.name}`}</span>
      {onClose && <button className="bp-icon bp-close" aria-label="Close browser" title="Close browser (Ctrl/⌘ Shift B)" onClick={onClose}><Icon name="close" size={16} /></button>}
    </div>
    <div className="bp-nav">
      <button className="bp-icon" aria-label="Go back" title="Back" disabled={!tab} onClick={() => void act({ kind: 'back' })}><Icon name="back" size={15} /></button>
      <button className="bp-icon" aria-label="Go forward" title="Forward" disabled={!tab || tab.engine === 'bowser'} onClick={() => void act({ kind: 'forward' })}><Icon name="forward" size={15} /></button>
      {tab?.loading ? <button className="bp-icon" aria-label="Stop loading" title="Stop" onClick={() => void act({ kind: 'stop' })}><Icon name="close" size={15} /></button>
        : <button className="bp-icon" aria-label="Reload" title="Reload" disabled={!tab} onClick={() => void act({ kind: 'reload' })}><Icon name="refresh" size={15} /></button>}
      {/* With no tab yet, the address opens one. */}
      <form onSubmit={e => { e.preventDefault(); const url = address.trim(); if (!url) return; (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.blur(); if (tab) void act({ kind: 'navigate', url }); else void openTab(url); }}><input aria-label="Browser address" value={address} onChange={e => setAddress(e.target.value)} onFocus={e => { typingAddress.current = true; e.currentTarget.select(); }} onBlur={() => { typingAddress.current = false; setAddress(!tab?.url || tab.url === 'about:blank' || tab.url.startsWith('chrome://') ? '' : tab.url); }} placeholder="Search or type an address" spellCheck={false} autoCapitalize="off" enterKeyHint="go" /></form>
      <BrowserLogins key={`${env.id}:${session.id}`} client={client} env={env} session={session} />
      {tab?.loading && <span className="bp-loading" role="progressbar" aria-label="Loading page" />}
    </div>
    <div className="bp-body">
      <div className="bp-row bp-actions">
        {canWindow && <button className="bp-primary" disabled={busy} onClick={() => void show(chosen || undefined)}>{open ? 'Show window' : 'Open window'}</button>}
        <button disabled={busy || canWindow === null} onClick={() => void openTab()}>New tab</button>
        {tab && <button disabled={busy} onClick={() => void act({ kind: 'look' })}>Read page</button>}
      </div>
      {tabs.length > 0 ? <ul className="bp-list" aria-label="Browser tabs">
        {tabs.map(t => <li key={t.id} className={`bp-item${t.id === chosen ? ' selected' : ''}`}>
          <button className="bp-item-main" aria-current={t.id === chosen} onClick={() => { setChosen(t.id); setPageText(''); if (canWindow && open) void show(t.id); }} title={t.url}>
            <span className="bp-item-title">{t.title || host(t.url) || 'New tab'}</span>
            <span className="bp-item-host">{t.loading ? 'Loading…' : t.asleep ? `${host(t.url) || 'New tab'} · asleep` : host(t.url)}</span>
          </button>
          <button className="bp-icon" aria-label={`Close ${t.title || host(t.url) || 'tab'}`} title="Close tab" onClick={() => void closeTab(t.id)}><Icon name="close" size={12} /></button>
        </li>)}
      </ul> : <p className="note bp-empty">{canWindow === false ? `No tabs yet. Agents on ${env.name} browse here, out of sight; localhost reaches servers there.` : `No tabs yet. The window opens on ${env.name}'s screen and never takes your keyboard; click it to use it.`}</p>}
      {tab?.problem && !tab.loading && <div className="bp-problem" role="alert"><p>{tab.problem.message}</p><button onClick={() => void act({ kind: 'navigate', url: tab.problem!.url })}>Try again</button></div>}
      {tab?.dialog && <div className="bp-dialog" role="alertdialog" aria-label="Page message"><p>{tab.dialog.message}</p><span><button onClick={() => void act({ kind: 'dialog', accept: false })}>Dismiss</button><button className="primary" onClick={() => void act({ kind: 'dialog', accept: true })}>OK</button></span></div>}
      {!!tab?.downloads.length && <div className="bp-row">{tab.downloads.map(d => <button key={d.id} disabled={d.status !== 'ready'} onClick={() => void download(d.id)}>{d.name} · {d.status === 'ready' ? 'Save' : d.status}</button>)}</div>}
      {pageText && <pre className="browser-text">{pageText}</pre>}
    </div>
    {error && <p role="alert" className="error bp-error" onClick={() => setError('')}>{plain(error)}</p>}
  </section>;
}
