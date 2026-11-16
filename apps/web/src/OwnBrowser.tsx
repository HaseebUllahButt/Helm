import { errorMessage } from './errors';
import { useCallback, useEffect, useState } from 'react';
import type { Client, Environment } from './client';
import { useLiveInterval } from './useLiveInterval';

/** What the machine says about the owner's browser (browser.setup). */
interface BrowserState {
  state: 'connected' | 'off' | 'next-start' | 'closed' | 'one-step' | 'none' | 'no-screen';
  browsers?: { name: string; selected: boolean }[];
  browser?: string | null;
  steps?: string[];
  copied?: boolean;
  opened?: boolean;
}

/**
 * Agents use the owner's own browser, signed in as the owner, through Helm's
 * add-on. Most browsers get it on their own; Google Chrome and Edge need one
 * step from the owner, started here. A machine with no screen shows nothing.
 */
export function OwnBrowser({ client, env }: { client: Client; env: Environment }) {
  const [info, setInfo] = useState<BrowserState | null>(null);
  const [steps, setSteps] = useState<string[] | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    client.rpc<BrowserState>(env.id, 'browser.setup', {})
      .then((r) => { setInfo(r); if (r.state === 'connected') setSteps(null); })
      // A machine on an older Helm has no such row.
      .catch(() => setInfo({ state: 'no-screen' }));
  }, [client, env.id]);
  useEffect(() => { if (env.online) load(); }, [env.online, load]);
  // While the owner sets it up, the row turns to connected by itself.
  useLiveInterval(info && info.state !== 'connected' && info.state !== 'off' && info.state !== 'no-screen' ? 3000 : null, load, [load]);

  const act = async (what: string, params: Record<string, unknown>) => {
    setBusy(what); setError('');
    try {
      const r = await client.rpc<BrowserState>(env.id, 'browser.setup', params, 60_000);
      setInfo(r);
      if (what === 'main') setSteps(null);
      if (what === 'open' && r.state !== 'connected') setSteps(r.steps ?? []);
    } catch (e: any) { setError(errorMessage(e)); }
    finally { setBusy(''); }
  };

  if (!env.online || !info || info.state === 'no-screen') return null;
  const name = info.browser || 'your browser';
  const text: Record<BrowserState['state'], [string, string]> = {
    connected: [name, 'Agents use your browser, signed in as you.'],
    off: ['Helm\'s window', 'Agents use Helm\'s own browser window.'],
    'next-start': [name, `Agents can use ${name} after it starts again. Until then they use Helm's window.`],
    closed: [name, `Helm starts ${name} when an agent needs it.`],
    'one-step': [name, `${name} needs one step from you. Until then agents use Helm's window.`],
    none: ['No browser', 'Helm found no Chromium-based browser on this machine.'],
    'no-screen': ['', ''],
  };
  const [title, hint] = text[info.state];

  return (
    <div className="own-browser">
      <div className="section">Your browser</div>
      {!!info.browsers?.length && (
        <label className="row">
          <span style={{ whiteSpace: 'nowrap' }}>Main browser</span>
          <select style={{ width: '65%', minWidth: 0 }} aria-label="Main browser" disabled={!!busy} value={info.browser || ''}
            onChange={event => void act('main', { do: 'main', name: event.target.value })}>
            {info.browsers.map(browser => <option key={browser.name} value={browser.name}>{browser.name}</option>)}
          </select>
        </label>
      )}
      <div className="rows">
        <div className="row tall">
          <span className="grow">
            <span className="rt">{title}{info.state === 'connected' && <span className="tag key">connected</span>}</span>
            <span className="rm">{hint}</span>
          </span>
          {info.state === 'next-start' && (
            <button className="ghost" disabled={!!busy} onClick={() => void act('restart', { do: 'restart' })}>
              {busy === 'restart' ? 'Restarting' : 'Restart now'}
            </button>
          )}
          {info.state === 'one-step' && (
            <button className="primary" disabled={!!busy} onClick={() => void act('open', { do: 'open' })}>
              {busy === 'open' ? 'Opening' : steps ? 'Open again' : 'Set up'}
            </button>
          )}
          {info.state === 'off' && (
            <button className="ghost" disabled={!!busy} onClick={() => void act('mode', { do: 'mode', mode: 'extended' })}>Use my browser</button>
          )}
          {info.state === 'connected' && (
            <button className="ghost" disabled={!!busy} onClick={() => void act('mode', { do: 'mode', mode: 'window' })}>Turn off</button>
          )}
        </div>
      </div>
      {info.state === 'next-start' && <p className="note">Restart closes {name} and opens it again. Your tabs come back.</p>}
      {steps && info.state === 'one-step' && (
        <div className="note">
          {info.opened !== false && `Helm opened the add-ons page in ${name} on ${env.name}. `}
          {info.copied !== false && 'Helm copied the folder to paste. '}
          Then:
          <ol>{steps.map((s) => <li key={s}>{s}</li>)}</ol>
          This row shows connected when it works.
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
