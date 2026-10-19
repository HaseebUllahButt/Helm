import { useDismiss } from '../useDismiss';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Confirm, TextPrompt } from '../Modal';
import { useNow, waitingSince } from '../useNow';
import { EngineMark } from '../EngineMark';
import { sendAction } from '../send/store';
import { BackIcon, Icon } from '../Icon';
import { Client, type Environment, type Session, type SendJob, type InventorySession, type Project } from '../client';
import { money, busyWord, needsAttention, runningThread } from '../format';
import { engineOf } from '../engines';
import { useLiveInterval } from '../useLiveInterval';
import { shortPath, ownTerminal, byRecent, ago } from './common';
import { Play, Meter, Gear } from './icons';
import { Fold, StatusChip, ThreadActions } from './ThreadRows';

/**
 * A folder's short name, and the path only when it says something extra.
 *
 * The last segment is what anyone calls a project - "helm", "t3-app" - but it
 * is not unique: `~/dev/me/github/helm` and `~/Helm` are two different
 * projects that would both be called "helm". The full path goes beside it,
 * except where it would just repeat the name back ("~" under "~").
 */
const projectNote = (cwd: string) => {
  const name = cwd.split('/').filter(Boolean).pop() || cwd;
  return name === cwd ? undefined : cwd;
};

const pathOf = (s: Session) => (s.quick ? 'quick chat' : shortPath(s.cwd));

/**
 * How far back a machine screen looks, and what the window does not apply to.
 *
 * A machine that has been worked at for months answers `session.list` with
 * months of threads, and every one of them used to be on the screen. Almost
 * none of them are what anyone came for: the work you are in the middle of
 * happened this week. Anything alive, working, or waiting on a person is
 * exempt however old its record says it is - a session that is running is
 * current by definition, and hiding one behind a fold is the one mistake this
 * app cannot make.
 */
const WEEK = 7 * 24 * 60 * 60_000;

const thisWeek = (s: Session) =>
  s.alive === true || needsAttention(s) || runningThread(s) ||
  (s.updatedAt ?? 0) >= Date.now() - WEEK;

/** `~/x` on the machine and `/home/u/x` on the wire are the same folder. */
const collapseCwd = (p: string) => p.replace(/^\/home\/[^/]+/, '~');

const sameDir = (a: string, b: string) => collapseCwd(a) === collapseCwd(b);

/** An inventory row wearing the shape a session row draws. */
const foundRow = (x: InventorySession): Session => ({
  id: `found:${x.engine}:${x.id}`,
  title: x.title, cwd: x.cwd, engine: x.engine,
  profileId: '', status: x.status ?? (x.active ? 'working' : 'done'), turns: x.turns, adopted: true, alive: !!x.active,
  externalActive: !!x.active,
  archived: !!x.archived,
  model: x.model ?? null, updatedAt: x.updatedAt,
  // What `session.resume` needs to pick the conversation back up: the CLI's
  // own id, and the account it was recorded under - a thread written by one
  // login cannot be resumed by another, because the transcript is not there.
  engineSessionId: x.id,
  account: x.account,
});

/**
 * The threads a machine's CLIs recorded on their own minus the ones this
 * screen already shows: helm's own record of the same thread (its
 * engineSessionId is the CLI's id). A terminal in the same folder is not
 * proof of identity: hiding history for it leaves only a terminal to open.
 */
function dedupeDetected(list: Session[], found: InventorySession[]): InventorySession[] {
  const own = new Set(list.filter((s) => s.engineSessionId).map((s) => `${s.engine}:${s.engineSessionId}`));
  return found.filter((x) => !own.has(`${x.engine}:${x.id}`));
}

/**
 * The WhatsApp agent keeps one opencode thread per chat, titled
 * `whatsapp-<jid>`, and it talks often enough to fill this screen with its
 * own plumbing. They are the bot's threads, not yours, so none of the lists
 * below show them.
 */
const botThread = (s: Session) => /^whatsapp-/i.test(s.title);

export function EnvView({ client, env, wide, sessions, remembered, rememberedAt, reload, onBack, onNewSession, onAddProject, onSendProject, onIntegrations, onCheckProject, onStart, onSettings, onUsage, onMedia, onOpen, onResume, resuming, isSnoozed = () => false, sendJobs = [], sendTarget }: {
  client: Client; env: Environment; wide: boolean; sessions: Session[]; sendJobs?: SendJob[]; sendTarget?: string;
  isSnoozed?: (session: Session) => boolean;
  /** What this machine last said it was running, while it cannot be asked. */
  remembered?: Session[]; rememberedAt?: number;
  reload: () => void; onBack: () => void; onNewSession: () => void; onAddProject: () => void;
  onIntegrations: () => void;
  onSendProject: (cwd?: string) => void; onCheckProject: (path: string) => void;
  onStart: (cwd: string) => void;
  onSettings: () => void;
  onUsage: () => void; onMedia: () => void; onOpen: (s: Session) => void;
  /** Continue a conversation a CLI recorded on its own; starts the engine. */
  onResume: (s: Session) => void;
  resuming: string | null;
}) {
  const [direct, setDirect] = useState(false);
  const [ping, setPing] = useState<number | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  /** Filing several threads away at once, rather than one ⋯ at a time. */
  const [selecting, setSelecting] = useState(false);
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const now = useNow();
  const scrollRef = useRef<HTMLDivElement>(null);
  const pullFrom = useRef<number | null>(null);
  const [pull, setPull] = useState(0);

  useEffect(() => {
    client.subscribe(env.id);
    reload();
    return client.on((e, kind, payload) => {
      if (e === env.id && kind === 'transport') setDirect(payload.direct);
      if (e === env.id && kind === 'latency') setPing(payload.ms);
    });
  }, [client, env.id, reload]);

  // Measured while you are looking at the machine, which is also when the
  // terminal wants to know whether to draw keystrokes before they land.
  useEffect(() => client.watchLatency(env.id), [client, env.id]);

  // Which pair of addresses a "direct" connection settled on. Two `host`
  // candidates are the same wifi and a millisecond; two `srflx` ones went
  // out to the internet and came back, which is direct in name only.
  const [route, setRoute] = useState<{ local?: string; remote?: string } | null>(null);
  const look = useCallback(() => {
    client.route(env.id).then((r) => setRoute(r)).catch(() => {});
  }, [client, env.id]);
  useEffect(() => { if (direct) look(); else setRoute(null); }, [direct, look]);
  useLiveInterval(direct ? 10_000 : null, look, [look]);

  useEffect(() => {
    if (env.online) client.openDirect(env.id).catch(() => {});
  }, [client, env.id, env.online]);

  // Threads the machine's CLIs recorded without helm - devin or opencode run
  // by hand in a terminal show up here, marked external, instead of the
  // machine looking like nothing ever happened on it.
  const [earlier, setEarlier] = useState<InventorySession[]>([]);
  const [historyLimit, setHistoryLimit] = useState(40);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const historySequence = useRef(0);
  useEffect(() => { setHistoryLimit(40); }, [query, env.id]);
  // Named, because archiving one of these has to refresh the list it came
  // from - the machine is the only place that remembers what was filed away.
  const reloadEarlier = useCallback(() => {
    const sequence = ++historySequence.current;
    if (!env.online) { setEarlier([]); setHasMoreHistory(false); setHistoryBusy(false); return; }
    setHistoryBusy(true);
    client.rpc(env.id, 'session.inventory', { limit: historyLimit, query }, 20_000)
      .then((r: any) => {
        if (sequence !== historySequence.current) return;
        setEarlier(r.recent ?? []); setHasMoreHistory(!!r.hasMore);
      })
      .catch(() => {})
      .finally(() => { if (sequence === historySequence.current) setHistoryBusy(false); });
  }, [client, env.id, env.online, historyLimit, query]);
  useEffect(() => {
    const timer = setTimeout(reloadEarlier, query ? 150 : 0);
    return () => { clearTimeout(timer); historySequence.current++; };
  }, [reloadEarlier]);
  useLiveInterval(env.online ? 60_000 : null, reloadEarlier, [reloadEarlier, env.online]);

  const [projects, setProjects] = useState<Project[]>([]);
  const [projectError, setProjectError] = useState('');
  const projectSequence = useRef(0);
  const [renaming, setRenaming] = useState<Project | null>(null);
  const [removing, setRemoving] = useState<Project | null>(null);
  const [projectBusy, setProjectBusy] = useState(false);
  const reloadProjects = useCallback(() => {
    const sequence = ++projectSequence.current;
    if (!env.online) { setProjects([]); setProjectError(''); return; }
    client.rpc<{ projects: Project[] }>(env.id, 'project.list', {}, 20_000)
      .then(result => {
        if (sequence !== projectSequence.current) return;
        setProjects(result.projects ?? []);
        setProjectError('');
      })
      .catch(error => {
        if (sequence === projectSequence.current) setProjectError(error.message);
      });
  }, [client, env.id, env.online]);
  const projectCwds = sessions.filter((s) => s.engine !== 'shell').map((s) => s.cwd ?? '').sort().join('\n');
  useEffect(() => {
    reloadProjects();
    const off = client.on((machine, kind, payload) => {
      if ((kind === 'connection' && payload?.online)
        || (machine === env.id && ((kind === 'transport' && payload?.direct) || (kind === 'presence' && payload?.online)))) reloadProjects();
    });
    return () => { off(); projectSequence.current++; };
  }, [client, env.id, reloadProjects, projectCwds]);

  const openTerminal = async () => {
    // Back to the terminal you left, with whatever is running in it still
    // running: the button used to start a fresh shell and close the old one,
    // which killed a build or a server mid-run. A new one is the + beside
    // the terminal's tabs.
    const open = sessions.filter(ownTerminal).sort(byRecent)[0];
    if (open) { onOpen(open); return; }
    setOpening(true); setError('');
    try {
      const r = await client.rpc<{ session: Session }>(env.id, 'session.start',
        { cwd: '~', profileId: 'shell' }, 45_000);
      reload();
      onOpen(r.session);
    } catch (e: any) { setError(e.message); }
    finally { setOpening(false); }
  };

  // One box for the whole screen. The folder is part of what you are looking
  // for - "the helm one on codex" is a path and an engine, not a title - so
  // all three are what the words are matched against.
  const q = query.trim().toLowerCase();
  const hit = (s: Session) =>
    !q || `${s.title} ${s.quick ? 'quick chat' : s.cwd} ${engineOf(s.engine).label}`.toLowerCase().includes(q);

  // Threads this machine's CLIs recorded without helm, beside helm's own.
  const detected = dedupeDetected(sessions, earlier);
  const external = detected.map(foundRow).filter((s) => !botThread(s));
  // A terminal is reached through the machine's terminal button and kept
  // alive for that button to reopen. It is not a chat and should never be
  // recorded in the thread, archive or search lists.
  const rows = [...sessions.filter((s) => s.engine !== 'shell'), ...external];

  const live = (s: Session) => s.engine !== 'shell' && !s.archived && hit(s);
  const mine = rows.filter(live);
  const attention = (s: Session) => needsAttention(s) && !isSnoozed(s);
  const blocked = mine.filter(attention).sort(byRecent);
  // An offline machine cannot say what is running now. Its last word stays
  // in the lists below, marked as old, never under "working": the sidebar
  // keeps it out of Running for the same reason.
  const working = env.online ? mine.filter((s) => !attention(s) && runningThread(s)).sort(byRecent) : [];
  const workingIds = new Set(working.map((s) => s.id));
  const rest = mine.filter((s) => !attention(s) && !workingIds.has(s.id));
  const recent = rest.filter((s) => !botThread(s)).sort(byRecent).slice(0, 5);
  const recentIds = new Set(recent.map((s) => s.id));

  // A thread belongs to a project by its folder - or by being in a worktree of it.
  const belongsTo = (s: Session, p: Project) =>
    sameDir(s.cwd || '~', p.path) || (p.worktrees ?? []).some((w) => sameDir(s.cwd || '~', w));
  const projectFolds = projects
    .map((p) => ({
      project: p,
      list: rest.filter((s) => !recentIds.has(s.id) && belongsTo(s, p)).sort(byRecent),
      // Threads of this project already standing under "recent" above. They
      // are counted, or the header said 0 next to a thread you can see.
      above: recent.filter((s) => belongsTo(s, p)).length,
      // When anything last happened here, for the note beside the name.
      last: Math.max(0, ...rows.filter((s) => !s.archived && belongsTo(s, p)).map((s) => s.updatedAt ?? 0)),
    }))
    .filter(({ project: p, list, above }) =>
      !q || list.length + above > 0 || `${p.title} ${p.path}`.toLowerCase().includes(q));
  const inProject = new Set(projectFolds.flatMap(({ list }) => list.map((s) => s.id)));

  // Threads from this week in folders helm has never started anything in,
  // newest first and capped - until someone types, and then the cap is the
  // thing standing between them and what they are looking for.
  const strays = rest
    .filter((s) => !inProject.has(s.id) && !recentIds.has(s.id) && thisWeek(s)).sort(byRecent);
  const [allElsewhere, setAllElsewhere] = useState(false);
  const elsewhere = q || allElsewhere ? strays : strays.slice(0, 8);

  // Everything either side of the week, in one flat list rather than a second
  // set of folders: what is in here is, by definition, not what you are
  // working on. It has to stay reachable, though - "it is not here" and "it
  // is one tap down" are different answers and only one of them is true.
  const older = rest
    .filter((s) => !inProject.has(s.id) && !recentIds.has(s.id) && !thisWeek(s)).sort(byRecent);

  // Archived threads are on the machine they were archived on, folded away.
  const filed = rows.filter((s) => s.archived && hit(s)).sort(byRecent);

  // Enough on this machine that finding one by eye is work. The box stays
  // once something is typed in it, however few rows the typing leaves.
  const searchable = rows.length > 5 || !!q;

  /** The thread just filed away, for as long as taking it back is one tap. */
  const [undo, setUndo] = useState<Session | null>(null);
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), 7000);
    return () => clearTimeout(timer);
  }, [undo]);

  const setArchived = async (s: Session, archived: boolean, offerUndo = true) => {
    setError('');
    try {
      await client.rpc(env.id, 'session.archive', { id: s.id, archived }, 20_000);
      reload(); reloadEarlier();
      // Archiving is a tap on a small ⋯ menu item with nothing to confirm it:
      // say what happened and leave the way back in reach.
      setUndo(archived && offerUndo ? s : null);
    } catch (e: any) { setError(e.message); }
  };

  const deleteSession = async (s: Session) => {
    setError('');
    try {
      await client.rpc(env.id, 'session.kill', { id: s.id }, 20_000);
      reload(); reloadEarlier();
    } catch (e: any) { setError(e.message); }
  };

  // The `found:` pile is mostly threads nobody opens twice, but the ⋯ menu
  // archives one at a time. Select mode trades the menus for checkboxes and
  // files them together; a row that fails stays marked so the count of what
  // is left is honest.
  const archiveMarked = async () => {
    setError('');
    const left = new Set(marked);
    for (const id of marked) {
      try { await client.rpc(env.id, 'session.archive', { id, archived: true }, 20_000); left.delete(id); }
      catch (e: any) { setError(e.message); }
    }
    setMarked(left);
    if (!left.size) setSelecting(false);
    reload(); reloadEarlier();
  };

  const setTitle = async (s: Session, title: string) => {
    setError('');
    try { await client.rpc(env.id, 'session.title', { id: s.id, title }, 20_000); reload(); }
    catch (e: any) { setError(e.message); }
  };

  const renameProject = async (p: Project, title: string) => {
    setProjectBusy(true); setError('');
    try {
      await client.rpc(env.id, 'project.save', { path: p.path, title }, 20_000);
      reloadProjects();
    } catch (e: any) { setError(e.message); }
    finally { setProjectBusy(false); }
  };

  const removeProject = async () => {
    const p = removing;
    if (!p) return;
    setProjectBusy(true); setError('');
    try {
      await client.rpc(env.id, 'project.remove', { path: p.path }, 20_000);
      setRemoving(null);
      reloadProjects();
    } catch (e: any) { setRemoving(null); setError(e.message); }
    finally { setProjectBusy(false); }
  };

  /**
   * One row, wherever it is standing.
   *
   * A thread helm started opens. An inactive history row resumes first; an
   * active one becomes a live transcript monitor and hands off to Helm once
   * the external CLI releases its writer lock.
   */
  const toggle = (id: string) => setMarked((m) => {
    const next = new Set(m);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const row = (s: Session) => s.id.startsWith('found:') ? (
    <SessionRow
      key={s.id} s={s} busy={resuming === s.id} offline={!env.online}
      selecting={selecting} marked={marked.has(s.id)} onToggle={() => toggle(s.id)}
      onOpen={env.online && !selecting ? () => onResume(s) : undefined}
      onArchive={() => setArchived(s, !s.archived)}
      onDelete={() => deleteSession(s)}
    />
  ) : (
    <SessionRow
      key={s.id} s={s} onOpen={() => onOpen(s)} offline={!env.online} attentionSuppressed={isSnoozed(s)}
      selecting={selecting} marked={marked.has(s.id)} onToggle={() => toggle(s.id)}
      onRename={(t) => setTitle(s, t)}
      onArchive={() => setArchived(s, !s.archived)}
      onDelete={() => deleteSession(s)}
    />
  );

  return (
    <>
      <div className="bar machine-bar">
        {!wide && <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>}
        <div className="titles">
          <h1>{env.name}</h1>
          <span className={`sub netline${env.online ? '' : ' down'}`}>
            <i className={`mdot ${env.online ? 'on' : 'off'}`} />
            {/* "direct" over two srflx candidates went out to the internet and
                back; that is worth saying, the ordinary same-wifi case is not. */}
            {env.online
              ? (direct
                ? (route && !(route.local === 'host' && route.remote === 'host') ? 'direct, over the internet' : 'direct')
                : 'via home')
              : 'offline'}
            {env.online && ping != null && (
              // The number matters because the two routes differ by two
              // orders of magnitude, and a relayed phone that feels broken
              // is usually just far away. Saying so is the difference
              // between "helm is slow" and "this connection is slow".
              <span className={ping > 250 ? 'quiet slow' : 'quiet'}> · {Math.round(ping)}ms</span>
            )}
          </span>
        </div>
        {/* The media view only exists on a machine that is a nas: elsewhere
            the button would be an offer the daemon has to refuse. */}
        {env.kind === 'nas' && (
          <button className="iconbtn" title={`media on ${env.name}`} aria-label={`media on ${env.name}`} onClick={onMedia}><Play /></button>
        )}
        <button
          className="iconbtn mono"
          // A machine with no pty falls back to sampling a herdr pane's
          // screen, which is slow enough to be worth saying before you open
          // one and wonder what is wrong with it.
          title={env.info.terminals === 'panes' ? 'terminal (slow: no pty on this machine)' : 'terminal'}
          aria-label={env.info.terminals === 'panes' ? 'terminal (slow: no pty on this machine)' : 'terminal'}
          disabled={!env.online || opening}
          onClick={openTerminal}
        ><Icon name="terminal" size={18} />{env.info.terminals === 'panes' && <b className="slowmark" aria-hidden="true">!</b>}</button>
        <button className="iconbtn" title={`what ${env.name} has cost`} aria-label={`what ${env.name} has cost`} onClick={onUsage}><Meter /></button>
        <button className="iconbtn" title={`${env.name} settings`} aria-label={`${env.name} settings`} onClick={onSettings}><Gear /></button>
      </div>

      <div
        className="scroll" ref={scrollRef}
        // A pull at the top of the list is the gesture everyone already
        // knows for "check again" - and on a machine that just woke up it
        // beats waiting for the 15-second tick to notice.
        onTouchStart={(e) => { pullFrom.current = scrollRef.current?.scrollTop === 0 ? e.touches[0].clientY : null; }}
        onTouchMove={(e) => {
          if (pullFrom.current == null) return;
          setPull(Math.max(0, Math.min(90, e.touches[0].clientY - pullFrom.current)));
        }}
        onTouchEnd={() => {
          if (pull > 70) { reload(); reloadEarlier(); reloadProjects(); }
          setPull(0); pullFrom.current = null;
        }}
      ><div className="pad column">
        {pull > 0 && (
          <div className="pull" style={{ height: pull }}>
            {pull > 70 ? 'release to refresh' : ''}
          </div>
        )}
        {!env.online && (
          <div className="banner warn">
            Offline{env.lastSeen ? ` · last seen ${ago(env.lastSeen)}` : ''}. Threads open again when it is back.
          </div>
        )}

        {/* The machine's front door: a question and a wide box that starts a
            chat, the way an empty chat looks. Sending a project and managing
            connections are the rarer errands, so they sit under it, small. */}
        <div className="home-hero">
          <h2 className="home-title">
            {env.online ? <>What should we build on <span className="home-machine">{env.name}</span>?</> : <><span className="home-machine">{env.name}</span> is offline</>}
          </h2>
          <p className={`home-state${env.online ? '' : ' down'}`}>
            <i className={`mdot ${env.online ? 'on' : 'off'}`} />
            {env.online ? 'online' : 'offline'}
            {env.online && (blocked.length + working.length > 0) && ` · ${blocked.length + working.length} running`}
            {env.online && (blocked.length > 0) && ` · ${blocked.length} need${blocked.length === 1 ? 's' : ''} you`}
          </p>
        </div>
        <button className="home-compose" disabled={!env.online} onClick={onNewSession} aria-label="New chat" title={`New chat on ${env.name}`}>
          <span className="plus"><Icon name="plus" size={16} /></span>
          <span className="home-compose-text">New chat</span>
          <span className="home-compose-hint">pick a folder and an agent</span>
          <kbd className="home-compose-key">{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'} N</kbd>
        </button>
        <div className="home-quick">
          <button className="linkish" disabled={!env.online} onClick={() => onSendProject()} title="Send a project to another machine" aria-label="Send a project">
            <Icon name="transfer" size={15} /><span>Send a project</span>
          </button>
          <button className="linkish" disabled={!env.online} onClick={onIntegrations} title="Manage agent connections, skills and plugins">
            <Icon name="tool" size={15} /><span>Connectors &amp; skills</span>
          </button>
        </div>

        {searchable && (
          <div className="filterbar">
            <input
              className="sheetfilter grow" value={query} placeholder={`search ${env.name}`}
              autoCapitalize="off" autoCorrect="off" autoComplete="off"
              onChange={(e) => setQuery(e.target.value)}
            />
            {env.online && (
              <button
                className={`linkish${selecting ? ' on' : ''}`}
                onClick={() => { setSelecting((v) => !v); setMarked(new Set()); }}
              >{selecting ? 'done' : 'select'}</button>
            )}
          </div>
        )}

        {selecting && (
          <div className="selbar">
            <span>{marked.size ? `${marked.size} picked` : 'tap threads to pick them'}</span>
            <span className="spacer" />
            <button className="linkish" disabled={!marked.size} onClick={archiveMarked}>
              archive {marked.size || ''}
            </button>
          </div>
        )}

        {/* A session waiting on a person is the reason this app exists, so
            that group is never behind a tap; nor is what is running right
            now. Everything else is filed under its project, folded, which is
            what makes the top of the screen readable on a phone at all. */}
        {blocked.length > 0 && (
          <div>
            <div className="section attention">needs you</div>
            <div className="rows plain">{blocked.map(row)}</div>
          </div>
        )}
        {working.length > 0 && (
          <div>
            <div className="section">running here</div>
            <div className="rows plain">{working.map(row)}</div>
          </div>
        )}
        {recent.length > 0 && (
          <div>
            <div className="section">recent</div>
            <div className="rows plain">{recent.map(row)}</div>
          </div>
        )}
        {projectFolds.length > 0 && <div className="section">projects</div>}
        {projectFolds.map(({ project: p, list, above, last }) => (
          <Fold
            key={p.path}
            kind="folder"
            title={p.title}
            count={list.length + above}
            // Two projects with the same name need their paths to be told
            // apart; otherwise the useful thing to say is when it last moved.
            note={projects.some((o) => o !== p && o.title === p.title) || !last ? projectNote(p.path) : ago(last)}
            hint={p.path}
            openWhen={!!q}
            remember={`${env.id}:${p.path}`}
            showEmpty
            actions={(
              <ProjectActions
                title={p.title} online={env.online} sendLabel={sendAction(sendJobs, env.id, p.path, sendTarget)}
                onStart={() => onStart(p.path)}
                onSend={() => onSendProject(p.path)}
                onCheck={() => onCheckProject(p.path)}
                onRename={() => setRenaming(p)}
                onRemove={() => setRemoving(p)}
              />
            )}
          >
            {list.length ? (
              <div className="rows plain">{list.map(row)}</div>
            ) : (
              <div className="empty quiet folder-empty">
                {above ? `The latest thread in ${p.title} is under recent` : `No threads in ${p.title} yet`}
                <div className="note">
                  <button className="linkish" disabled={!env.online} onClick={() => onStart(p.path)}>
                    Start one here
                  </button>
                </div>
              </div>
            )}
          </Fold>
        ))}

        {/* This week, but in folders nothing was ever started in from here:
            a CLI run by hand in a scratch directory. Worth keeping, not worth
            a project of its own. */}
        <Fold
          title="elsewhere" count={strays.length}
          openWhen={!!q}
          remember={`${env.id}:~elsewhere`}
        >
          <div className="rows plain">{elsewhere.map(row)}</div>
          {strays.length > elsewhere.length && (
            <button className="linkish more" onClick={() => setAllElsewhere(true)}>
              show {strays.length - elsewhere.length} more
            </button>
          )}
        </Fold>
        <Fold title="older" count={older.length} openWhen={!!q} remember={`${env.id}:~older`}>
          <div className="rows plain">{older.map(row)}</div>
        </Fold>
        <Fold title="archived" count={filed.length} openWhen={!!q} remember={`${env.id}:~archived`}>
          <div className="rows plain">{filed.map(row)}</div>
        </Fold>

        {hasMoreHistory && <button className="linkish more" disabled={historyBusy}
          onClick={() => setHistoryLimit((n) => n + 40)}>
          {historyBusy ? 'Loading chats…' : 'Load older chats'}
        </button>}

        {/* An offline machine keeps its last word, not a blank page: the
            threads it said were running, dimmed and dated, with the actions
            held back because nothing can reach it to carry them out. */}
        {!env.online && (remembered?.length ?? 0) > 0 && (
          <>
            <div className="section">
              last known{rememberedAt ? ` · seen ${waitingSince(rememberedAt, now)} ago` : ''}
            </div>
            <div className="rows plain stale">
              {remembered!.map((s) => (
                <button key={s.id} className="row tall" onClick={() => onOpen(s)}>
                  <div className="rowmain">
                    <EngineMark engine={engineOf(s.engine).cls} />
                    <span className="grow">
                      <span className="rt"><span className="rt-text">{s.title}</span></span>
                      <span className="rm">
                        {[engineOf(s.engine).label, s.model, pathOf(s)].filter(Boolean).join(' · ')}
                        {s.updatedAt ? ` · ${waitingSince(s.updatedAt, now)}` : ''}
                      </span>
                    </span>
                    {runningThread(s) && !attention(s)
                      ? <span className="chip exited">was {busyWord(s.status, s.compacting)}</span>
                      : <StatusChip status={s.status === 'working' && s.compacting ? 'compacting' : s.status} at={s.updatedAt} />}
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
        {/* Nothing to say when a fold above is holding the answer: a search
            that found an archived thread and only an archived thread is a
            search that worked, and "nothing matches" underneath the thing
            that matched is just wrong. */}
        {!blocked.length && !working.length && !recent.length && !projectFolds.length && !strays.length &&
          !(q && (filed.length || older.length)) && (
          <div className="empty quiet">
            {q ? `Nothing on ${env.name} matches “${query.trim()}”` : `Nothing running on ${env.name}`}
            {!q && !older.length && !filed.length && env.online && (
              <div className="note">
                <button className="linkish" onClick={onNewSession}>Start a session</button>
              </div>
            )}
          </div>
        )}

        {env.online && !q && (
          <button className="linkish addproject" onClick={onAddProject}><Icon name="plus" size={14} />Add a project shortcut</button>
        )}

        {projectError && <div className="error">{projectError}</div>}
        {error && <div className="error">{error}</div>}
      </div></div>

      {undo && (
        <div className="undo" role="status">
          <span className="undo-text">Archived <b>{undo.title}</b></span>
          <button onClick={() => { const s = undo; setUndo(null); setArchived(s, false, false); }}>Undo</button>
        </div>
      )}

      {renaming && (
        <TextPrompt
          title="Name this project" value={renaming.title} busy={projectBusy}
          onCancel={() => setRenaming(null)}
          onSubmit={(t) => {
            const p = renaming;
            setRenaming(null);
            if (t !== p.title) renameProject(p, t);
          }}
        />
      )}
      {removing && (
        <Confirm
          title={`Remove "${removing.title}"?`}
          body="Empty it of threads first. Files are not deleted."
          confirmLabel="Remove" danger busy={projectBusy}
          onCancel={() => setRemoving(null)}
          onConfirm={removeProject}
        />
      )}
    </>
  );
}

function ProjectActions({ title, online, sendLabel = 'Send', onStart, onSend, onCheck, onRename, onRemove }: {
  title: string; online: boolean; sendLabel?: string; onStart: () => void; onSend: () => void; onCheck: () => void;
  onRename: () => void; onRemove: () => void;
}) {
  const [menu, setMenu] = useState(false);
  useDismiss(menu, useCallback(() => setMenu(false), []));
  return (
    <>
      <button
        type="button" className="foldbtn"
        title={`new thread in ${title}`} aria-label={`new thread in ${title}`}
        onClick={onStart}
      ><Icon name="plus" size={16} /></button>
      <button
        type="button" className="foldbtn"
        title={`actions for ${title}`} aria-label={`actions for ${title}`} aria-haspopup="menu" aria-expanded={menu}
        onClick={() => setMenu((v) => !v)}
      ><Icon name="more" size={16} /></button>
      {menu && (
        <div className="menu">
          <button disabled={!online} onClick={() => { setMenu(false); onSend(); }}>{sendLabel}</button>
          <button disabled={!online} onClick={() => { setMenu(false); onCheck(); }}>Check setup</button>
          <button onClick={() => { setMenu(false); onRename(); }}>Rename project</button>
          <button className="destructive" onClick={() => { setMenu(false); onRemove(); }}>Remove project</button>
        </div>
      )}
    </>
  );
}

/**
 * A session in the list with actions to rename, archive or permanently
 * remove it.
 *
 * The row is a div rather than a button because it holds a second button:
 * a conversation you are done with should be manageable from the list, not
 * only from inside it. An agent helm did not start is left alone - helm
 * does not own that process and has no business ending it.
 */
function SessionRow({ s, onOpen, onRename, onArchive, onDelete, busy, selecting = false, marked = false, onToggle, offline = false, attentionSuppressed = false }: {
  attentionSuppressed?: boolean;
  s: Session; onOpen?: () => void; onRename?: (title: string) => void;
  /** The machine is not answering: a busy status is its last word, not now. */
  offline?: boolean;
  onArchive?: () => void; onDelete?: () => void;
  /** Resuming a past conversation starts a CLI, which takes a moment. */
  busy?: boolean;
  /** Checkboxes instead of menus: the owner is filing, not opening. */
  selecting?: boolean;
  marked?: boolean;
  onToggle?: () => void;
}) {
  const eng = engineOf(s.engine);
  const adopted = s.adopted;
  // A thread read out of a CLI's own history rather than run by helm.
  const found = s.id.startsWith('found:');
  // Work helm did not start is still the owner's to file away. It used to get
  // no menu at all, which on a machine that has been worked at means most of
  // the list is rows you cannot do anything about.
  const managed = !!onRename || !!onArchive || !!onDelete;
  // A thread helm cannot open - one it found in a CLI's history rather than
  // one it runs - gets no button body: nothing happens on the way in.
  const Main: any = onOpen ? 'button' : 'div';
  return (
    <>
      <div className={`row tall rowx${marked ? ' sel' : ''}`}>
        <Main className="rowmain" onClick={selecting ? onToggle : onOpen}>
          {selecting && <span className={`check${marked ? ' on' : ''}`} />}
          <EngineMark engine={eng.cls} />
          <span className="grow">
            <span className="rt">
              <span className="rt-text">{s.title}</span>
              {adopted && !found && <span className="tag">external</span>}
              {s.archived && <span className="tag">archived</span>}
            </span>
            <span className="rm">
              {/* A thread waiting on you says what it is asking, which is
                  the thing you would otherwise open it to find out. */}
              {!offline && needsAttention(s) && s.ask?.text
                ? s.ask.text
                : [eng.label, s.model, pathOf(s), money(s.costUsd)].filter(Boolean).join(' · ')}
            </span>
          </span>
          {(s.pending ?? 0) > 1 && <span className="badge">{s.pending}</span>}
          {busy ? <span className="chip working"><i />opening</span>
            : offline && runningThread(s) && (attentionSuppressed || !needsAttention(s)) ? <span className="chip exited">was {busyWord(s.status, s.compacting)}</span>
            : <StatusChip status={runningThread(s) && (attentionSuppressed || !needsAttention(s)) ? busyWord(s.status, s.compacting) : s.status} at={s.updatedAt} />}
        </Main>
        {!selecting && managed && <ThreadActions s={s} onRename={onRename} onArchive={onArchive} onDelete={onDelete} />}
      </div>
    </>
  );
}
