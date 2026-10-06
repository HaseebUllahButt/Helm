import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Client, Environment } from './client';
import { Icon } from './Icon';

interface Share { name: string; port: number; password: boolean; url: string | null; createdAt: number }

/**
 * Public links from this machine (`helm share`): something running on one
 * of its ports, opened by anyone with the address - through your VM, not a
 * third party. Each can have a password; stopping one ends it at once.
 */
export function PublicLinks({ client, env }: { client: Client; env: Environment }) {
  const [shares, setShares] = useState<Share[] | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [port, setPort] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');

  const load = useCallback(() => {
    client.rpc<{ shares: Share[] }>(env.id, 'share.list')
      .then((r) => { setShares(r.shares); setError(''); })
      // A machine on an older Helm has no links to list.
      .catch((e) => { setShares([]); if (!/unknown|not supported|method/i.test(e.message)) setError(e.message); });
  }, [client, env.id]);
  useEffect(() => { if (env.online) load(); }, [env.online, load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await client.rpc(env.id, 'share.add', { port: Number(port), name: name.trim() || undefined, password: password || undefined });
      setAdding(false); setPort(''); setName(''); setPassword('');
      load();
    } catch (err: any) { setError(err.message); }
    finally { setBusy(false); }
  };
  const stop = async (s: Share) => {
    setBusy(true); setError('');
    try { await client.rpc(env.id, 'share.remove', { name: s.name }); load(); }
    catch (err: any) { setError(err.message); }
    finally { setBusy(false); }
  };
  const copy = (url: string) => {
    void navigator.clipboard?.writeText(url).then(() => { setCopied(url); setTimeout(() => setCopied(''), 1500); });
  };

  if (!env.online) return <div className="empty quiet">{env.name} is offline</div>;
  return (
    <div className="links">
      {shares === null && <div className="empty quiet">looking…</div>}
      {shares?.length === 0 && !adding && <div className="empty quiet">Nothing shared from {env.name}.</div>}
      {!!shares?.length && (
        <div className="rows">
          {shares.map((s) => (
            <div key={s.name} className="row tall link-row">
              <span className="grow">
                <span className="rt">{s.url ? s.url.replace(/^https:\/\//, '') : s.name}</span>
                <span className="rm">port {s.port}{s.password ? ' · password' : ' · open to anyone with the link'}</span>
              </span>
              {s.url && <button className="ghost" onClick={() => copy(s.url!)}>{copied === s.url ? 'Copied' : 'Copy'}</button>}
              {s.url && <a className="iconbtn" href={s.url} target="_blank" rel="noreferrer" aria-label={`Open ${s.name}`}><Icon name="forward" size={15} /></a>}
              <button className="ghost danger-text" disabled={busy} onClick={() => void stop(s)}>Stop</button>
            </div>
          ))}
        </div>
      )}
      {adding ? (
        <form className="link-form" onSubmit={add}>
          <label>Port<input className="field" inputMode="numeric" placeholder="3000" value={port} autoFocus onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} /></label>
          <label>Name<input className="field" placeholder="optional, e.g. demo" value={name} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => setName(e.target.value.toLowerCase())} /></label>
          <label>Password<input className="field" type="password" placeholder="optional" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} /></label>
          <div className="link-actions">
            <button type="button" className="ghost" onClick={() => setAdding(false)}>Cancel</button>
            <button className="primary" disabled={busy || !port}>{busy ? 'Sharing…' : 'Share'}</button>
          </div>
        </form>
      ) : (
        <button className="ghost link-add" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Share a port</button>
      )}
      {shares?.some((s) => !s.url) && <p className="note">No machine in your network has a public address yet, so these links cannot be opened from outside.</p>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
