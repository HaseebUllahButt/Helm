import { useState, type FormEvent } from 'react';
import type { Client, Environment } from './client';
import { Icon } from './Icon';

/**
 * The Groq key dictation runs on. Pasted once here, checked with Groq, and
 * kept on every machine that is on - so the microphone works whichever of
 * them is awake. A machine without it still dictates through one with it.
 */
export function DictationKey({ client, envs, onSaved }: {
  client: Client; envs: Environment[]; onSaved: (envIds: string[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');

  const online = envs.filter((e) => e.online);
  const withKey = envs.filter((e) => e.info.voice);
  const status = withKey.length
    ? `Works through ${withKey.map((e) => e.name).join(', ')}`
    : 'No machine has a key yet, so the microphone is hidden';

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(''); setResult('');
    const saved: string[] = [];
    const failed: string[] = [];
    try {
      // The first machine checks the key with Groq; a bad key stops there
      // rather than failing the same way on every machine.
      for (const env of online) {
        try {
          await client.rpc(env.id, 'voice.key', { key: key.trim() }, 30_000);
          saved.push(env.id);
        } catch (err: any) {
          const message = err?.message || 'could not save it';
          if (!saved.length && /accept|look like/.test(message)) throw new Error(message);
          failed.push(`${env.name} (${/unknown method|not supported/i.test(message) ? 'needs a Helm update' : message})`);
        }
      }
      if (!saved.length) throw new Error(failed.length ? `Could not save it: ${failed.join(', ')}` : 'No machine is on to keep it');
      onSaved(saved);
      const names = online.filter((env) => saved.includes(env.id)).map((env) => env.name);
      const off = envs.filter((env) => !env.online).map((env) => env.name);
      setResult([
        `Saved on ${names.join(', ')}.`,
        failed.length ? `Not on ${failed.join(', ')}.` : '',
        off.length ? `${off.join(', ')} ${off.length === 1 ? 'is' : 'are'} off; ${off.length === 1 ? 'it' : 'they'} will dictate through the others.` : '',
      ].filter(Boolean).join(' '));
      setKey(''); setAdding(false);
    } catch (err: any) {
      setError(err?.message || 'could not save the key');
    } finally { setBusy(false); }
  };

  return (
    <div className="links">
      <div className="rows">
        <div className="row tall">
          <span className="grow">
            <span className="rt">Dictation key</span>
            <span className="rm">{status}</span>
          </span>
          {!adding && (
            <button className="ghost" style={{ width: 'auto', margin: 0 }} onClick={() => { setAdding(true); setResult(''); }}>
              {withKey.length ? 'Change' : 'Add'}
            </button>
          )}
        </div>
      </div>
      {adding && (
        <form className="link-form" onSubmit={save}>
          <label>Groq key
            <input className="field" type="password" placeholder="gsk_…" value={key} autoFocus
                   autoComplete="off" spellCheck={false} onChange={(e) => setKey(e.target.value)} />
          </label>
          <p className="note" style={{ margin: 0 }}>
            Get one at console.groq.com/keys. It is checked with Groq, then kept on each of your machines - never on this device.
          </p>
          <div className="link-actions">
            <button type="button" className="ghost" onClick={() => { setAdding(false); setKey(''); setError(''); }}>Cancel</button>
            <button className="primary" disabled={busy || !key.trim() || !online.length}>
              {busy ? 'Checking…' : <><Icon name="check" size={14} /> Save</>}
            </button>
          </div>
        </form>
      )}
      {result && <p className="note">{result}</p>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
