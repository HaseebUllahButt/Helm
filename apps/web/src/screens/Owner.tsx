import { errorMessage } from '../errors';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BackIcon, Icon } from '../Icon';
import type { Client, Environment } from '../client';
import { ago } from './common';

/** The owner's preferences as every machine holds them (protocol/owner.js). */
type OwnerRecord = {
  lines: string[]; keeper: boolean; updatedAt: number; by: 'seed' | 'owner' | 'keeper';
  where?: string; why?: string; learned?: { at: number; added: string[]; removed: string[] };
};
type KeeperStatus = {
  machine: string | null; name: string | null; here: boolean; on: boolean; running: boolean;
  lastRunAt?: number | null; result?: string | null;
};
type OwnerState = { record: OwnerRecord; keeper: KeeperStatus };

const changed = (r: OwnerRecord) => r.by === 'seed' ? `${r.why ?? 'Helm set this list'}.`
  : `${r.by === 'owner' ? 'You' : 'Helm'} changed this list ${ago(r.updatedAt)}${r.where ? ` on ${r.where}` : ''}${r.why ? `. ${r.why}.` : '.'}`;

const lastRun = (k: KeeperStatus) => {
  if (k.running) return 'Reading new chats now…';
  if (!k.here) return k.name ? `Runs on ${k.name}. That machine is offline.` : 'No machines are available.';
  if (!k.lastRunAt) return 'Helm has not read your chats yet.';
  const r = k.result ?? '';
  const what = r === 'nothing new' ? 'no new chats' : r === 'no change' ? 'nothing to change'
    : r === 'changed' ? 'it changed the list' : r.startsWith('failed: ') ? `it failed: ${r.slice(8)}` : r;
  return `Last run ${ago(k.lastRunAt)}: ${what}`;
};

/**
 * The owner's preferences: one short list Helm gives every agent it starts,
 * on every machine. The owner edits it here; the keeper also updates it
 * once a day from what the owner says in chats.
 *
 * The list is the same on every machine, so any machine that is on answers.
 * The keeper's last run is known only on its own machine, so that machine
 * is asked when it is on.
 */
export function OwnerView({ client, envs, onBack }: { client: Client; envs: Environment[]; onBack: () => void }) {
  const [state, setState] = useState<OwnerState | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  // The box grows with the list, so every line reads whole on a phone.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [text, !!state]);
  const online = envs.filter((e) => e.online);
  const onlineKey = online.map((e) => e.id).join(',');

  const target = useCallback((keeper?: KeeperStatus | null) =>
    online.find((e) => e.id === keeper?.machine) ?? online[0], [onlineKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // A newer list (the keeper's, another device's) replaces the box unless
  // the owner has an edit of their own in it.
  const shown = useRef('');
  const take = (next: OwnerState, keepText = false) => {
    // Read again every few seconds while the keeper runs: the same list draws nothing.
    setState((was) => was && JSON.stringify(was) === JSON.stringify(next) ? was : next);
    const lines = next.record.lines.join('\n');
    const before = shown.current;
    shown.current = lines;
    setText((current) => (keepText && current !== before ? current : lines));
  };

  const load = useCallback(async (keepText = false) => {
    const first = target(state?.keeper);
    if (!first) return;
    try {
      let next = await client.rpc<OwnerState>(first.id, 'owner.get', {});
      const keeper = target(next.keeper);
      if (keeper && keeper.id !== first.id) next = await client.rpc<OwnerState>(keeper.id, 'owner.get', {});
      take(next, keepText);
      setError('');
    } catch (err: any) {
      setError(/unknown method/i.test(err?.message ?? '') ? 'Update Helm on this machine first.' : errorMessage(err, { fallback: 'Helm cannot read the list.' }));
    }
  }, [client, target, state?.keeper?.machine]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { void load(); }, [client, onlineKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // While the keeper reads, look again every few seconds.
  useEffect(() => {
    if (!state?.keeper.running) return;
    let reading = false;
    const timer = setInterval(() => {
      if (reading || document.hidden) return;
      reading = true;
      void load(true).finally(() => { reading = false; });
    }, 3000);
    return () => clearInterval(timer);
  }, [state?.keeper.running, load]);

  const call = async (method: string, params: Record<string, unknown>) => {
    const env = target(state?.keeper);
    if (!env) { setError('No machines are online.'); return; }
    setBusy(true); setError('');
    try { take(await client.rpc<OwnerState>(env.id, method, params), method !== 'owner.set' || params.lines === undefined); }
    catch (err: any) { setError(errorMessage(err, { fallback: 'Helm cannot save the list.' })); }
    finally { setBusy(false); }
  };

  const record = state?.record;
  const keeper = state?.keeper;
  const dirty = !!record && text.split('\n').map((l) => l.trim()).filter(Boolean).join('\n') !== record.lines.join('\n');

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <div className="titles"><h1>Your preferences</h1><span className="sub">every chat, every machine</span></div>
      </div>
      <div className="scroll"><div className="pad column">
        <p className="note">Helm gives this list to every agent it starts. Write one short preference on each line.</p>
        {!online.length && <div className="empty quiet">No machines are online.</div>}
        {online.length > 0 && !record && !error && <div className="empty quiet">Reading the list…</div>}
        {record && (
          <div className="owner-list">
            <textarea ref={box} className="owner-lines" aria-label="Your preferences, one on each line" rows={4}
              value={text} onChange={(e) => setText(e.target.value)} placeholder="Plain English, short replies" spellCheck />
            <div className="owner-foot">
              <span className="note">{changed(record)}</span>
              {dirty && (
                <span className="link-actions">
                  <button className="ghost" disabled={busy} onClick={() => setText(record.lines.join('\n'))}>Undo</button>
                  <button className="primary" disabled={busy} onClick={() => call('owner.set', { lines: text.split('\n') })}>
                    <Icon name="check" size={14} /> Save
                  </button>
                </span>
              )}
            </div>
          </div>
        )}

        {record && keeper && (
          <>
            <div className="section">Preference updates</div>
            <div className="rows">
              <div className="row toggle">
                <span className="grow">
                  <span className="rt">Learn from my chats</span>
                  <span className="rm wrap">Helm reads new chats once a day{keeper.name ? ` on ${keeper.name}` : ''} with a small model. It updates this list.</span>
                </span>
                <button className={`switch${record.keeper ? ' on' : ''}`} role="switch" aria-checked={record.keeper}
                  aria-label="Learn from my chats" disabled={busy} onClick={() => call('owner.set', { keeper: !record.keeper })}><i /></button>
              </div>
              <div className="row">
                <span className="grow"><span className="rm wrap">{lastRun(keeper)}</span></span>
                {keeper.here && record.keeper && (
                  <button className="ghost" style={{ width: 'auto', margin: 0 }} disabled={busy || keeper.running}
                    onClick={() => call('owner.keep', {})}>Run now</button>
                )}
              </div>
            </div>
            {record.learned && (record.learned.added.length > 0 || record.learned.removed.length > 0) && (
              <div className="owner-learned">
                <span className="note">Last preference changes, {ago(record.learned.at)}:</span>
                {record.learned.added.map((l) => <div key={`+${l}`} className="owner-added">+ {l}</div>)}
                {record.learned.removed.map((l) => <div key={`-${l}`} className="owner-removed">− {l}</div>)}
              </div>
            )}
          </>
        )}
        {error && <div className="error">{error}</div>}
      </div></div>
    </>
  );
}
