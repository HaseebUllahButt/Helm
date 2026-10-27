import { errorMessage } from '../errors';
import { useEffect, useState } from 'react';
import { accountsFrom, type Account } from '../accounts';
import { EngineMark } from '../EngineMark';
import { BackIcon, Icon } from '../Icon';
import { Client, type Environment, type Session, type ModelList } from '../client';
import { money } from '../format';
import { engineOf } from '../engines';
import { shortPath } from './common';
import { followModelRefresh } from '../modelRefresh';

/**
 * What a machine's brain is made of.
 *
 * Two screens in one, because they are the same question asked at different
 * times. With no brain on this machine it asks which account should be one,
 * which happens once per machine. With a brain it is that brain's settings -
 * reached by the gear inside the conversation, never by tapping the machine's
 * row under brains, because tapping that should land you in the thread.
 *
 * Changing the model is the thing you might reasonably do; it is a live
 * change to the running session, the same as the chip in the composer.
 * Changing which account or engine the brain *is* means ending the thread and
 * everything it knows, so it is a separate, spelled-out action.
 */
export function BrainView({ client, env, brain, onBack, onStarted, onReplaced }: {
  client: Client; env: Environment; brain: Session | null;
  onBack: () => void;
  onStarted: (s: Session) => void;
  onReplaced: () => void;
}) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [models, setModels] = useState<ModelList | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [replacing, setReplacing] = useState(false);
  const picking = !brain || replacing;

  useEffect(() => {
    if (!env.online || !picking) return;
    setAccounts(null); setError('');
    client.rpc(env.id, 'profile.list')
      .then((r: any) => setAccounts(accountsFrom(r.profiles)))
      .catch((e) => setError(errorMessage(e)));
  }, [client, env.id, env.online, picking]);

  // What this brain could think with. Asked of the live session, so the list
  // is what the running agent will actually accept.
  useEffect(() => {
    if (!brain || replacing || !env.online) return;
    setModels(null);
    const catalog = followModelRefresh<ModelList>(
      (settled) => client.rpc<ModelList>(env.id, 'model.list', {
        profileId: brain.profileId, id: brain.id, ...(settled ? { settled } : {}),
      }, 45_000),
      setModels, () => {},
    );
    return catalog.stop;
  }, [client, env.id, brain?.id, env.online, replacing]);

  const start = async (a: Account) => {
    setBusy(a.key); setError('');
    try {
      // Replacing means the old thread goes: two brains on one machine would
      // each hold half of what you had told it.
      if (brain && replacing) await client.rpc(env.id, 'session.kill', { id: brain.id }, 30_000);
      const r = await client.rpc<{ session: Session }>(env.id, 'brain.open', { profileId: a.profile.id }, 60_000);
      onStarted(r.session);
    } catch (e: any) { setError(errorMessage(e)); setBusy(''); }
  };

  const setModel = async (model: string) => {
    if (!brain) return;
    setBusy(model); setError('');
    try {
      await client.rpc(env.id, 'session.model', { id: brain.id, model }, 30_000);
      onReplaced();
    } catch (e: any) { setError(errorMessage(e)); }
    finally { setBusy(''); }
  };

  const title = 'Helm brain';
  const sub = picking ? `on ${env.name}` : `${engineOf(brain!.engine).label} on ${env.name}`;

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <div className="titles"><h1>{title}</h1><span className="sub">{sub}</span></div>
      </div>
      <div className="scroll"><div className="pad column">
        {picking ? (
          <>
            <p className="note">
              Use one chat for all your machines on {env.name}. It knows your projects. It works on any machine you name. It keeps working when your laptop sleeps.
            </p>
            {replacing && (
              <div className="banner warn">
                A new brain ends the current brain chat. Its saved notes stay.
              </div>
            )}
            <div className="section">Select an account</div>
            {!accounts && !error && env.online && <div className="empty quiet">Loading accounts from {env.name}…</div>}
            <div className="rows">
              {(accounts ?? []).map((a) => (
                <button key={a.key} className="row tall" disabled={!!busy} onClick={() => start(a)}>
                  <EngineMark engine={engineOf(a.engine).cls} />
                  <span className="grow">
                    <span className="rt"><span className="rt-text">{engineOf(a.engine).label}</span></span>
                    <span className="rm">{[a.account, a.prefs?.default].filter(Boolean).join(' · ')}</span>
                  </span>
                  {busy === a.key ? <span className="chip working"><i />starting</span> : <span className="chev"><Icon name="forward" size={15} /></span>}
                </button>
              ))}
            </div>
            {accounts && !accounts.length && (
              <div className="empty quiet">
                This machine has no agent accounts.
                <div className="note" style={{ marginTop: 6 }}>Install an agent program that Helm can run in the background.</div>
              </div>
            )}
            {!env.online && <div className="empty quiet">{env.name} is offline.</div>}
            {replacing && <button className="row" onClick={() => setReplacing(false)}><span className="grow"><span className="rt">Keep this brain</span></span></button>}
          </>
        ) : (
          <>
            <div className="section">Model</div>
            <div className="rows">
              {(models?.models ?? []).map((m) => {
                const current = (brain!.model ?? models?.default) === m;
                return (
                  <button key={m} className={`row${current ? ' active' : ''}`} disabled={!!busy} onClick={() => setModel(m)}>
                    <span className="grow">
                      <span className="rt"><span className="rt-text">{models?.labels?.[m] ?? m}</span></span>
                    </span>
                    {busy === m ? <span className="chip working"><i />changing</span> : current ? <span className="tag key">current</span> : <span className="chev"><Icon name="forward" size={15} /></span>}
                  </button>
                );
              })}
              {!models && <div className="empty quiet">{env.online ? 'Loading machine details…' : `${env.name} is offline`}</div>}
            </div>

            <div className="section">Machine and account</div>
            <div className="rows">
              <div className="row">
                <EngineMark engine={engineOf(brain!.engine).cls} />
                <span className="grow">
                  <span className="rt">{engineOf(brain!.engine).label} on {env.name}</span>
                  <span className="rm">{[brain!.profileId, shortPath(brain!.cwd), money(brain!.costUsd)].filter(Boolean).join(' · ')}</span>
                </span>
              </div>
            </div>

            <div className="section">Other actions</div>
            <div className="rows">
              <button className="row destructive" onClick={() => setReplacing(true)}>
                <span className="grow">
                  <span className="rt">Start a different brain</span>
                  <span className="rm">Start a new chat. Saved notes stay.</span>
                </span>
                <span className="chev"><Icon name="forward" size={15} /></span>
              </button>
            </div>
          </>
        )}
        {error && <div className="error">{error}</div>}
      </div></div>
    </>
  );
}
