import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { accountsFrom, loadPrefs, savePrefs, type Account, type PickerPrefs } from '../accounts';
import { watchAccounts } from '../accountsCache';
import { type Client, type Environment, type ModelList, type Session } from '../client';
import { EngineMark } from '../EngineMark';
import { engineOf } from '../engines';
import { Icon } from '../Icon';
import { loadModels, saveModels } from '../modelCache';
import { followModelRefresh } from '../modelRefresh';
import { ChoiceSheet, Controls, trayPrefs, type Kind } from '../session/Controls';
import type { StartInfo } from '../startingChats';
import { ago } from './common';

export interface HomeMachine {
  env: Environment;
  running: number;
  waiting: number;
}

const PICKED = 'helm:home-machine';
const savedPick = () => { try { return localStorage.getItem(PICKED); } catch { return null; } };

type Picks = { model?: string; effort?: string; mode?: string; speed?: string };

/**
 * Home on a wide screen, where the logo leads. The box starts a quick chat
 * at once, with the same chips as the message box: machine, agent, model,
 * thinking, permissions. Under it, one row per machine opens that machine.
 * Chats themselves stay in the sidebar.
 */
export function Home({ client, machines, near, onOpenMachine, onStart }: {
  client: Client;
  machines: HomeMachine[];
  /** The machine open before Home: the box starts there. */
  near: string | null;
  onOpenMachine: (envId: string) => void;
  /** The chat opens now; `message` is sent once its agent is up. */
  onStart: (info: StartInfo, run: () => Promise<Session>, message: string) => void;
}) {
  const online = machines.filter((m) => m.env.online).map((m) => m.env);
  const [picked, setPicked] = useState<string | null>(() => near ?? savedPick());
  const machine = online.find((e) => e.id === picked) ?? online.find((e) => e.id === savedPick()) ?? online[0] ?? null;
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [picker, setPicker] = useState<(PickerPrefs & { onMachine: boolean }) | null>(null);
  const [account, setAccount] = useState('');
  const [catalog, setCatalog] = useState<ModelList | null>(null);
  const [picks, setPicks] = useState<Picks>({});
  const [sheet, setSheet] = useState<'machine' | 'agent' | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);

  // The machine's agents: what this device remembers first, then its answer.
  useEffect(() => {
    setAccounts(null); setPicker(null); setAccount('');
    if (!machine) return;
    let stale = false;
    const stop = watchAccounts(client, machine.id, (r) => {
      if (stale) return;
      const local = loadPrefs()[machine.id];
      setPicker({ ...(r.picker ?? { hidden: local?.hidden ?? [], last: local?.account ?? null }), onMachine: !!r.picker });
      setAccounts(accountsFrom(r.profiles));
    }, (message) => { if (!stale) { setAccounts((now) => now ?? []); setError(message); } });
    return () => { stale = true; stop(); };
  }, [client, machine?.id]);
  const shown = (accounts ?? []).filter((a) => !picker?.hidden.includes(a.key));
  // The one picked here, else the machine's default, else the last one used.
  const agent = shown.find((a) => a.key === account) ?? shown.find((a) => a.key === picker?.agent)
    ?? shown.find((a) => a.key === picker?.last) ?? shown[0] ?? null;

  // The agent's models, thinking levels and permissions, as a chat asks for them.
  useEffect(() => {
    setCatalog(null); setPicks({});
    if (!machine || !agent) return;
    let stale = false;
    const env = machine.id, profileId = agent.profile.id;
    loadModels(env, profileId).then((cached) => { if (!stale && cached) setCatalog((now) => now ?? cached); });
    const refresh = followModelRefresh(
      (settled) => client.rpc<ModelList>(env, 'model.list', { profileId, ...(settled ? { settled } : {}) }, 30_000),
      (list) => {
        if (stale || !Array.isArray(list?.models)) return;
        setCatalog(list); void saveModels(env, profileId, list);
      },
      () => { /* the remembered list stays */ },
    );
    return () => { stale = true; refresh.stop(); };
  }, [client, machine?.id, agent?.profile.id]);

  // What a new chat on this account starts with, unless picked here.
  const now: Picks = {
    model: agent?.prefs?.default || undefined,
    effort: agent?.defaults?.effort || undefined,
    mode: agent?.defaults?.mode && agent.defaults.mode !== 'plan' ? agent.defaults.mode : undefined,
    speed: agent?.defaults?.speed || undefined,
    ...picks,
  };
  const draft = { engine: agent?.engine ?? '', profileId: agent?.profile.id, ...now } as Session;
  const pick = (kind: Kind, id: string) => {
    if (kind === 'model') {
      // A thinking level the new model does not offer is not kept.
      const levels = catalog?.effortsByModel?.[id] ?? catalog?.efforts ?? [];
      setPicks((p) => ({ ...p, model: id, ...(now.effort && !levels.includes(now.effort) ? { effort: '' } : {}) }));
    } else setPicks((p) => ({ ...p, [kind]: id }));
    box.current?.focus();
  };
  const prefs = trayPrefs({
    client, env: machine?.id ?? '', engine: agent?.engine ?? '', profileId: agent?.profile.id ?? null,
    options: catalog, setOptions: (update) => setCatalog((list) => update(list)), setError,
  });
  const controls = Controls({ options: catalog, session: draft, onPick: pick, ...prefs });

  const start = () => {
    if (!machine || !agent) return;
    if (picker?.onMachine) client.rpc(machine.id, 'picker.prefs', { last: agent.key }, 15_000).catch(() => { /* only a default */ });
    else {
      const local = loadPrefs();
      savePrefs({ ...local, [machine.id]: { ...local[machine.id], account: agent.key } });
    }
    const env = machine.id;
    const params = {
      quick: true, profileId: agent.profile.id,
      model: now.model || undefined, effort: now.effort || undefined,
      mode: now.mode && now.mode !== 'plan' ? now.mode : undefined, speed: now.speed || undefined,
    };
    onStart(
      { envId: env, title: 'Quick chat', folder: null, account: agent.account, profileId: agent.profile.id, engine: agent.engine, agent: engineOf(agent.engine).label },
      () => client.rpc<{ session: Session }>(env, 'session.start', params, 70_000).then((r) => r.session),
      text.trim(),
    );
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); start(); }
  };
  const open = (which: 'machine' | 'agent') => { controls.close(); setSheet((s) => s === which ? null : which); };

  const running = machines.reduce((n, m) => n + m.running, 0);
  const waiting = machines.reduce((n, m) => n + m.waiting, 0);
  const ready = !!machine && !!agent;
  // "Claude", or "Claude · work" when the agent has more than its default login.
  const agentName = (a: Account) => a.account === 'default' ? engineOf(a.engine).label : `${engineOf(a.engine).label} · ${a.account}`;

  return (
    <div className="scroll"><div className="pad column home">
      <div className="home-hero">
        <h2 className="home-title">What should we build?</h2>
        <p className={`home-state${online.length ? '' : ' down'}`}>
          <i className={`mdot ${online.length ? 'on' : 'off'}`} />
          {online.length} of {machines.length} {machines.length === 1 ? 'machine' : 'machines'} online
          {running > 0 && ` · ${running} running`}
          {waiting > 0 && <span className="attention">&nbsp;· {waiting} {waiting === 1 ? 'needs' : 'need'} you</span>}
        </p>
      </div>

      <div className="home-ask-wrap">
        {sheet === 'machine' && machine ? (
          <ChoiceSheet
            title="Machine" current={machine.id}
            choices={online.map((e) => ({ id: e.id, label: e.name, icon: <Icon name="machine" size={14} /> }))}
            onPick={(id) => {
              setPicked(id); setSheet(null); setError('');
              try { localStorage.setItem(PICKED, id); } catch { /* this visit only */ }
              box.current?.focus();
            }}
            onClose={() => setSheet(null)}
          />
        ) : sheet === 'agent' && agent && machine ? (
          <ChoiceSheet
            title={`Agent on ${machine.name}`} current={agent.key}
            choices={shown.map((a) => ({ id: a.key, label: engineOf(a.engine).label, hint: a.account, icon: <EngineMark engine={engineOf(a.engine).cls} /> }))}
            onPick={(id) => { setAccount(id); setSheet(null); box.current?.focus(); }}
            onClose={() => setSheet(null)}
          />
        ) : controls.sheet}
        <form className="home-ask" onSubmit={(e) => { e.preventDefault(); start(); }}>
          <textarea
            ref={box} rows={2} value={text} autoFocus
            placeholder={machine ? 'Ask anything…' : 'No machine is online.'} aria-label="Ask anything"
            disabled={!machine} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
          />
          <div className="home-ask-bar">
            <span className="chips home-chips">
              <button type="button" className={`chip-pick${sheet === 'machine' ? ' on' : ''}`} disabled={!machine}
                aria-label={`Machine: ${machine?.name ?? 'none online'}`} title="Pick the machine" onClick={() => open('machine')}>
                <i className="cg"><Icon name="machine" size={13} /></i>
                <span className="chip-label">{machine?.name ?? 'No machine'}</span>
              </button>
              <button type="button" className={`chip-pick account${sheet === 'agent' ? ' on' : ''}`} disabled={!machine || !shown.length}
                aria-label={`Agent: ${agent ? agentName(agent) : accounts ? 'none' : 'finding agents'}`} title="Pick the agent" onClick={() => open('agent')}>
                {agent && <EngineMark engine={engineOf(agent.engine).cls} />}
                <span className="chip-label">{agent ? agentName(agent) : accounts ? 'No agent' : 'Finding agents…'}</span>
              </button>
              {agent && <span className="home-chip-rest" onClickCapture={() => setSheet(null)}>{controls.chips}</span>}
            </span>
            <button type="submit" className="home-send" disabled={!ready} aria-label="Start quick chat" title="Start quick chat (Enter)">
              <Icon name="arrow-up" size={16} />
            </button>
          </div>
        </form>
      </div>
      {error && <p className="error" role="alert">{error}</p>}

      <div className="section">Machines</div>
      {machines.length ? (
        <div className="rows plain">
          {machines.map(({ env: e, running: run, waiting: wait }) => (
            <button key={e.id} type="button" className={`row tall machine${e.online ? '' : ' offline'}`} onClick={() => onOpenMachine(e.id)}>
              <span className={`mdot ${e.online ? 'on' : 'off'}`} />
              <span className="grow">
                <span className="rt"><span className="rt-text">{e.name}</span></span>
                <span className="rm">
                  {!e.online ? (e.lastSeen ? `Offline · seen ${ago(e.lastSeen)}` : 'Never connected')
                    : run ? `${run} running` : 'Nothing is running.'}
                </span>
              </span>
              {wait > 0 && <span className="badge" title={`${wait} ${wait === 1 ? 'needs' : 'need'} you`}>{wait}</span>}
              <span className="chev"><Icon name="forward" size={15} /></span>
            </button>
          ))}
        </div>
      ) : (
        <div className="empty quiet">
          You have no machines yet.
          <div className="note">Run <code>helm add pc</code> on a machine in your network.</div>
        </div>
      )}
    </div></div>
  );
}
