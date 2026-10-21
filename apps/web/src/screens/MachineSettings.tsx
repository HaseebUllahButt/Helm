import { useEffect, useState, type FormEvent } from 'react';
import { accountsFrom, type Account } from '../accounts';
import { EngineMark } from '../EngineMark';
import { PublicLinks } from '../PublicLinks';
import { BackIcon, Icon } from '../Icon';
import { Client, validMachineName, MACHINE_NAME_RULE, type Environment } from '../client';
import { engineOf } from '../engines';
import { startSummary } from './common';

/**
 * What a machine is called, changed from here.
 *
 * The name is not decoration: it is what the machine list, the brain, the
 * CLI (`helm brain laptop`) and `ssh laptop` all address it by, which is why
 * it is held to what an ssh Host alias can hold rather than quietly rewritten
 * into something ssh can reach and the app never shows.
 *
 * Only the machine itself may write its own name - every other copy of that
 * record loses - so this is an RPC to it, and it is off while it is offline
 * rather than queued into a change that would never land.
 */
function MachineName({ client, env, onRenamed }: {
  client: Client; env: Environment; onRenamed: () => void;
}) {
  const [name, setName] = useState(env.name);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  // Renamed from another phone, or by the machine itself: the field follows
  // what the machine says it is called rather than arguing with it.
  useEffect(() => { setName(env.name); }, [env.name]);

  const next = name.trim();
  const changed = next !== env.name;
  const ok = validMachineName(next);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!changed || !ok || !env.online) return;
    setBusy(true); setError(''); setDone(false);
    try {
      const r = await client.renameMachine(env.id, next);
      setName(r.name);
      setDone(true);
      // The machine list, the bar above and every other screen holding this
      // machine's name read from one place; refresh it.
      onRenamed();
    } catch (err: any) {
      setError(err.message);
    } finally { setBusy(false); }
  };

  return (
    <form onSubmit={save}>
      <input
        className="field" value={name} disabled={!env.online || busy}
        autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
        aria-label="machine name"
        onChange={(e) => { setName(e.target.value); setDone(false); setError(''); }}
      />
      <button className="primary big" disabled={!env.online || busy || !changed || !ok}>
        {busy ? 'renaming…' : 'Rename this machine'}
      </button>
      {!env.online && (
        <div className="banner warn">
          This machine is offline. Rename it when it connects again.
        </div>
      )}
      <p className="note">
        {changed && !ok
          ? `Use ${MACHINE_NAME_RULE} for the name.`
          // "Renamed" under "this machine is offline" is two answers to the
          // same question; the banner is the one that matters now.
          : done && env.online
            ? `Renamed to ${env.name}.`
            // A machine that joined under a hostname with a space or an
            // apostrophe in it keeps that name - nothing rewrites a record
            // behind its owner's back - but ssh cannot reach it under one.
            : !validMachineName(env.name)
              ? `SSH cannot use this name. Use ${MACHINE_NAME_RULE}.`
              : <>Connect with SSH: <code>ssh {env.name}</code></>}
      </p>
      {error && <div className="error">{error}</div>}
    </form>
  );
}

/**
 * What a machine is for: pc, vm or nas.
 *
 * Same authorship rule as the name above - the machine writes its own
 * record - so this is an RPC to it and it is off while offline. The choices
 * are deliberately only the three machine kinds: a controller is not a
 * fourth one and can never become one, which is why it appears nowhere here.
 * Becoming the vm claims an https address on the machine, and leaving it
 * stops advertising that address; pc and nas differ only in what the rest
 * of the network should expect of the machine.
 */
function MachineKind({ client, env, onChanged }: {
  client: Client; env: Environment; onChanged: () => void;
}) {
  const KINDS = [
    { id: 'pc' as const, label: 'Computer', hint: 'Runs agents and controls other machines.' },
    { id: 'vm' as const, label: 'Always-on server', hint: 'Other machines connect here. It has an HTTPS address.' },
    { id: 'nas' as const, label: 'Storage', hint: 'Stores files for your machines.' },
  ];
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const pick = async (kind: 'pc' | 'vm' | 'nas') => {
    if (kind === env.kind || busy) return;
    setBusy(kind); setError('');
    try {
      await client.setMachineKind(env.id, kind);
      // The machine list reads the roster record the machine just wrote.
      onChanged();
    } catch (e: any) {
      setError(e.message);
    } finally { setBusy(''); }
  };

  return (
    <>
      <div className="rows">
        {KINDS.map((k) => (
          <button key={k.id} className="row tall" disabled={!env.online || !!busy}
            onClick={() => pick(k.id)}>
            <span className="grow">
              <span className="rt">
                {k.label}{env.kind === k.id && <span className="tag key">current</span>}
              </span>
              <span className="rm">{k.hint}</span>
            </span>
            {busy === k.id ? <span className="chip working"><i />changing</span> : <span className="chev"><Icon name="forward" size={15} /></span>}
          </button>
        ))}
      </div>
      {!env.online && (
        <div className="banner warn">
          This machine is offline. Change it when it connects again.
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </>
  );
}

/**
 * Per-machine settings: what the machine is called, and for each account on
 * it, which models the picker offers and which one a new session starts with.
 * The prefs live in the machine's ~/.helm/config.json and the name lives in
 * its roster record, so both follow the machine no matter which device asks.
 */
export function EnvSettings({ client, env, onBack, onEdit, onRenamed }: {
  client: Client; env: Environment; onBack: () => void; onEdit: (a: Account) => void;
  onRenamed: () => void;
}) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    client.rpc(env.id, 'profile.list')
      .then((r: any) => setAccounts(accountsFrom(r.profiles)))
      .catch((e) => setError(e.message));
  }, [client, env.id]);

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <div className="titles"><h1>Settings</h1><span className="sub">{env.name}</span></div>
      </div>
      <div className="scroll"><div className="pad column">
        <div className="section">name</div>
        <MachineName client={client} env={env} onRenamed={onRenamed} />

        <div className="section">Machine type</div>
        <MachineKind client={client} env={env} onChanged={onRenamed} />

        <div className="section">Spins</div>
        <PublicLinks client={client} env={env} />

        <div className="section">Agent accounts</div>
        {accounts === null && !error && <div className="empty quiet">Finding agents…</div>}
        {accounts?.length === 0 && <div className="empty quiet">{env.name} has no agents.</div>}
        <div className="rows">
          {accounts?.map((a) => {
            const e = engineOf(a.engine);
            const n = a.prefs?.approved?.length ?? 0;
            // Approving nothing and setting a default is a real state - the
            // picker stays whole and new sessions still start somewhere - so
            // the row has to say the default even when there is no short list.
            const short = n ? `${n} model${n === 1 ? '' : 's'}` : 'all models';
            const starts = startSummary(a);
            return (
              <button key={a.key} className="row tall" onClick={() => onEdit(a)}>
                <EngineMark engine={e.cls} />
                <span className="grow">
                  <span className="rt">{e.label} <span className="dim">· {a.account}</span></span>
                  <span className="rm">{[short, starts].filter(Boolean).join(' · ')}</span>
                </span>
                <span className="chev"><Icon name="forward" size={15} /></span>
              </button>
            );
          })}
        </div>
        {error && <div className="error">{error}</div>}
      </div></div>
    </>
  );
}
