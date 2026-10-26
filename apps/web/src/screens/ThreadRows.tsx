import { errorMessage } from '../errors';
import { useDismiss } from '../useDismiss';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Confirm, TextPrompt } from '../Modal';
import { useNow, waitingSince } from '../useNow';
import { ThreadStatus, moodOf, isUnread, useSeenVersion } from '../threadStatus';
import { plainProblem } from '../session/problem';
import { EngineMark } from '../EngineMark';
import { Icon } from '../Icon';
import { chatFolder, type Session } from '../client';
import { shownTitle, unknownThread } from '../format';
import { engineOf } from '../engines';
import { fadeWhenCut } from '../fadeWhenCut';
import { deleteKey } from '../session/chatKeys';

/**
 * A section that can be put away, with what it holds counted on the header.
 *
 * Archived threads are the reason it exists. Filing one away should not mean
 * losing it: it belongs on the screen it came from, behind one tap, rather
 * than in front of the work that is still live. A search opens it, because a
 * thread you are looking for by name is a thread you want found whether or
 * not you remember archiving it - and it stays open afterwards if you closed
 * it yourself, which is the one case where guessing would be rude.
 */
export function Fold({ title, count, note, noteTone, hint, kind, shelf = false, peek, openWhen = false, defaultOpen = false, attention = false, remember, showEmpty = false, actions, children }: {
  title: string; count: number; openWhen?: boolean; children: ReactNode;
  /** The sidebar's way: sentence case, quiet, and the count only once it is folded away. */
  shelf?: boolean;
  /** What stays on show when a shelf is folded - the chat you are in. */
  peek?: ReactNode;
  noteTone?: 'fresh';
  /** A project folder reads as a place, not as a category like "archived". */
  kind?: 'folder';
  /** A word beside the count - a machine name, the newest thread's age. */
  note?: string;
  /** Shown on hover over the name. */
  hint?: string;
  /** Groups that are the reason you opened the screen start open. */
  defaultOpen?: boolean;
  attention?: boolean;
  /** Keep the open state across visits, under this key. */
  remember?: string;
  showEmpty?: boolean;
  actions?: ReactNode;
}) {
  const [open, setOpenRaw] = useState(() => {
    if (remember) {
      try {
        const v = localStorage.getItem(`helm-fold:${remember}`);
        if (v !== null) return v === '1';
      } catch { /* storage denied: folds just forget */ }
    }
    return defaultOpen;
  });
  const setOpen = useCallback((v: boolean | ((p: boolean) => boolean)) => {
    setOpenRaw((prev) => {
      const next = typeof v === 'function' ? v(prev) : v;
      if (remember) {
        try { localStorage.setItem(`helm-fold:${remember}`, next ? '1' : '0'); } catch { /* full */ }
      }
      return next;
    });
  }, [remember]);
  useEffect(() => { if (openWhen) setOpen(true); }, [openWhen, setOpen]);
  if (!count && !showEmpty) return null;
  return (
    <div className={`foldwrap${kind ? ` ${kind}` : ''}`}>
      <div className={`section fold${open ? ' open' : ''}${attention ? ' attention' : ''}${kind ? ` ${kind}` : ''}${shelf ? ' shelf' : ''}`}>
        <button
          className="fold-toggle" aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="caret"><Icon name="forward" size={13} /></span>
          {kind === 'folder' && <Icon name="folder" size={15} className="foldicon" />}
          <span className="fold-title" title={hint}>{title}</span>
          {count > 0 && (!shelf || !open || attention) && <span className="count">{count}</span>}
          {note && <span className={`note-inline${noteTone ? ` ${noteTone}` : ''}`}>{note}</span>}
        </button>
        {actions && <span className="fold-actions">{actions}</span>}
      </div>
      {open ? children : peek}
    </div>
  );
}

export const SETTLED_FIRST = 10;

export const SETTLED_STEP = 25;

/** The first few rows, then "Show 25 more". The chat you are in is never left out. */
export function PagedRows<T extends { s: { id: string } }>({ items, isSelected, row, first, step }: {
  items: T[]; isSelected: (x: T) => boolean; row: (x: T) => ReactNode; first: number; step: number;
}) {
  const [limit, setLimit] = useState(first);
  const shown = items.filter((x, i) => i < limit || isSelected(x));
  const left = items.length - Math.min(limit, items.length);
  return (
    <>
      <div className="rows plain">{shown.map(row)}</div>
      {left > 0 && (
        <button type="button" className="shelf-more" onClick={() => setLimit((n) => n + step)}>
          Show {Math.min(step, left)} more
        </button>
      )}
    </>
  );
}

/**
 * The ⋯ on a thread row: continue, rename, archive, delete. One component, so
 * the sidebar's rows and the machine screen's rows offer the same things.
 */
export function ThreadActions({ s, onContinue, onRename, onArchive, onDelete, ending: askedToEnd, setEnding: setAskedToEnd }: {
  s: Session; onContinue?: () => void; onRename?: (title: string) => void; onArchive?: () => void; onDelete?: () => void;
  /** The delete question, when the row asks it (its Delete key). */
  ending?: boolean; setEnding?: (on: boolean) => void;
}) {
  const eng = engineOf(s.engine);
  const adopted = s.adopted;
  const found = s.id.startsWith('found:');
  const [menu, setMenu] = useState(false);
  useDismiss(menu, useCallback(() => setMenu(false), []));
  const [naming, setNaming] = useState(false);
  const [endingHere, setEndingHere] = useState(false);
  const ending = askedToEnd ?? endingHere;
  const setEnding = setAskedToEnd ?? setEndingHere;
  return (
    <>
      <button
        className="rowend" title="Show chat actions" aria-label={`Show actions for ${s.title}`} aria-haspopup="menu" aria-expanded={menu}
        onClick={(e) => { e.stopPropagation(); setMenu((open) => !open); }}
      ><Icon name="more" size={16} /></button>
      {menu && (
        <div className="menu row-menu" onClick={(e) => e.stopPropagation()}>
          {onContinue && (
            <button onClick={() => { setMenu(false); onContinue(); }}>Continue in a new chat</button>
          )}
          {onRename && !adopted && (
            <button onClick={() => { setMenu(false); setNaming(true); }}>Rename chat</button>
          )}
          {onArchive && (
            <button onClick={() => { setMenu(false); onArchive(); }}>
              {s.archived ? 'Restore chat' : 'Archive chat'}
            </button>
          )}
          {onDelete && (
            <button className="destructive" onClick={() => { setMenu(false); setEnding(true); }}>
              {found ? 'Remove from Helm' : adopted ? 'Close this terminal' : 'Delete chat'}
            </button>
          )}
        </div>
      )}
      {naming && onRename && (
        <TextPrompt
          title="Name this chat" value={s.title}
          onCancel={() => setNaming(false)}
          onSubmit={(t) => { setNaming(false); if (t !== s.title) onRename(t); }}
        />
      )}
      {ending && onDelete && (
        <Confirm
          title={found ? `Remove "${s.title}"?` : adopted ? `Close "${s.title}"?` : `Delete "${s.title}"?`}
          // Three different things wear this one menu item, so each says
          // what it really does. helm never deletes a CLI's own history:
          // that conversation is the owner's, not our record.
          body={found
            ? `${eng.label} keeps the chat. Helm removes it from the list.`
            : adopted
              ? 'This closes the program in that terminal. Helm did not start it.'
              : 'This stops the agent. Helm permanently removes the chat.'}
          confirmLabel={found ? 'Remove' : adopted ? 'Close' : 'Delete'} danger confirmKey="Delete"
          onCancel={() => setEnding(false)}
          onConfirm={() => { setEnding(false); onDelete(); }}
        />
      )}
    </>
  );
}

const dirName = (p = '') => p.replace(/\/+$/, '').split('/').pop() || '~';

/** Where a thread runs, in a word: its folder, or "quick chat" when it has none. */
export const whereOf = (s: Session) => (s.quick ? 'quick chat' : dirName(chatFolder(s)));

/**
 * A session that is waiting on you, as the first thing on Home.
 *
 * It says what is asking and where, and how long it has been waiting; the
 * answer itself lives in the session, where the diff or the command is on
 * screen to be read before Allow is tapped.
 */
/** "3:40 pm", "tomorrow 9:00 am", "Mon 9:00 am" - when a snooze ends, in words. */
export const NEVER_SNOOZE = Number.MAX_SAFE_INTEGER;

export const when = (ts: number) => {
  if (ts === NEVER_SNOOZE) return 'Never';
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((new Date(d.toDateString()).getTime() - new Date(new Date().toDateString()).getTime()) / 86_400_000);
  return days <= 0 ? time : days === 1 ? `tomorrow ${time}` : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
};

/** Short delays, or keep this thread quiet until it is opened again. */
function snoozeChoices(): { label: string; at: number }[] {
  const now = Date.now();
  return [
    { label: '5 mins', at: now + 5 * 60_000 },
    { label: '1 hr', at: now + 3_600_000 },
    { label: '3 hrs', at: now + 3 * 3_600_000 },
    { label: 'Never', at: NEVER_SNOOZE },
  ];
}

const NEED_GO: Record<string, string> = {
  question: 'Answer', command: 'Review the command', edit: 'Review the change', plan: 'Review the plan', tool: 'Review and allow',
};

export function NeedCard({ s, machine, onOpen, onSnooze, onDismiss }: { s: Session; machine: string; onOpen: () => void; onSnooze: (until: number) => void; onDismiss: () => Promise<void> }) {
  const now = useNow();
  const [choosing, setChoosing] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [dismissError, setDismissError] = useState('');
  const dismiss = async () => {
    setDismissing(true); setDismissError('');
    try { await onDismiss(); }
    catch (error: any) { setDismissError(errorMessage(error, { fallback: 'Helm cannot clear this failure alert. Try again.' })); }
    finally { setDismissing(false); }
  };
  const eng = engineOf(s.engine);
  const n = s.pending ?? 0;
  const ask = s.status === 'blocked' ? s.ask : null;
  const problem = s.status !== 'blocked' && s.recovery ? plainProblem(s.recovery.kind, s.recovery.message) : null;
  return (
    <div className={`need${s.recovery && s.status !== 'blocked' ? ' need-recovery' : ''}`}>
      <button className="need-main" onClick={onOpen} title={problem?.text}>
        <span className="need-k">
          <i />{s.status === 'blocked' || s.team?.blocked ? 'Needs you' : problem?.title ?? (s.team?.failed ? 'Helper task failed' : 'Needs you')}{s.updatedAt ? ` · ${waitingSince(s.updatedAt, now)}` : ''}
          {n > 1 && <span className="need-n">{n}</span>}
        </span>
        <span className="need-t">
          <EngineMark engine={eng.cls} />
          <span className="grow">
            <span className="need-title">{s.title}</span>
            <span className="need-m">{[eng.label, whereOf(s), machine].filter(Boolean).join(' · ')}</span>
          </span>
        </span>
        {ask?.text && <span className={`need-q${ask.kind === 'command' ? ' mono' : ''}`}>{ask.text}{ask.more ? ` (+${ask.more} more)` : ''}</span>}
        <span className="need-go">{s.team?.blocked ? `${s.team.blocked} helper tasks need approval` : s.team?.failed ? `${s.team.failed} helper ${s.team.failed === 1 ? 'task' : 'tasks'} failed` : s.recovery && !ask ? 'View task' : NEED_GO[ask?.kind ?? ''] ?? 'Review and answer'}<Icon name="forward" size={15} /></span>
      </button>
      <div className={`need-foot${s.team?.failed ? ' has-dismiss' : ''}${choosing ? ' is-choosing' : ''}`}>
        {!choosing ? (
          <>
            {!!s.team?.failed && <button className="need-snooze need-dismiss" disabled={dismissing} onClick={() => void dismiss()}
              title="Clear this helper failure alert on all devices. Its history stays. New failures show alerts.">{dismissing ? 'Dismissing…' : s.team.failed === 1 ? 'Dismiss failure' : 'Dismiss failures'}</button>}
            <button className="need-snooze" onClick={() => setChoosing(true)}>Snooze…</button>
          </>
        ) : (
          <div className="snooze-opts">
            {snoozeChoices().map((c) => (
              <button key={c.label} onClick={() => onSnooze(c.at)}>{c.label}</button>
            ))}
            <button className="snooze-x" onClick={() => setChoosing(false)} aria-label="cancel"><Icon name="close" size={14} /></button>
          </div>
        )}
      </div>
      {dismissError && <p className="error" role="alert">{dismissError}</p>}
    </div>
  );
}

/**
 * A chat in the sidebar. A settled chat is one line: the title, one status
 * at the right edge (its age, "new", or a word that says more), and the
 * agent. A running chat adds a second line: its folder, machine and branch.
 */
export function HomeRow({ s, machine, onOpen, note, selected = false, slim = false, actions }: {
  s: Session; machine: string; onOpen: () => void; note?: string; selected?: boolean;
  /** One line: the title, its status and the agent. */
  slim?: boolean;
  /** Rename, archive, delete - the same ⋯ the machine screen's rows have. */
  actions?: { onContinue?: () => void; onRename?: (title: string) => void; onArchive?: () => void; onDelete?: () => void };
}) {
  const now = useNow();
  useSeenVersion();
  const eng = engineOf(s.engine);
  const mood = moodOf(s, isUnread(s));
  const name = shownTitle(s.title);
  const where = [whereOf(s), machine, s.branch, eng.label].filter(Boolean).join(' · ');
  // A word that says more than the age does takes its place.
  const chip = mood === 'working' || mood === 'needs' || mood === 'failed' ? null
    : s.recovery?.kind === 'interrupted' ? <span className="chip exited">stopped</span>
    : unknownThread(s) ? <StatusChip status="unknown" />
    : s.externalActive || (s.shared && s.alive) ? <span className="chip">Ready</span> : null;
  const title = <span className={`tri-title${name.cut ? ' cut' : ''}`} ref={fadeWhenCut}>{name.text}</span>;
  const status = note && slim ? <span className="tstat quiet" data-mood="quiet">{note}</span> : chip ?? <ThreadStatus s={s} mood={mood} now={now} />;
  const mark = <EngineMark engine={eng.cls} className="tri-mark" />;
  // A row with focus takes the Delete key for its own chat, before the open chat can.
  const [ending, setEnding] = useState(false);
  return (
    <div className={`row tall rowx tri-row mood-${mood}${slim ? ' slim' : ''}${selected ? ' active' : ''}`}>
      <button
        className={`rowmain thread-row tri${slim ? ' slim' : ''}${selected ? ' active' : ''}`} aria-current={selected ? 'page' : undefined} onClick={onOpen}
        onKeyDown={actions?.onDelete ? (e) => { if (deleteKey(e, e.currentTarget)) { e.preventDefault(); setEnding(true); } } : undefined}
        title={`${s.title}\n${where}`} data-where={where}
      >
        {slim ? <>{title}{status}{mark}</> : <>
          <span className="tri-top">{title}{status}</span>
          <span className="tri-bot">
            <Icon name={s.quick ? 'bolt' : 'folder'} size={12} />
            <span className="tri-where">{[whereOf(s), machine].filter(Boolean).join(' · ')}</span>
            {note && <span className="tri-note">{note}</span>}
            {s.branch && <><Icon name="branch" size={12} /><span className="tri-branch">{s.branch}</span></>}
            <span className="tri-end">{mark}</span>
          </span>
        </>}
      </button>
      {actions && <ThreadActions s={s} {...actions} ending={ending} setEnding={setEnding} />}
    </div>
  );
}

export function StatusChip({ status, at }: { status: string; at?: number }) {
  // `at` is when the thread entered this status: "working" gains "14m",
  // which is the difference between a turn that just started and one that
  // has been chewing for a while. Under a minute it says nothing - the
  // word alone is already the whole story.
  const now = useNow();
  const ago = at ? waitingSince(at, now) : '';
  const age = ago && ago !== 'just now' ? ` ${ago}` : '';
  if (status === 'blocked') return <span className="chip blocked"><i />waiting{age}</span>;
  if (status === 'working') return <span className="chip working"><i />working{age}</span>;
  if (status === 'compacting') return <span className="chip working"><i />Summarizing chat</span>;
  if (status === 'starting') return <span className="chip working"><i />starting</span>;
  if (status === 'done') return <span className="chip done"><i />done</span>;
  if (status === 'exited') return <span className="chip exited">ended</span>;
  if (status === 'unknown') return <span className="chip exited" title="The machine cannot report if this agent is working.">Status unknown</span>;
  return null;
}
