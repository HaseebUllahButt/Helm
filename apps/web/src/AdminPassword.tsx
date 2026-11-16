import { errorMessage } from './errors';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Client, Environment } from './client';

/** What the machine says about its admin password (sudo.setup). Never the password. */
interface AdminState {
  supported?: boolean;
  saved?: boolean;
  needsPassword?: boolean | null;
  root?: boolean;
  allows?: { id: string; title: string | null; until: number }[];
}

/**
 * The admin password of one machine, for `helm sudo`: agents ask to run a
 * command as admin, the owner allows each one on a card, and Helm types
 * this password for them. The machine checks it with sudo before it saves
 * it, sealed on that machine only. A machine on an older Helm, or with no
 * sudo, shows nothing.
 */
export function AdminPassword({ client, env }: { client: Client; env: Environment }) {
  const [info, setInfo] = useState<AdminState | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState('');
  const [done, setDone] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    client.rpc<AdminState>(env.id, 'sudo.setup', { do: 'status' })
      .then(setInfo)
      .catch(() => setInfo({ supported: false }));
  }, [client, env.id]);
  useEffect(() => { if (env.online) load(); }, [env.online, load]);

  const act = async (what: 'save' | 'forget' | 'stop', params: Record<string, unknown>) => {
    setBusy(what); setError(''); setDone('');
    try {
      const r = await client.rpc<AdminState>(env.id, 'sudo.setup', { do: what, ...params }, 30_000);
      setInfo(r);
      setPassword('');
      setDone(what === 'save' ? 'Saved. sudo accepted the password.' : what === 'forget' ? 'Forgotten.' : 'Ended.');
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(''); }
  };
  const save = (e: FormEvent) => { e.preventDefault(); if (password) void act('save', { password }); };

  if (!env.online || !info || info.supported === false) return null;
  const status = info.root ? 'Helm runs as root here. Admin commands need no password.'
    : info.needsPassword === false ? 'sudo needs no password here.'
    : info.saved ? 'A password is saved on this machine.'
    : 'No password is saved. Agents cannot run admin commands here.';

  return (
    <div className="admin-password">
      <div className="section">Admin password</div>
      <div className="rows">
        <div className="row tall">
          <span className="grow">
            <span className="rt">{info.saved ? 'Saved' : 'Not saved'}</span>
            <span className="rm">{status}</span>
          </span>
          {info.saved && (
            <button className="ghost" disabled={!!busy} onClick={() => void act('forget', {})}>
              {busy === 'forget' ? 'Forgetting' : 'Forget'}
            </button>
          )}
        </div>
      </div>
      {!info.root && (
        <form onSubmit={save}>
          <input
            className="field" type="password" value={password} disabled={!!busy}
            autoComplete="new-password" aria-label={`Admin password for ${env.name}`}
            placeholder={info.saved ? 'New password' : `Password of your user on ${env.name}`}
            onChange={(e) => { setPassword(e.target.value); setDone(''); setError(''); }}
          />
          <button className="primary big" disabled={!!busy || !password}>
            {busy === 'save' ? 'Checking' : info.saved ? 'Replace password' : 'Save password'}
          </button>
        </form>
      )}
      {!!info.allows?.length && (
        <div className="rows">
          {info.allows.map((a) => (
            <div key={a.id} className="row tall">
              <span className="grow">
                <span className="rt">{a.title || 'A chat'}</span>
                <span className="rm">Runs admin commands with no card until {new Date(a.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</span>
              </span>
              <button className="ghost" disabled={!!busy} onClick={() => void act('stop', { sessionId: a.id })}>End</button>
            </div>
          ))}
        </div>
      )}
      <p className="note">
        {done || 'Agents ask to run a command as admin. You allow each one on a card. Helm types this password for them; they never see it. It stays on this machine, encrypted.'}
      </p>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
