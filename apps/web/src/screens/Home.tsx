import { useCallback, useRef, useState, type KeyboardEvent } from 'react';
import { type Environment, type Session } from '../client';
import { EngineMark } from '../EngineMark';
import { engineOf } from '../engines';
import { shownTitle } from '../format';
import { Icon } from '../Icon';
import { useDismiss } from '../useDismiss';
import { ago } from './common';

export interface HomeMachine {
  env: Environment;
  /** Chats that wait for the owner, first. */
  waiting: Session[];
  running: Session[];
}

const PICKED = 'helm:home-machine';
const SHOWN = 3;

function savedPick(): string | null {
  try { return localStorage.getItem(PICKED); } catch { return null; }
}

/**
 * Home on a wide screen, where the logo leads: one box that starts a chat on
 * any machine, and a card for each machine with what runs there. Chats stay
 * in the sidebar; this page is for "where do I start" and "how is each
 * machine".
 */
export function Home({ machines, onOpenMachine, onOpenChat, onStart }: {
  machines: HomeMachine[];
  onOpenMachine: (envId: string) => void;
  onOpenChat: (envId: string, s: Session) => void;
  /** Pick a folder and an agent next; the text is sent once the agent is up. */
  onStart: (envId: string, text: string) => void;
}) {
  const online = machines.filter((m) => m.env.online);
  const [picked, setPicked] = useState<string | null>(savedPick);
  const target = online.find((m) => m.env.id === picked)?.env ?? online[0]?.env;
  const [text, setText] = useState('');
  const [menu, setMenu] = useState(false);
  const closeMenu = useCallback(() => setMenu(false), []);
  useDismiss(menu, closeMenu);
  const box = useRef<HTMLTextAreaElement>(null);

  const running = machines.reduce((n, m) => n + m.running.length, 0);
  const waiting = machines.reduce((n, m) => n + m.waiting.length, 0);

  const pick = (id: string) => {
    setPicked(id);
    try { localStorage.setItem(PICKED, id); } catch { /* remembered for this visit only */ }
    setMenu(false);
    box.current?.focus();
  };
  const start = () => {
    if (!target) return;
    onStart(target.id, text.trim());
    setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && text.trim()) { e.preventDefault(); start(); }
  };

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

      <form className="home-ask" onSubmit={(e) => { e.preventDefault(); start(); }}>
        <textarea
          ref={box} rows={2} value={text} placeholder="Ask anything…" aria-label="Ask anything"
          disabled={!target} onChange={(e) => setText(e.target.value)} onKeyDown={onKey}
        />
        <div className="home-ask-bar">
          <span className="home-pick-slot" onKeyDown={(e) => { if (menu && e.key === 'Escape') { e.stopPropagation(); setMenu(false); box.current?.focus(); } }}>
            <button
              type="button" className="home-pick" disabled={!target}
              aria-haspopup="menu" aria-expanded={menu} aria-label={target ? `Machine: ${target.name}` : 'No machine is online'}
              title="Pick the machine for this chat" onClick={() => setMenu((v) => !v)}
            >
              <Icon name="machine" size={14} />
              <span>{target?.name ?? 'No machine online'}</span>
              <Icon name="down" size={12} />
            </button>
            {menu && (
              <div className="menu home-pick-menu" role="menu" aria-label="Machine">
                {online.map(({ env: e }) => (
                  <button key={e.id} type="button" role="menuitemradio" aria-checked={e.id === target?.id} onClick={() => pick(e.id)}>
                    <span>{e.name}</span>{e.id === target?.id && <span className="check"><Icon name="check" size={15} /></span>}
                  </button>
                ))}
              </div>
            )}
          </span>
          <span className="home-ask-hint">Next: pick a folder and an agent</span>
          <button type="submit" className="home-send" disabled={!target} aria-label="Start chat" title={text.trim() ? 'Start chat (Enter)' : 'Start chat'}>
            <Icon name="arrow-up" size={16} />
          </button>
        </div>
      </form>

      <div className="section">Machines</div>
      {machines.length ? (
        <div className="home-machines">
          {machines.map(({ env: e, waiting: wait, running: run }) => {
            const chats = [...wait, ...run];
            const said = !e.online ? (e.lastSeen ? `Offline · seen ${ago(e.lastSeen)}` : 'Never connected')
              : chats.length ? [run.length ? `${run.length} running` : '', wait.length ? `${wait.length} ${wait.length === 1 ? 'needs' : 'need'} you` : ''].filter(Boolean).join(' · ')
              : 'Nothing is running.';
            return (
              <div key={e.id} className={`home-mcard${e.online ? '' : ' offline'}${wait.length ? ' waits' : ''}`}>
                <button type="button" className="home-mhead" onClick={() => onOpenMachine(e.id)} title={`Open ${e.name}`}>
                  <span className={`mdot ${e.online ? 'on' : 'off'}`} />
                  <span className="home-mname">{e.name}</span>
                  <span className="chev"><Icon name="forward" size={14} /></span>
                </button>
                <p className={`home-msaid${wait.length ? ' attention' : ''}`}>{said}</p>
                {e.online && chats.length > 0 && (
                  <div className="home-mchats">
                    {chats.slice(0, SHOWN).map((s) => (
                      <button key={s.id} type="button" className="home-mchat" onClick={() => onOpenChat(e.id, s)} title={shownTitle(s.title).text}>
                        <EngineMark engine={engineOf(s.engine).cls} />
                        <span className="home-mchat-title">{shownTitle(s.title).text}</span>
                        {wait.includes(s) && <span className="tag">needs you</span>}
                      </button>
                    ))}
                    {chats.length > SHOWN && (
                      <button type="button" className="home-mmore linkish" onClick={() => onOpenMachine(e.id)}>
                        {chats.length - SHOWN} more
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
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
