import { errorMessage } from './errors';
import { useState, type FormEvent } from 'react';
import type { Client, Environment } from './client';
import { Icon } from './Icon';
import { keepVoice } from './session/voice';

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
    ? `Dictation uses ${withKey.map((e) => e.name).join(', ')}.`
    : 'Add a key to show the microphone.';

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
          const message = err?.message || 'Helm cannot save the key.';
          if (!saved.length && /accept|look like/.test(message)) throw new Error(message);
          failed.push(`${env.name} (${/unknown method|not supported/i.test(message) ? 'needs a Helm update' : errorMessage(err)})`);
        }
      }
      if (!saved.length) throw new Error(failed.length ? `Helm cannot save the key: ${failed.join(', ')}` : 'No machine is online to save the key.');
      // This device called Groq with the old key; the next dictation asks for the new one.
      keepVoice(null);
      onSaved(saved);
      const names = online.filter((env) => saved.includes(env.id)).map((env) => env.name);
      const off = envs.filter((env) => !env.online).map((env) => env.name);
      setResult([
        `Helm saved the key on ${names.join(', ')}.`,
        failed.length ? `Helm did not save the key on ${failed.join(', ')}.` : '',
        off.length ? `${off.join(', ')} ${off.length === 1 ? 'is' : 'are'} offline. Dictation will use the other machines.` : '',
      ].filter(Boolean).join(' '));
      setKey(''); setAdding(false);
    } catch (err: any) {
      setError(errorMessage(err, { fallback: 'Helm cannot save the key.' }));
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
            {/* Plain text, not a password field: hidden fields make the
                browser offer to save a password, which is a web page's question. */}
            <input className="field" type="text" placeholder="gsk_…" value={key} autoFocus
                   autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} data-1p-ignore
                   onChange={(e) => setKey(e.target.value)} />
          </label>
          <p className="note" style={{ margin: 0 }}>
            Get a key at console.groq.com/keys. Your machines save the key. This device does not save it.
          </p>
          <div className="link-actions">
            <button type="button" className="ghost" onClick={() => { setAdding(false); setKey(''); setError(''); }}>Cancel</button>
            <button className="primary" disabled={busy || !key.trim() || !online.length}>
              {busy ? 'Helm is checking the key.' : <><Icon name="check" size={14} /> Save</>}
            </button>
          </div>
        </form>
      )}
      {result && <p className="note">{result}</p>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
