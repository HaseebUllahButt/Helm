import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Client, Environment } from './client';
import { Icon } from './Icon';
import { openPrivateLink } from './privateLink';

interface Share { name: string; port: number; password: boolean; private?: boolean; url: string | null; createdAt: number; expiresAt?: number }

/** "ends in 2h 10m", or "kept" for a link that stays until stopped. */
const endsIn = (s: Share) => {
  if (!s.expiresAt) return 'kept until stopped';
  const mins = Math.max(1, Math.round((s.expiresAt - Date.now()) / 60_000));
  return mins >= 60 ? `ends in ${Math.floor(mins / 60)}h ${mins % 60}m` : `ends in ${mins} min`;
};

/**
 * Public links from this machine (`helm share`): something running on one
 * of its ports, opened by anyone with the address - through your VM, not a
 * third party. Each can have a password, or be private: only devices signed
 * in to this Helm get in. Stopping one ends it at once.
 */
export function PublicLinks({ client, env }: { client: Client; env: Environment }) {
  const [shares, setShares] = useState<Share[] | null>(null);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [port, setPort] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [members, setMembers] = useState(false);
  // An older machine would take "private" as an unknown word and make the
  // link public, so the switch is only offered where it is understood.
  const [canPrivate, setCanPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');

  const load = useCallback(() => {
    client.rpc<{ shares: Share[]; features?: string[] }>(env.id, 'share.list')
      .then((r) => { setShares(r.shares); setCanPrivate(!!r.features?.includes('private')); setError(''); })
      // A machine on an older Helm has no links to list.
      .catch((e) => { setShares([]); if (!/unknown|not supported|method/i.test(e.message)) setError(e.message); });
  }, [client, env.id]);
  useEffect(() => { if (env.online) load(); }, [env.online, load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await client.rpc(env.id, 'share.add', members
        ? { port: Number(port), name: name.trim() || undefined, private: true }
        : { port: Number(port), name: name.trim() || undefined, password: password || undefined });
      setAdding(false); setPort(''); setName(''); setPassword(''); setMembers(false);
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
  /**
   * A private link wants a pass from this device's Helm first. The window
   * opens now, while the tap still counts, and is cut off from this one so
   * the shared page cannot reach back into Helm.
   */
  const openPrivate = async (s: Share) => {
    const u = new URL(s.url!);
    const w = window.open('', '_blank');
    if (!w) { window.location.href = s.url!; return; }
    w.opener = null;
    try {
      openPrivateLink(await client.shareGrant({ name: s.name, host: u.hostname.slice(s.name.length + 1) }), w);
    } catch {
      // An older hub cannot give a pass; the link sends the browser through
      // the Helm app for one instead.
      w.location.href = s.url!;
    }
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
                <span className="rm">port {s.port}{s.private ? ' · only your Helm devices' : s.password ? ' · password' : ' · open to anyone with the link'} · {endsIn(s)}</span>
              </span>
              {s.url && <button className="ghost" onClick={() => copy(s.url!)}>{copied === s.url ? 'Copied' : 'Copy'}</button>}
              {s.url && s.private && <button className="iconbtn" onClick={() => void openPrivate(s)} aria-label={`Open ${s.name}`}><Icon name="forward" size={15} /></button>}
              {s.url && !s.private && <a className="iconbtn" href={s.url} target="_blank" rel="noreferrer" aria-label={`Open ${s.name}`}><Icon name="forward" size={15} /></a>}
              <button className="ghost danger-text" disabled={busy} onClick={() => void stop(s)}>Stop</button>
            </div>
          ))}
        </div>
      )}
      {adding ? (
        <form className="link-form" onSubmit={add}>
          <label>Port<input className="field" inputMode="numeric" placeholder="3000" value={port} autoFocus onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} /></label>
          <label>Name<input className="field" placeholder="optional, e.g. demo" value={name} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => setName(e.target.value.toLowerCase())} /></label>
          {canPrivate && (
            <button type="button" className="row toggle link-private" role="switch" aria-checked={members} onClick={() => setMembers(!members)}>
              <span className="grow">
                <span className="rt">Only my Helm devices</span>
                <span className="rm wrap">Opens only on phones and computers signed in to your Helm.</span>
              </span>
              <span className={`switch${members ? ' on' : ''}`}><i /></span>
            </button>
          )}
          {!members && <label>Password<input className="field" type="password" placeholder="optional" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} /></label>}
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
