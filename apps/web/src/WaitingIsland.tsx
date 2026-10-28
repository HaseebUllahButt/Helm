import { useEffect, useRef, useState } from 'react';
import type { Client, Session } from './client';
import { EngineMark } from './EngineMark';
import { engineOf } from './engines';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { errorMessage } from './errors';
import { plainProblem } from './session/problem';
import { plainDetail } from './session/PermissionSheet';
import type { Decision, Permission } from './session/types';
import { whereOf } from './screens/ThreadRows';
import { notificationContext } from '@helm/protocol/notifications';

/** "has a question", "wants to run a command" - what a waiting thread wants. */
export function askAction(ask: Session['ask']): string {
  switch (ask?.kind) {
    case 'question': return 'has a question';
    case 'command': return 'wants to run a command';
    case 'edit': return 'wants to change a file';
    case 'plan': return 'has a plan';
    case 'tool': return 'needs your approval';
    default: return 'needs you';
  }
}

/** What a waiting chat wants, as a line of its own: "Wants to run a command". */
export function waitingLine(s: Session): string {
  if (s.status === 'blocked' && s.ask) { const a = askAction(s.ask); return a[0].toUpperCase() + a.slice(1); }
  if (s.team?.blocked) return `${s.team.blocked} helper ${s.team.blocked === 1 ? 'task needs' : 'tasks need'} approval`;
  if (s.status !== 'blocked' && s.recovery) return plainProblem(s.recovery.kind, s.recovery.message).title;
  if (s.team?.failed) return `${s.team.failed} helper ${s.team.failed === 1 ? 'task' : 'tasks'} failed`;
  return 'Needs you';
}

export interface Waiting { envId: string; machine: string; s: Session }
/** A chat to show: `at` makes the same chat asked for twice a new request. */
export interface IslandCall { envId: string; id: string; at: number }

/** How long the box stays open by itself when a chat starts waiting. */
const PEEK_MS = 12000;
const FLASH_MS = 1100;
const keyOf = (w: { envId: string; s?: Session; id?: string }) => `${w.envId}:${w.s?.id ?? w.id}`;

/**
 * Every chat that waits on you, in one black box at the top of the screen.
 * Closed, it is a pill: the first chat and how many more wait. A chat that
 * just started waiting opens it for a while without taking the keyboard.
 * Opened by the owner, it dims the screen and takes the keys: Ctrl+Enter
 * says yes, Ctrl+1..9 (or Ctrl+Alt+1..9) picks an answer, Esc closes. An answer moves on to
 * the next waiting chat.
 */
export function WaitingIsland({ client, items, ping, pick, onOpen }: {
  client: Client; items: Waiting[];
  /** A chat that just started waiting. */
  ping: IslandCall | null;
  /** The owner chose a waiting chat somewhere else, such as the sidebar. */
  pick: IslandCall | null;
  onOpen: (envId: string, s: Session) => void;
}) {
  const [mode, setMode] = useState<'closed' | 'peek' | 'open'>('closed');
  const [cur, setCur] = useState('');
  const [held, setHeld] = useState(false);
  const [perm, setPerm] = useState<Permission | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  // Answered here, until the machine says the chat moved on.
  const [answered, setAnswered] = useState<Set<string>>(() => new Set());
  const box = useRef<HTMLDivElement>(null);

  const answerKey = (w: Waiting) => `${keyOf(w)}:${w.s.ask?.requestId ?? w.s.updatedAt}`;
  const list = items.filter((w) => !answered.has(answerKey(w)));
  const index = Math.max(0, list.findIndex((w) => keyOf(w) === cur));
  const w = list[index] as Waiting | undefined;
  const s = w?.s;
  const ask = s?.status === 'blocked' ? s.ask : null;

  useEffect(() => {
    if (!ping) return;
    setCur(keyOf(ping));
    setMode((m) => m === 'open' ? m : 'peek');
  }, [ping]);
  useEffect(() => {
    if (!pick) return;
    setCur(keyOf(pick)); setMode('open');
  }, [pick]);
  useEffect(() => { if (!list.length && !flash) setMode('closed'); }, [list.length, flash]);
  // A peek leaves by itself unless a pointer or focus rests on it.
  useEffect(() => {
    if (mode !== 'peek' || held || busy || error) return;
    const timer = setTimeout(() => setMode('closed'), PEEK_MS);
    return () => clearTimeout(timer);
  }, [mode, held, busy, error, cur]);
  useEffect(() => { if (mode === 'open') box.current?.focus({ preventScroll: true }); }, [mode]);

  // The whole request (a question's answers, a command's buttons) comes
  // from the chat itself; the list only knows what kind it is.
  const requestId = ask?.requestId;
  useEffect(() => {
    setPerm(null); setError('');
    if (mode === 'closed' || !w || !ask) return;
    let live = true;
    client.rpc(w.envId, 'session.events', { id: w.s.id, tail: 1 })
      .then((r: any) => { if (live) setPerm((r?.pending as Permission[] | undefined)?.find((p) => !requestId || p.requestId === requestId) ?? r?.pending?.[0] ?? null); })
      .catch(() => { /* the button to open the chat still works */ });
    return () => { live = false; };
  }, [mode === 'closed', w?.envId, s?.id, requestId, s?.updatedAt]);

  const answer = async (decision: Decision, said: string) => {
    if (!w || !perm || busy) return;
    setBusy(true); setError('');
    try {
      await client.rpc(w.envId, 'session.answer', { id: w.s.id, requestId: perm.requestId, decision });
      const done = answerKey(w);
      const next = list[index + 1] ?? list[index - 1];
      setFlash(said);
      setTimeout(() => {
        setAnswered((a) => new Set(a).add(done));
        setFlash('');
        if (next) setCur(keyOf(next));
        else setMode('closed');
      }, FLASH_MS);
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };

  const choice = (p: Permission | null) => {
    if (!p) return null;
    const q = p.kind === 'question' && p.questions?.length === 1 && !p.questions[0].multiSelect && !p.questions[0].secret ? p.questions[0] : null;
    return q;
  };
  const question = choice(perm);
  const allow = perm && perm.kind !== 'question' && perm.kind !== 'edit' ? perm.options.find((o) => o.role === 'allow') : undefined;
  const always = allow && perm?.kind !== 'plan' ? perm?.options.find((o) => o.role === 'allow-always') : undefined;
  const deny = allow ? perm?.options.find((o) => o.role === 'deny') : undefined;
  const pickAnswer = (label: string) => question && void answer(
    { option: 'allow', answers: { [question.question]: label }, answerLists: { [question.question]: [label] } }, `Answered: ${label}`);
  const sayYes = () => allow && void answer({ option: 'allow' }, perm?.kind === 'plan' ? 'Plan approved' : 'Allowed');

  const close = () => setMode('closed');
  const open = () => { if (mode !== 'open') setMode('open'); };
  const step = (by: number) => { const n = list[(index + by + list.length) % list.length]; if (n) setCur(keyOf(n)); };
  const goToChat = () => { if (!w) return; close(); onOpen(w.envId, w.s); };

  useEffect(() => {
    if (mode !== 'open') return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (mod && e.key === 'Enter' && allow) { e.preventDefault(); e.stopPropagation(); sayYes(); return; }
      // By key position, so Ctrl+Alt+number (the chat card's keys) works too.
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
      if (mod && digit && question) {
        const o = question.options[Number(digit) - 1];
        if (o) { e.preventDefault(); e.stopPropagation(); pickAnswer(o.label); }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  if (!w && !flash) return null;
  const eng = s ? engineOf(s.engine) : null;
  const shown = mode !== 'closed' && !flash;
  const want = s ? waitingLine(s) : '';
  const hold = { onPointerEnter: () => setHeld(true), onPointerLeave: () => setHeld(false), onFocus: () => setHeld(true), onBlur: () => setHeld(false) };

  return <>
    {mode === 'open' && <div className="island-shade" onClick={close} />}
    <div
      ref={box} tabIndex={-1} {...hold}
      className={`island${shown ? ' open' : ''}${flash ? ' flash' : ''}`}
      role={shown ? 'dialog' : 'status'} aria-label={s ? `${s.title}: ${want}` : flash}
      onClick={mode === 'open' || flash ? undefined : open}
    >
      {flash ? (
        <div className="island-flash"><span className="island-tick"><Icon name="check" size={13} /></span>{flash}</div>
      ) : s && eng && <>
        <div className="island-pill">
          <span className="island-logo"><EngineMark engine={eng.cls} /></span>
          <b className="island-title">{notificationContext(s)}</b>
          {!shown && list.length > 1 && <span className="island-more">+{list.length - 1}</span>}
          {shown && list.length > 1 && <span className="island-nav">
            <button aria-label="Previous waiting chat" onClick={(e) => { e.stopPropagation(); step(-1); }}><Icon name="back" size={14} /></button>
            <span>{index + 1} of {list.length}</span>
            <button aria-label="Next waiting chat" onClick={(e) => { e.stopPropagation(); step(1); }}><Icon name="forward" size={14} /></button>
          </span>}
          {shown && <button className="island-x" aria-label="Close" onClick={(e) => { e.stopPropagation(); close(); }}><Icon name="close" size={14} /></button>}
        </div>
        {shown && <div className="island-body" key={keyOf(w!)}>
          <p className="island-where">{[eng.label, want.toLowerCase(), whereOf(s), w!.machine].filter(Boolean).join(' · ')}</p>
          {question ? <>
            <p className="island-q">{question.question}</p>
            <div className="island-opts">
              {question.options.map((o, i) => (
                <button key={o.label} className="island-opt" disabled={busy} onClick={() => pickAnswer(o.label)}>
                  <span className="island-n">{i + 1}</span>
                  <span className="island-ot">{o.label}{o.description && <small>{o.description}</small>}</span>
                  {mode === 'open' && i < 9 && <kbd>Ctrl {i + 1}</kbd>}
                </button>
              ))}
            </div>
          </> : perm?.kind === 'question' ? <p className="island-q">{perm.questions?.[0]?.question ?? perm.title}</p>
            : perm?.kind === 'command' ? <pre className="island-cmd">{String(perm.detail ?? '')}</pre>
            : perm?.kind === 'plan' ? <div className="island-plan"><Markdown text={String(perm.detail ?? '')} className="prose plan" /></div>
            : perm?.kind === 'tool' && perm.detail ? <pre className="island-cmd">{plainDetail(perm.detail)}</pre>
            : perm ? <p className="island-q">{perm.title}</p>
            : ask?.text ? <pre className={ask.kind === 'command' ? 'island-cmd' : 'island-q'}>{ask.text}</pre>
            : null}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="island-acts">
            {allow && <button className="island-yes" disabled={busy} onClick={sayYes}>
              {perm?.kind === 'plan' ? 'Go ahead' : 'Allow once'}{mode === 'open' && <kbd>Ctrl ↵</kbd>}
            </button>}
            {always && <button disabled={busy} onClick={() => void answer({ option: 'always' }, 'Always allowed')}>Always allow</button>}
            {deny && <button disabled={busy} onClick={() => void answer({ option: 'deny' }, 'Declined')}>Decline</button>}
            <span className="grow" />
            <button onClick={goToChat}>Open chat<Icon name="forward" size={14} /></button>
          </div>
        </div>}
      </>}
    </div>
  </>;
}
