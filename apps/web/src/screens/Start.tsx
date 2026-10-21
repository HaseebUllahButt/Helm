import { useEffect, useRef, useState } from 'react';
import { Sheet } from '../Modal';
import { accountsFrom, loadPrefs, savePrefs, type Account, type PickerPrefs } from '../accounts';
import { watchAccounts } from '../accountsCache';
import { EngineMark } from '../EngineMark';
import { BackIcon, Icon } from '../Icon';
import { Route } from '../Route';
import { Client, type Environment, type Session } from '../client';
import { engineOf } from '../engines';
import { startSummary } from './common';
import { Sliders } from './icons';

/**
 * One screen, one decision: which account runs here.
 *
 * Model, thinking level, permissions and speed used to be chosen here and
 * then frozen for the life of the session. They are all changeable from
 * inside the conversation now, so asking for them up front only stands
 * between you and the session. The account cannot move - it decides which
 * process starts - so it is the only thing left, and the last one you used
 * is already selected.
 */
export function Start({ client, env, cwd, quick = false, onBack, onStarted }: {
  client: Client; env: Environment; cwd: string;
  /** A chat with no folder: the machine makes an empty one for it. */
  quick?: boolean;
  onBack: () => void; onStarted: (s: Session) => void;
}) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [key, setKey] = useState<string>('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [mode, setMode] = useState('');
  const [speed, setSpeed] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const prefs = useRef(loadPrefs());
  // True once the machine has said it keeps these itself.
  const onMachine = useRef(false);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(prefs.current[env.id]?.hidden ?? []));
  const [choosing, setChoosing] = useState(false);
  // The agent picked on purpose as this machine's default; null when none is.
  const [preferred, setPreferred] = useState<string | null>(null);

  const savePicker = (change: Partial<PickerPrefs>) => {
    if (onMachine.current) {
      client.rpc(env.id, 'picker.prefs', change, 15_000).catch((e) => setError(e.message));
      return;
    }
    const slot = { ...prefs.current[env.id] };
    if (change.hidden) slot.hidden = change.hidden;
    if (change.last) slot.account = change.last;
    prefs.current = { ...prefs.current, [env.id]: slot };
    savePrefs(prefs.current);
  };

  // The remembered list paints at once; the machine's answer replaces it.
  useEffect(() => watchAccounts(client, env.id, (r: any, fresh) => {
    const list = accountsFrom(r.profiles);
    setAccounts(list);
    const local = prefs.current[env.id];
    let picker: PickerPrefs = { hidden: local?.hidden ?? [], last: local?.account ?? null };
    if (r.picker) {
      onMachine.current = true;
      picker = r.picker;
      // This browser chose before the machine could keep it: hand the
      // choice over once, then forget the local copy.
      if (fresh && local && !picker.hidden.length && !picker.last && (local.hidden?.length || local.account)) {
        picker = { ...picker, hidden: local.hidden ?? [], last: local.account ?? null };
        savePicker({ hidden: picker.hidden, last: picker.last });
      }
      if (fresh && local) {
        const { [env.id]: _gone, ...rest } = prefs.current;
        prefs.current = rest;
        savePrefs(rest);
      }
    }
    const seen = new Set(picker.hidden);
    setHidden(seen);
    setPreferred(picker.agent ?? null);
    // The chosen default first, then the last one used. A hidden row
    // cannot be the selected one: it is not on the screen. A row already
    // chosen from the remembered list stays chosen when the answer lands.
    setKey((now) => (now && list.some((a) => a.key === now && !seen.has(a.key))) ? now
      : list.find((a) => a.key === picker.agent && !seen.has(a.key))?.key
        ?? list.find((a) => a.key === picker.last && !seen.has(a.key))?.key
        ?? list.find((a) => !seen.has(a.key))?.key ?? '');
  }, (message) => setError(message)), [client, env.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = accounts?.filter((a) => !hidden.has(a.key)) ?? null;
  const account = shown?.find((a) => a.key === key) ?? null;
  // Two logins of one CLI can share a folder name; the alias tells them apart.
  const twins = new Set((accounts ?? []).map((a) => `${a.engine}|${a.account}`)
    .filter((k, i, all) => all.indexOf(k) !== i));
  const accountName = (a: Account) => twins.has(`${a.engine}|${a.account}`) ? `${a.account} (${a.profile.id})` : a.account;

  const toggleShown = (a: Account) => {
    const next = new Set(hidden);
    if (next.has(a.key)) next.delete(a.key); else next.add(a.key);
    setHidden(next);
    savePicker({ hidden: [...next] });
    // A row nobody can see cannot be the one that starts.
    if (next.has(a.key)) {
      if (a.key === key) setKey(accounts?.find((x) => !next.has(x.key))?.key ?? '');
    }
  };

  // The defaults belong to the machine/account, not this browser, so opening
  // the same picker from a phone or laptop starts the same CLI configuration.
  useEffect(() => {
    if (!account) return;
    setModel(account.prefs?.default ?? '');
    setEffort(account.defaults?.effort ?? '');
    setMode(account.defaults?.mode === 'plan' ? '' : account.defaults?.mode ?? '');
    setSpeed(account.defaults?.speed ?? '');
  }, [account?.key]);

  const start = async () => {
    if (!account) return;
    setBusy(true); setError('');
    savePicker({ last: account.key });
    try {
      const r = await client.rpc<{ session: Session }>(env.id, 'session.start', {
        ...(quick ? { quick: true } : { cwd }), profileId: account.profile.id,
        model: model || undefined, effort: effort || undefined,
        mode: mode || undefined, speed: speed || undefined,
      }, 70_000);
      onStarted(r.session);
    } catch (e: any) { setError(e.message); setBusy(false); }
  };

  const eng = account ? engineOf(account.engine) : null;

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <div className="titles"><h1>{quick ? 'Quick chat' : 'New chat'}</h1><span className="sub"><Route machine={env.name} folder={cwd} quick={quick} /></span></div>
        {(accounts?.length ?? 0) > 0 && (
          <button
            className="iconbtn" title="Select agents to show" aria-label="Select agents to show"
            onClick={() => setChoosing(true)}
          ><Sliders /></button>
        )}
      </div>
      <div className="scroll"><div className="pad column">
        <div className="section">agent</div>
        {accounts === null && <div className="empty quiet">{env.online ? 'Finding agents…' : `Helm cannot reach ${env.name}.`}</div>}
        {shown?.length === 0 && (accounts?.length ?? 0) > 0 && (
          <div className="empty quiet">All agents are hidden. Select the controls above to show agents.</div>
        )}
        <div className="rows">
          {shown?.map((a) => {
            const e = engineOf(a.engine);
            return (
              <button
                key={a.key} title={a.aliases.join(', ')}
                className={`row tall${a.key === key ? ' active' : ''}`}
                onClick={() => setKey(a.key)}
              >
                <EngineMark engine={e.cls} />
                <span className="grow">
                  <span className="rt">{e.label} <span className="dim">· {accountName(a)}</span>{a.token && <span className="tag wide-only">API key</span>}{a.key === preferred && <span className="tag key">default</span>}</span>
                  {a.key === key && <span className="rm">{startSummary(a)}</span>}
                </span>
                {a.key === key && <span className="check"><Icon name="check" size={16} /></span>}
              </button>
            );
          })}
        </div>
        {account && onMachine.current && account.key !== preferred && (
          <button className="linkbtn makedefault" onClick={() => { setPreferred(account.key); savePicker({ agent: account.key }); }}>
            Set {engineOf(account.engine).label} · {accountName(account)} the default on {env.name}
          </button>
        )}
        {accounts?.length === 0 && (
          <div className="empty quiet">
            {env.name} has no agents.
            <div className="note" style={{ marginTop: 6 }}>Install an agent program there. Run <code>helm profiles --refresh</code></div>
          </div>
        )}

        {error && <div className="error" style={{ whiteSpace: 'pre-line' }}>{error}</div>}
      </div></div>
      {/* Pinned, because the choice is already made - the last account you
          used is selected - and thirteen rows should not push the only
          button off the screen. */}
      {account && (
        <div className="startbar">
          <button
            className="primary big"
            disabled={busy}
            onClick={start}
          >
            {busy ? 'starting…' : `Start ${eng?.label}`}
          </button>
        </div>
      )}
      {choosing && (
        <Sheet onClose={() => setChoosing(false)} label="Select agents to show">
          <div className="modal-title">Agents on this screen</div>
          <div className="modal-body">
            Selected agents show on every device. Hidden agents stay installed.
          </div>
          <div className="sheetlist"><div className="rows">
            {(accounts ?? []).map((a) => {
              const e = engineOf(a.engine);
              const on = !hidden.has(a.key);
              return (
                <button key={a.key} className={`row tall${on ? ' active' : ''}`} onClick={() => toggleShown(a)}>
                  <EngineMark engine={e.cls} />
                  <span className="grow">
                    <span className="rt">{e.label} <span className="dim">· {accountName(a)}</span></span>
                  </span>
                  {on && <span className="check"><Icon name="check" size={16} /></span>}
                </button>
              );
            })}
          </div></div>
          <div className="modal-actions">
            <button className="primary" onClick={() => setChoosing(false)}>Done</button>
          </div>
        </Sheet>
      )}
    </>
  );
}
