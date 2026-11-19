import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { errorMessage } from './errors';
import { sharedKeyPacket } from './sharedKeyPacket';
import { type Client, type Environment } from './client';

type SharedKey = { name: string; machines: string[]; lastUse: number | null };
type Grant = { id: string; name: string; chat: string; title?: string; machine: string };
type KeyList = { keys: SharedKey[]; grants: Grant[] };

export function SharedKeys({ client, envs }: { client: Client; envs: Environment[] }) {
  const env = envs.find(machine => machine.online && machine.info.sharedKeys)?.id;
  const [info, setInfo] = useState<KeyList | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (env) setInfo(await client.rpc<KeyList>(env, 'keys.list', {}));
  }, [client, env]);
  useEffect(() => {
    setInfo(null);
    setError('');
    void load().catch(problem => setError(errorMessage(problem)));
  }, [load]);

  const cancel = () => {
    setAdding(false);
    setName('');
    setValue('');
  };
  const act = async (method: string, params: Record<string, string> = {}) => {
    if (!env || busy) return;
    setBusy(true);
    setError('');
    try {
      if (method === 'keys.set') {
        const { publicKey } = await client.rpc<{ publicKey: string }>(env, 'keys.public', {});
        let sealed;
        try { sealed = await sharedKeyPacket(name, value, publicKey); }
        catch { throw new Error('This browser could not encrypt the key. Use helm keys set in your terminal.'); }
        await client.rpc(env, method, { name, sealed });
        cancel();
      } else if (method !== 'refresh') await client.rpc(env, method, params);
      await load();
    } catch (problem) { setError(errorMessage(problem)); }
    finally { setBusy(false); }
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (name && value) void act('keys.set');
  };

  return (
    <section className="admin-password" aria-label="Shared keys">
      <div className="section">Shared keys</div>
      {!env && <p className="note">Connect a machine that supports shared keys.</p>}
      {env && !info && !error && <p className="note">Reading shared keys…</p>}
      {info && !info.keys.length && <p className="note">No shared keys.</p>}
      {info && !!info.keys.length && (
        <div className="rows">
          {info.keys.map(key => (
            <div className="row tall" key={key.name}>
              <span className="grow">
                <span className="rt">{key.name}</span>
                <span className="rm">{key.lastUse ? `Used on ${key.machines.join(', ')}. Last used ${new Date(key.lastUse).toLocaleString()}.` : 'Unused'}</span>
              </span>
              <button type="button" className="ghost" aria-label={`Remove key ${key.name}`} disabled={busy || !env}
                onClick={() => void act('keys.remove', { name: key.name })}>Remove</button>
            </div>
          ))}
        </div>
      )}
      {env && (adding ? (
        <form onSubmit={save} autoComplete="off">
          <input className="field" aria-label="Key name" value={name} disabled={busy}
            pattern="[A-Za-z_][A-Za-z0-9_]{0,127}" placeholder="Key name" onChange={event => setName(event.target.value)} />
          <input className="field" type="password" aria-label="Key value" maxLength={8192} value={value} disabled={busy}
            autoComplete="new-password" placeholder="Key value" onChange={event => setValue(event.target.value)} />
          <button className="primary big" disabled={busy || !name || !value}>{info?.keys.some(key => key.name === name) ? 'Replace key' : 'Save key'}</button>
          <button type="button" className="ghost" disabled={busy} onClick={cancel}>Cancel</button>
        </form>
      ) : <div>
        <button className="ghost" disabled={busy} onClick={() => setAdding(true)}>Add key</button>
        <button className="ghost" disabled={busy} onClick={() => void act('refresh')}>Refresh keys</button>
      </div>)}
      {info && !!info.grants.length && (
        <>
          <div className="section">Chats with access</div>
          <div className="rows">
            {info.grants.map(grant => (
              <div className="row tall" key={grant.id}>
                <span className="grow">
                  <span className="rt">{grant.name}</span>
                  <span className="rm">{grant.title || grant.chat} · {grant.machine}</span>
                </span>
                <button type="button" className="ghost" aria-label={`Remove access to ${grant.name} for ${grant.title || grant.chat}`}
                  disabled={busy || !env} onClick={() => void act('keys.revoke', { id: grant.id })}>Remove access</button>
              </div>
            ))}
          </div>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
