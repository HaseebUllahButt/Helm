import { useRef, useState } from 'react';
import type { Client, Environment, Session } from '../client';
import { useDialog } from '../useDialog';
import { Icon } from '../Icon';

type Profile = { key: string; browser: string; browserName: string; directory: string; name: string; lastUsed: boolean; readable: boolean; reason?: string };
type Copied = { cookies: number; sites: number; failed: number; profile: string };

export default function BrowserLogins({ client, env, session }: { client: Client; env: Environment; session: Session }) {
  const [open, setOpen] = useState(false), [profiles, setProfiles] = useState<Profile[]>([]), [selected, setSelected] = useState(''), [defaultKey, setDefaultKey] = useState<string | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const button = useRef<HTMLButtonElement>(null), [position, setPosition] = useState({ left: 8, top: 8 });
  const close = () => { setOpen(false); button.current?.focus(); };
  const menu = useDialog(close, open);
  const call = <T,>(method: string, params: Record<string, unknown> = {}) => client.rpc<T>(env.id, `browser.${method}`, { id: session.id, ...params }, 60000);
  const load = async () => {
    const rect = button.current?.getBoundingClientRect(); if (rect) setPosition({ left: Math.max(8, Math.min(rect.left, innerWidth - 328)), top: Math.max(8, Math.min(rect.bottom + 6, innerHeight - 200)) });
    setOpen(true); setBusy(true); setError('');
    try {
      const [list, choice] = await Promise.all([call<{ profiles: Profile[] }>('profiles'), call<{ profileKey: string | null }>('loginDefault')]);
      setProfiles(list.profiles); setDefaultKey(choice.profileKey);
      setSelected(current => list.profiles.some(p => p.key === current) ? current : list.profiles.find(p => p.key === choice.profileKey && p.readable)?.key || list.profiles.find(p => p.readable && p.lastUsed)?.key || list.profiles.find(p => p.readable)?.key || '');
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const copy = async (all = false) => {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await call<Copied>('importLogins', { profileKey: selected });
      setMessage(`Copied logins for ${result.sites} ${result.sites === 1 ? 'site' : 'sites'}.${result.failed ? ` ${result.failed} cookies could not be copied.` : ''}`);
      if (all) { const choice = await call<{ profileKey: string | null }>('loginDefault', { profileKey: selected }); setDefaultKey(choice.profileKey); }
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const browsers = [...new Set(profiles.map(p => p.browser))];
  return <div style={{ position: 'relative' }}>
    <button ref={button} className={`bp-icon${open ? ' on' : ''}`} aria-label="Logins" title="Copy logins from your browser" aria-expanded={open} aria-haspopup="dialog" onClick={() => open ? close() : void load()}><Icon name="key" size={15} /></button>
    {open && <div ref={menu} role="dialog" aria-modal="true" aria-label="Browser logins" style={{ position: 'fixed', top: position.top, left: position.left, zIndex: 80, maxHeight: `calc(100dvh - ${position.top + 8}px)`, overflowY: 'auto', boxSizing: 'border-box', width: 'min(320px, calc(100vw - 32px))', padding: 12, borderRadius: 8, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--text)', boxShadow: '0 6px 24px #0004' }}>
      <p style={{ marginTop: 0 }}>Copy logins from a browser on {env.name}.</p>
      {profiles.length ? <select aria-label="Login profile" value={selected} disabled={busy} style={{ width: '100%' }} onChange={e => { setSelected(e.target.value); setMessage(''); }}>
        {!selected && <option value="">Choose a profile</option>}
        {browsers.map(browser => <optgroup key={browser} label={profiles.find(p => p.browser === browser)!.browserName}>{profiles.filter(p => p.browser === browser).map(p => <option key={p.key} value={p.key} disabled={!p.readable}>{p.name} ({p.directory}){p.lastUsed ? ' · Last used' : ''}</option>)}</optgroup>)}
      </select> : <p>{busy ? 'Finding profiles…' : 'No browser profiles found on this machine.'}</p>}
      {profiles.some(p => !p.readable) && <p className="note">{profiles.find(p => !p.readable)?.reason}</p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
        <button disabled={busy || !selected} onClick={() => void copy()}>Use in this chat</button>
        <button disabled={busy || !selected} onClick={() => void copy(true)}>Use for all new chats</button>
        <button disabled={busy || !selected} onClick={() => void copy()}>Refresh</button>
      </div>
      {defaultKey && <p className="note">New chats use {profiles.find(p => p.key === defaultKey)?.name || 'the saved profile'}. <button disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await call('loginDefault', { profileKey: null }); setDefaultKey(null); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }}>Clear default</button></p>}
      {message && <p role="status">{message}</p>}{error && <p role="alert" className="error">{error}</p>}
      <button onClick={close}>Close</button>
    </div>}
  </div>;
}
