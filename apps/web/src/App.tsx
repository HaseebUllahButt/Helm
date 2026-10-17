import { useCopySelection } from './useCopySelection';
import { knownInside, listFolder, loadFolders } from './folderIndex';
import { groqDirect, keepVoice, keptVoice, toBase64, type DirectVoice, type Transcribe } from './session/voice';
import { useDismiss } from './useDismiss';
import { useCallback, useEffect, useRef, useState, lazy, Suspense, type FormEvent, type ReactNode } from 'react';
import { Confirm, TextPrompt } from './Modal';
import { recacheWarning, type Recache } from '@helm/usage/recache';
import { useNow, waitingSince } from './useNow';
import { isUnread, markSeen, seenHere, useSeenVersion } from './threadStatus';
import { Palette, ShortcutsHelp, type PaletteItem } from './Palette';
import { NewChat } from './NewChat';
import { accountsFrom, rememberFolder, recentFolders, type Account } from './accounts';
import { loadAppearance, saveAppearance, type Theme } from './appearance';
import { Markdown } from './Markdown';
import { Composer } from './session/Composer';
import { Controls, trayPrefs, newsLines, type Kind } from './session/Controls';
import { LimitsLine } from './session/LimitsLine';
import { ContextLimit } from './session/ContextLimit';
import { useAccountLimits } from './session/useAccountLimits';
import { nativeConversation } from './session/nativeView';
import { CompactionLine } from './session/Transcript';
import { VisualReply, Visuals, type VisualReader } from './session/VisualReply';
import { useChatKeys } from './session/chatKeys';
import { BrowserDock, useBrowserDock } from './session/BrowserDock';
import { prefetchAccounts } from './accountsCache';
import { prepareAttachment } from './session/image';
import { useDraftImages } from './session/useDraftImages';
import { loadDraft, saveDraft } from './draftStore';
import { userMessage } from './session/userMessage';
import { DrivenSession } from './session/DrivenSession';
import { Subagents } from './session/Subagents';
import { NativeAgentView } from './session/NativeAgentView';
import { StartingChatView } from './session/StartingChatView';
import { beginChat, forgetChat, onStartingChat, type StartingChat } from './startingChats';
import { ExternalSessionNotice } from './session/ExternalSessionNotice';
import { useSessionLog } from './session/useSessionLog';
import { PermissionSheet, type QuestionHandle } from './session/PermissionSheet';
import type { Decision } from './session/types';
import { EngineMark } from './EngineMark';
import { NotificationToast } from './NotificationToast';
import { MachineUpdateNotice } from './MachineUpdateNotice';
import { PublicLinks } from './PublicLinks';
import { sendAction, sending, useSends } from './send/store';
import { SendActivity, SendNotice } from './send/SendActivity';
import { DictationKey } from './DictationKey';
import { BackIcon, Icon, toolKind } from './Icon';
import { Route } from './Route';
import { loadAuthSync, loadAuthDurable, saveAuth, clearAuth } from './store';
import { loadBrains, saveBrain, forgetBrain, type RememberedBrain } from './brainStore';
import { brainHost } from '@helm/protocol/brain-host';
import {
  Client, validMachineName, MACHINE_NAME_RULE, LOOPBACK_HOST, type Environment, type Session, type SendJob, type DirEntry, type Message,
  type ModelList, type NativeControl, type ModelNote, type InventorySession, type Project, type MediaRoot, type MediaEntry, type NativeAgent,
} from './client';
import { money, bytes, busyWord, needsAttention, runningThread, settledThread, unknownThread, listedThread } from './format';
import { loadModels, saveModels } from './modelCache';
import { followModelRefresh } from './modelRefresh';
import { loadMessages, saveMessages } from './session/logCache';
import { loadWorkspace, loadWorkspaceDurable, saveWorkspace, updateWorkspaceSession, forgetWorkspace, workspaceScope } from './workspaceCache';
import { engineOf } from './engines';
import { useLiveInterval } from './useLiveInterval';
import { shortPath, ownTerminal, byRecent, ago, startSummary } from './screens/common';
import { Gear, Play, Meter } from './screens/icons';
import { whereOf, HomeRow, StatusChip, Fold, NeedCard, NEVER_SNOOZE, when, PagedRows, SETTLED_FIRST, SETTLED_STEP, ThreadActions } from './screens/ThreadRows';
import { shareHopTarget, ShareHop } from './screens/ShareHop';
import { type Auth, Login } from './screens/Login';
import { Notifications, InstallPwa } from './screens/Notifications';
import { DevicesView } from './screens/Devices';
import { Start } from './screens/Start';


/** Desktop gets both panes at once; a phone shows one at a time. */
function useWide() {
  const [wide, setWide] = useState(() => window.innerWidth >= 900);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 900px)');
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

/**
 * xterm is a third of this app's JavaScript and matters only once a terminal
 * is open, so it is fetched then rather than on every cold start. The wait is
 * hidden behind the round trip that opens the pty anyway.
 */
const Terminal = lazy(() => import('./Terminal').then((m) => ({ default: m.Terminal })));
const UsageView = lazy(() => import('./Usage').then((m) => ({ default: m.UsageView })));
const UpdatesView = lazy(() => import('./Updates').then((m) => ({ default: m.UpdatesView })));
const IntegrationsView = lazy(() => import('./Integrations').then((m) => ({ default: m.IntegrationsView })));
const TransferView = lazy(() => import('./Transfer').then((m) => ({ default: m.TransferView })));
const VerifyView = lazy(() => import('./Transfer').then((m) => ({ default: m.VerifyView })));
const AppearanceSettings = lazy(() => import('./AppearanceSettings').then((m) => ({ default: m.AppearanceSettings })));

function ViewLoading({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <b>{title}</b>
      </div>
      <div className="scroll"><div className="pad"><div className="empty quiet">loading…</div></div></div>
    </>
  );
}

const DONE_FOR_MS = 3 * 24 * 60 * 60_000;

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

// ---------------------------------------------------------------------- app

export function App() {
  const [auth, setAuth] = useState<Auth | null | undefined>(loadAuthSync);
  const [client, setClient] = useState<Client | null>(null);
  const [conn, setConn] = useState<{ online: boolean; reachable: boolean; error?: string }>({ online: false, reachable: true });
  const [notice, setNotice] = useState('');

  // localStorage was empty: check the durable copy. It must never replace a
  // pairing made while it was being read - that read can take long enough
  // for a person to pair in the meantime, and then a stale "nothing stored"
  // would sign them straight back out.
  useEffect(() => {
    if (auth) return;
    let cancelled = false;
    loadAuthDurable().then((a) => { if (!cancelled && a) setAuth((cur) => cur ?? a); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!auth) return;
    const c = new Client(auth.endpoints, auth.token);
    const off = c.on((_e, kind, payload) => {
      if (kind === 'connection') setConn({ online: !!payload.online, reachable: payload.reachable ?? !!payload.online, error: payload.error });
      if (kind === 'endpoints') saveAuth({ ...auth, endpoints: payload.endpoints });
      if (kind === 'unauthorized') {
        forgetWorkspace(workspaceScope(auth.token));
        clearAuth();
        setNotice('This device is no longer in the network. Pair it again with a fresh link from `helm link`.');
        setAuth(null); setClient(null);
      }
    });
    c.connect().catch(() => {});
    setClient(c);
    return () => { off(); c.close?.(); };
  }, [auth]);

  const signOut = () => { forgetWorkspace(workspaceScope(auth?.token)); clearAuth(); setAuth(null); setClient(null); };
  const [shareHop, setShareHop] = useState(shareHopTarget);
  const leaveShareHop = () => { history.replaceState(null, '', location.pathname + location.search); setShareHop(null); };

  if (auth === undefined) return null;
  if (!auth) {
    const why = shareHop ? `${shareHop.name} is private to your Helm. Pair this device to open it.` : '';
    return <Login notice={notice || why} onDone={(a) => { setNotice(''); saveAuth(a); setAuth(a); }} />;
  }
  if (!client) return null;
  if (shareHop) return <ShareHop client={client} target={shareHop} onDone={leaveShareHop} />;
  return <Shell key={workspaceScope(auth.token)} client={client} conn={conn} onSignOut={signOut} />;
}

// ------------------------------------------------------------------- shell

type MainView =
  | { kind: 'env' }
  | { kind: 'integrations' }
  // Every machine summed, or one machine's own scope. Same screen, same
  // facets - the question is the same, only the scope changes.
  | { kind: 'usage'; envId?: string }
  | { kind: 'brain' }
  | { kind: 'new'; path?: string }
  | { kind: 'browse'; path?: string }
  | { kind: 'transfer-browse'; path?: string }
  | { kind: 'transfer'; cwd: string; session?: Session; jobId?: string }
  | { kind: 'verify'; path: string }
  // `quick`: a chat with no folder; `cwd` is then unused.
  | { kind: 'start'; cwd: string; quick?: boolean }
  | { kind: 'settings' }
  | { kind: 'network-settings' }
  // Every machine's public and private links (`helm share`) in one list.
  | { kind: 'links' }
  // Which helm each machine runs, and updating them from here.
  | { kind: 'updates' }
  | { kind: 'models'; account: Account }
  // Which phones and browsers hold a key to this network: pair another, or
  // stop trusting one.
  | { kind: 'devices' }
  // One page for everything that is not the day's work: machine defaults,
  // what it has all cost, and this device's pairing, alerts and install.
  | { kind: 'app-settings' }
  // The media a nas shares, browsed and played - only ever offered on one.
  | { kind: 'media' }
  | { kind: 'session'; session: Session; reviewChildren?: number }
  // One of Claude Code's own subagents, opened from its chat; read only.
  | { kind: 'native-agent'; parent: Session; agent: NativeAgent }
  // A new chat whose agent is still starting; becomes the chat once it is.
  | { kind: 'starting'; startId: string };

const VIEW_KINDS: Record<MainView['kind'], true> = {
  env: true, integrations: true, usage: true, brain: true, new: true,
  browse: true, 'transfer-browse': true, transfer: true, verify: true,
  start: true, settings: true, 'network-settings': true, links: true,
  updates: true, models: true, devices: true, 'app-settings': true,
  media: true, session: true, 'native-agent': true, starting: true,
};
/** History can outlive the screen that wrote it across an app update. */
function supportedViews(views: MainView[]): MainView[] {
  const supported = views.filter(view => view && Object.hasOwn(VIEW_KINDS, view.kind));
  return supported.length ? supported : [{ kind: 'env' }];
}

/** A request answered elsewhere, or a session that just started waiting -
    the toast the sidebar cannot show while it is hidden behind a session. */
interface Toast { envId: string; session: Session; at: number }

function Shell({ client, conn, onSignOut }: {
  client: Client; conn: { online: boolean; reachable: boolean; error?: string }; onSignOut: () => void;
}) {
  const wide = useWide();
  const scope = workspaceScope(client.token);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, [client]);
  const [cached] = useState(() => loadWorkspace(scope));
  const [envs, setEnvs] = useState<Environment[]>(() => cached.environments.map(e => ({ ...e, online: false })));
  const [sessions, setSessions] = useState<Record<string, Session[]>>(cached.sessions);
  const sessionsNow = useRef(sessions);
  sessionsNow.current = sessions;
  const [savedSend] = useState(() => history.state?.helm && history.state.stack?.at(-1)?.kind === 'transfer'
    && history.state.stack.at(-1).jobId ? history.state : null);
  const [selected, setSelected] = useState<string | null>(savedSend?.selected ?? cached.view?.envId ?? null);
  const [stack, setStack] = useState<MainView[]>(() => savedSend ? supportedViews(savedSend.stack) : (cached.view
    ? [{ kind: 'env' }, { kind: 'session', session: cached.view.session }] : [{ kind: 'env' }]));
  const sends = useSends(client, envs);
  const liveEnvsSeen = useRef(false);
  const liveListsSeen = useRef(new Set<string>());
  const sessionRequests = useRef(new Set<string>());
  const envRequest = useRef(false);
  const envAgain = useRef(false);
  useEffect(() => {
    let stale = false;
    void loadWorkspaceDurable(scope).then(value => {
      if (stale) return;
      if (!liveEnvsSeen.current) setEnvs(value.environments.map(e => ({ ...e, online: false })));
      setSessions(current => ({ ...Object.fromEntries(Object.entries(value.sessions)
        .filter(([id]) => !liveListsSeen.current.has(id))), ...current }));
      if (!savedSend && !cached.view && value.view && !location.hash && nav.current.depth === 0 && nav.current.stack.length === 1) {
        restate([{ kind: 'env' }, { kind: 'session', session: value.view.session }], value.view.envId);
      }
    });
    return () => { stale = true; };
  }, [scope]);
  const [error, setError] = useState('');
  const [envError, setEnvError] = useState('');
  const [downSince, setDownSince] = useState<number | null>(null);
  /** "thread X needs you" while a different session is on screen. */
  const [toast, setToast] = useState<Toast | null>(null);
  const [palette, setPalette] = useState(false);
  /** The keyboard new-chat box; a folder skips straight to the agent picker. */
  const [newChat, setNewChat] = useState<{ envId?: string; folder?: string; quick?: boolean } | null>(null);
  const [lastFolder, setLastFolder] = useState<{ envId: string; folder: string } | null>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`helm.last-folder:${scope}`) || 'null');
      return typeof saved?.envId === 'string' && typeof saved?.folder === 'string' && saved.folder
        ? saved : null;
    } catch { return null; }
  });
  const rememberChatFolder = useCallback((envId: string, folder: string) => {
    setLastFolder(current => current?.envId === envId && current.folder === folder ? current : { envId, folder });
    try { localStorage.setItem(`helm.last-folder:${scope}`, JSON.stringify({ envId, folder })); } catch { /* full */ }
  }, [scope]);
  /**
   * Threads put off until later, on this device. A thread waiting on you that
   * you cannot get to yet should stop being the loudest thing on Home and stop
   * raising toasts - and come back on its own, because forgetting it would
   * make snoozing the same as ignoring.
   */
  const [snoozed, setSnoozed] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem('helm.snoozed') || '{}'); } catch { return {}; }
  });
  const snoozedRef = useRef(snoozed);
  snoozedRef.current = snoozed;
  const tick = useNow(30_000);
  const [snoozeUndo, setSnoozeUndo] = useState<{ key: string; title: string; until: number } | null>(null);
  const setSnooze = (key: string, until: number | null) => {
    setSnoozed((all) => {
      const next = { ...all };
      if (until == null) delete next[key]; else next[key] = until;
      // Forget the ones whose time has passed, so the store does not grow for ever.
      for (const k of Object.keys(next)) if (next[k] <= Date.now()) delete next[k];
      try { localStorage.setItem('helm.snoozed', JSON.stringify(next)); } catch { /* full */ }
      return next;
    });
  };
  const snoozedNow = (envId: string, id: string) => (snoozed[`${envId}:${id}`] ?? 0) > tick;
  const attentionOn = (envId: string, s: Session) => needsAttention(s) && !snoozedNow(envId, s.id);
  useEffect(() => {
    if (!snoozeUndo) return;
    const timer = setTimeout(() => setSnoozeUndo(null), 7000);
    return () => clearTimeout(timer);
  }, [snoozeUndo]);
  const [help, setHelp] = useState(false);
  /** Every machine's last-said session list, for the ones that are asleep. */
  const [snap, setSnap] = useState<{ machines: Record<string, { name: string; at: number; sessions: Session[] }> } | null>(null);
  /** The one in-app yes/no currently up: unpairing this device. */
  const [unpairing, setUnpairing] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('helm.sidebar-collapsed') === '1'; } catch { return false; }
  });
  const collapseSidebar = (collapsed: boolean) => {
    setSidebarCollapsed(collapsed);
    try { localStorage.setItem('helm.sidebar-collapsed', collapsed ? '1' : '0'); } catch { /* full */ }
  };

  /**
   * Navigation lives in the browser history, so the phone's back button
   * walks back through views instead of closing the installed app. Each
   * entry snapshots the view stack and the selected machine together -
   * "where you are" is both - and popstate is the only thing that moves
   * backward, whether it came from the ‹ button or the system gesture.
   * `nav` mirrors the state for code that cannot wait a render.
   */
  const nav = useRef<{ stack: MainView[]; selected: string | null; depth: number }>(
    { stack, selected, depth: 0 });
  /** A machine the wide layout showed by itself, not one you went to. */
  const autoPicked = useRef<string | null>(null);

  /**
   * Leaving an unused chat should not leave an empty row behind. The machine
   * re-checks that no input has reached the chat, so a send from another
   * device between our last refresh and this navigation can never be lost.
   */
  const discardEmpty = useCallback((from: typeof nav.current, to?: MainView[]) => {
    const current = from.stack[from.stack.length - 1];
    const next = to?.[to.length - 1];
    if (current?.kind !== 'session' || current.session.brain || current.session.engine === 'shell') return;
    if (next?.kind === 'session' && next.session.id === current.session.id) return;
    const envId = from.selected;
    if (!envId) return;
    client.rpc<{ discarded: boolean }>(envId, 'session.discard-empty', { id: current.session.id }, 10_000)
      .then((r) => {
        if (r.discarded) {
          setSessions((all) => ({
            ...all,
            [envId]: (all[envId] ?? []).filter((s) => s.id !== current.session.id),
          }));
        }
      })
      .catch(() => { /* offline: the still-empty chat remains recoverable */ });
  }, [client]);

  useEffect(() => {
    history.replaceState({ helm: 1, ...nav.current }, '');
    const onPop = (e: PopStateEvent) => {
      const s = e.state;
      if (!s?.helm || !Array.isArray(s.stack)) return;
      s.stack = supportedViews(s.stack);
      discardEmpty(nav.current, s.stack);
      nav.current = { stack: s.stack, selected: s.selected, depth: s.depth };
      setStack(s.stack);
      setSelected(s.selected);
      const top = s.stack.at(-1);
      saveWorkspace(scope, { view: s.selected && top?.kind === 'session' && top.session.engine !== 'shell'
        ? { envId: s.selected, session: top.session } : undefined });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [discardEmpty]);

  /** A real move: new view, new history entry, phone-back returns from it. */
  const navigate = (next: MainView[], sel = nav.current.selected) => {
    autoPicked.current = null;
    discardEmpty(nav.current, next);
    const depth = nav.current.depth + 1;
    nav.current = { stack: next, selected: sel, depth };
    setStack(next);
    setSelected(sel);
    history.pushState({ helm: 1, depth, stack: next, selected: sel }, '');
    const top = next.at(-1);
    saveWorkspace(scope, { view: sel && top?.kind === 'session' && top.session.engine !== 'shell'
      ? { envId: sel, session: top.session } : undefined });
  };

  /** Same place, fresher snapshot: session records change under a view. */
  const restate = (next: MainView[], sel = nav.current.selected) => {
    autoPicked.current = null;
    nav.current = { ...nav.current, stack: next, selected: sel };
    setStack(next);
    setSelected(sel);
    history.replaceState({ helm: 1, depth: nav.current.depth, stack: next, selected: sel }, '');
    const top = next.at(-1);
    saveWorkspace(scope, { view: sel && top?.kind === 'session' && top.session.engine !== 'shell'
      ? { envId: sel, session: top.session } : undefined });
  };

  /**
   * Opening straight onto the session a notification was about.
   *
   * Two ways in, because a phone can be in either state: the app was closed
   * and the service worker opened it at `#open=<env>/<session>`, or the app
   * was already open and the worker posted a message to it. Both land here,
   * and both have to wait - the session list for that machine may not have
   * arrived yet, so the target is parked and the effect below spends it once
   * the record it names exists.
   */
  const wanted = useRef<{ envId: string; sessionId: string } | null>(null);
  useEffect(() => {
    const take = (envId?: string, sessionId?: string) => {
      if (!envId || !sessionId) return;
      wanted.current = { envId, sessionId };
      setSelected(envId);
    };
    // "A new device paired" is about the list of devices, not a session.
    const devicesScreen = () => navigate([{ kind: 'app-settings' }, { kind: 'devices' }]);
    const m = /^#open=([^/]+)\/(.+)$/.exec(location.hash);
    if (m) {
      take(m[1], m[2]);
      history.replaceState(history.state, '', location.pathname + location.search);
    } else if (location.hash === '#devices') {
      devicesScreen();
      history.replaceState(history.state, '', location.pathname + location.search);
    }
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type !== 'helm:open') return;
      if (e.data.view === 'devices') devicesScreen();
      else take(e.data.envId, e.data.sessionId);
    };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    window.addEventListener('helm:open', onMessage as EventListener);
    return () => {
      navigator.serviceWorker?.removeEventListener('message', onMessage);
      window.removeEventListener('helm:open', onMessage as EventListener);
    };
  }, []);

  useEffect(() => {
    const want = wanted.current;
    if (!want) return;
    const found = (sessions[want.envId] ?? []).find((x) => x.id === want.sessionId);
    if (!found) return;
    wanted.current = null;
    const orchestrator = found.delegation?.parentId
      ? (sessions[want.envId] ?? []).find((s) => s.id === found.delegation?.parentId) : null;
    if (found.delegation && !orchestrator && !found.unhomed) return;
    navigate([{ kind: 'env' }, { kind: 'session', session: orchestrator ?? found }], want.envId);
  }, [sessions]);

  useEffect(() => {
    if (conn.online) { setDownSince(null); return; }
    setDownSince((t) => t ?? Date.now());
  }, [conn.online]);

  const loadEnvs = useCallback((): void => {
    if (!active.current) return;
    if (envRequest.current) { envAgain.current = true; return; }
    envRequest.current = true;
    client.environments()
      .then((r) => {
        if (!active.current) return;
        liveEnvsSeen.current = true;
        setEnvs(r.environments); setEnvError('');
        saveWorkspace(scope, { environments: r.environments });
      })
      .catch((e) => { if (active.current) setEnvError(e.message); })
      .finally(() => {
        envRequest.current = false;
        const again = envAgain.current; envAgain.current = false;
        if (again && active.current) loadEnvs();
      });
  }, [client, scope]);

  /** One trailing session.list per machine per burst of updates. */
  const relist = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const listRetries = useRef<Record<string, number>>({});
  /**
   * Updates that landed while a list was on its way. The list can have been
   * read before them - on the VPN a round trip is over half a second - so
   * laying it down as-is put a thread that had just started back under Done,
   * or kept one that had just finished under Running. They are laid back
   * over the list, and one more list is asked for to settle it.
   */
  const pushedDuringList = useRef<Record<string, Map<string, Session>>>({});
  const listAgain = useRef(new Set<string>());
  const recordSession = useCallback((envId: string, up: Session) => {
    const during = pushedDuringList.current[envId];
    if (during) during.set(up.id, { ...during.get(up.id), ...up, recovery: up.recovery });
    setSessions((all) => {
      const list = all[envId];
      if (!list?.some(x => x.id === up.id)) return all;
      return { ...all, [envId]: list.map(x => x.id === up.id ? { ...x, ...up, recovery: up.recovery } : x) };
    });
    updateWorkspaceSession(scope, envId, up);
  }, [scope]);
  const loadSessions = useCallback((envId: string) => {
    if (!active.current) return;
    if (sessionRequests.current.has(envId)) { listAgain.current.add(envId); return; }
    sessionRequests.current.add(envId);
    const pushed = new Map<string, Session>();
    pushedDuringList.current[envId] = pushed;
    client.rpc<{ sessions: Session[] }>(envId, 'session.list', { includeDetected: true }, 15_000)
      .then((r) => {
        if (!active.current) return;
        liveListsSeen.current.add(envId);
        delete listRetries.current[envId];
        const list = pushed.size
          ? r.sessions.map((x) => { const up = pushed.get(x.id); return up ? { ...x, ...up, recovery: up.recovery } : x; })
          : r.sessions;
        setSessions((s) => ({ ...s, [envId]: list }));
        saveWorkspace(scope, { sessions: { [envId]: list } });
      })
      .catch(() => {
        // Until one list has arrived, the screen is the saved copy, which
        // updates alone never complete: keep asking (a machine that just
        // restarted can take a while to answer).
        const tries = listRetries.current[envId] = (listRetries.current[envId] ?? 0) + 1;
        if (!liveListsSeen.current.has(envId) && tries <= 20) {
          clearTimeout(relist.current[envId]);
          relist.current[envId] = setTimeout(() => loadSessions(envId), 3000);
        }
      })
      .finally(() => {
        sessionRequests.current.delete(envId);
        if (pushedDuringList.current[envId] === pushed) delete pushedDuringList.current[envId];
        if (listAgain.current.delete(envId) && active.current) loadSessions(envId);
      });
  }, [client, scope]);

  useEffect(() => {
    loadEnvs();
    return client.on((e, kind, payload) => {
      if (kind === 'presence') {
        if (e && payload?.env) {
          // The name travels with presence, and a rename is the one thing
          // that changes it: a machine renamed from another phone lands here.
          setEnvs((list) => list.map((m) => (
            m.id === e ? { ...m, online: !!payload.online, name: payload.name ?? m.name } : m)));
        } else loadEnvs();
      }
      if (kind === 'connection' && (payload.online || payload.reachable)) loadEnvs();
      if (kind === 'session.update' && e) {
        // The update carries the session, so draw it now; the list call
        // behind it only has to find what came or went. It used to be the
        // only path - a full session.list per update, two per status change
        // (the daemon sends `session` and `status` together), each one a
        // relay round trip before the sidebar moved.
        const up = payload?.session as Session | undefined;
        // A conversation that was taken over lives on as a new thread: the
        // screen showing it follows, rather than going blank.
        if (up?.movedTo) {
          const top = nav.current.stack[nav.current.stack.length - 1];
          if (top?.kind === 'session' && top.session.id === up.id) openSession(e, up.movedTo);
        }
        if (up?.id) {
          recordSession(e, up);
        }
        // The whole list (hundreds of KB) is asked for again only when this
        // update can change which threads it holds: one new to it, one that
        // ended, moved or was archived. A known thread changing, or a helper
        // (shown under its lead, which sends its own update), is drawn from
        // the update alone - busy helpers used to cost a full list each.
        // Until a live list has arrived, every update still asks for one.
        const known = up?.id ? sessionsNow.current[e]?.find((x) => x.id === up.id) : undefined;
        const helper = !!up?.delegation?.parentId && !up.unhomed;
        const changesList = !liveListsSeen.current.has(e) || !up?.id || !!up.movedTo || up.status === 'exited'
          || (known ? !!known.archived !== !!up.archived : !helper);
        if (changesList) {
          clearTimeout(relist.current[e]);
          relist.current[e] = setTimeout(() => loadSessions(e), 400);
        }
        // A session that just started waiting, on a machine this window is
        // not looking at, earns a tap-target in front of whatever is open -
        // on a phone the sidebar that would say so is hidden behind the
        // session you are in. The sheet inside that session is the notice
        // for the one you are looking at, so it is not toasted about.
        // A machine that knows what was asked follows "blocked" a moment
        // later with `asked`; that fills in the notice already showing, or
        // raises one for a second prompt in a thread that was already waiting.
        const s = payload?.session;
        if ((payload?.transition?.to === 'blocked' || payload?.asked) && s && listedThread(s)) {
          const top = nav.current.stack[nav.current.stack.length - 1];
          const looking = top?.kind === 'session' && top.session.id === s.id;
          const asleep = (snoozedRef.current[`${e}:${s.id}`] ?? 0) > Date.now();
          if (!looking && !asleep) {
            setToast((cur) => {
              const same = cur?.envId === e && cur.session.id === s.id && Date.now() - cur.at < 3000;
              if (!same) { try { navigator.vibrate?.(60); } catch { /* no haptics here */ } }
              return { envId: e, session: same ? { ...cur.session, ...s } : s, at: same ? cur.at : Date.now() };
            });
          }
        }
      }
    });
  }, [loadEnvs, loadSessions, recordSession, client]);

  useEffect(() => {
    const catchUp = () => { if (!document.hidden) loadEnvs(); };
    window.addEventListener('focus', catchUp);
    window.addEventListener('online', catchUp);
    window.addEventListener('pageshow', catchUp);
    document.addEventListener('visibilitychange', catchUp);
    return () => {
      window.removeEventListener('focus', catchUp);
      window.removeEventListener('online', catchUp);
      window.removeEventListener('pageshow', catchUp);
      document.removeEventListener('visibilitychange', catchUp);
    };
  }, [loadEnvs]);

  const liveIds = envs.filter((e) => e.online).map((e) => e.id).join(',');
  useEffect(() => {
    let stopped = false, checking = false;
    const check = async () => {
      if (checking || document.hidden || !conn.online) return;
      checking = true;
      try {
        await Promise.all((liveIds ? liveIds.split(',') : []).map(async (id) => {
          try {
            const info = await client.rpc<Environment['info']>(id, 'env.info', {}, 8000);
            if (!stopped && info.version) setEnvs((list) => list.map((e) => e.id === id ? { ...e, info: { ...e.info, ...info } } : e));
          } catch { /* keep the last known version through a reconnect */ }
        }));
      } finally { checking = false; }
    };
    void check();
    const timer = setInterval(() => { void check(); }, 60_000);
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      stopped = true; clearInterval(timer);
      window.removeEventListener('online', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [client, liveIds, conn.online]);
  // `conn.online` is a dependency because of what it costs to leave out. The
  // machine list arrives over HTTP and the session lists go over the socket,
  // so on a cold open this runs first and every `session.list` in it is
  // rejected as "not connected" and swallowed - and nothing asked again
  // until the 15s tick below. Measured on loopback, where the daemon answers
  // in 3ms: 15 seconds of "asking every machine…" for a 3ms question.
  useEffect(() => {
    const live = liveIds ? liveIds.split(',') : [];
    for (const id of live) { client.subscribe(id); loadSessions(id); }
  }, [liveIds, client, loadSessions, conn.online]);
  // Status changes arrive pushed, so this list is reconciliation rather
  // than the live feed - it can afford to be slower than the events that
  // keep it fresh, and nothing at all while the page is hidden.
  useLiveInterval(30_000, () => {
    const live = liveIds ? liveIds.split(',') : [];
    for (const id of live) loadSessions(id);
  }, [liveIds, loadSessions]);

  useEffect(() => {
    if (wide && !selected && envs.length) { autoPicked.current = envs[0].id; setSelected(envs[0].id); }
  }, [wide, selected, envs]);

  // Keys, on a keyboard. Ctrl/Cmd+K opens the palette; "/" opens it too;
  // Ctrl/Cmd+N starts a new chat - never a bare "n", which the owner hit by
  // accident. In an ordinary browser tab the browser keeps Ctrl+N, so
  // Ctrl/Cmd+Shift+O does the same there. Ctrl/Cmd+[ and ] walk back and
  // forward; "?" lists them. The single keys never fire while you are typing
  // into something, and a phone never sends any of them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(el?.tagName ?? '') || !!el?.isContentEditable;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); setPalette((v) => !v); return; }
      // A terminal keeps Ctrl+N: it is "next line" to a shell.
      const ctrlN = !e.shiftKey && (e.key === 'n' || e.key === 'N') && !el?.closest?.('.xterm');
      if (mod && (ctrlN || (e.shiftKey && (e.key === 'o' || e.key === 'O')))) { e.preventDefault(); setPalette(false); setNewChat({}); return; }
      if (mod && e.key === '[') { e.preventDefault(); history.back(); return; }
      if (mod && e.key === ']') { e.preventDefault(); history.forward(); return; }
      // Settings and usage from anywhere. Letters with Ctrl/Cmd+Shift that
      // nothing else wants: Ctrl+, zooms on some layouts and Ctrl+Shift+U is
      // Linux's "type a Unicode character", which is what the owner got.
      if (mod && e.shiftKey && !e.altKey && !el?.closest?.('.xterm')) {
        if (e.key === 's' || e.key === 'S') { e.preventDefault(); setPalette(false); navigate([{ kind: 'app-settings' }]); return; }
        // The $ key (Shift+4), by position so any layout works; Ctrl+Shift+L
        // locked the owner's screen.
        if (e.code === 'Digit4' || e.key === '$') { e.preventDefault(); setPalette(false); navigate([{ kind: 'usage' }]); return; }
      }
      if (typing || mod || e.altKey) return;
      if (e.key === '?') { e.preventDefault(); setHelp(true); return; }
      if (e.key === '/') { e.preventDefault(); setPalette(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Everything the palette can find, built when it opens. */
  const paletteItems = (): PaletteItem[] => {
    const items: PaletteItem[] = [];
    for (const e of envs) {
      items.push({
        id: `m:${e.id}`, group: 'machine', title: e.name,
        sub: e.online ? 'online' : 'offline', keywords: 'machine computer',
        run: () => openEnv(e.id),
      });
      const liveThreads = agentsOf(e.id);
      const snapshotThreads = !e.online
        ? (snap?.machines?.[e.id]?.sessions ?? []).filter((thread) => listedThread(thread) && thread.engine !== 'shell'
          && !thread.archived && !liveThreads.some((liveThread) => liveThread.id === thread.id))
        : [];
      for (const s of [...liveThreads, ...snapshotThreads]) {
        items.push({
          id: `t:${e.id}:${s.id}`, group: 'thread', title: s.title, engine: s.engine, at: s.updatedAt,
          sub: `${whereOf(s)} · ${e.name}${attentionOn(e.id, s) ? ' · needs you' : runningThread(s) ? ` · ${busyWord(s.status, s.compacting)}` : unknownThread(s) ? ' · status unavailable' : ''}${!e.online ? ' · offline' : ''}`,
          keywords: `${s.quick ? 'quick chat' : s.cwd} ${engineOf(s.engine).label}`,
          run: () => openSession(e.id, s),
        });
      }
      if (e.online) {
        items.push({
          id: `new:${e.id}`, group: 'action', title: `New chat on ${e.name}`, keywords: 'start create agent session',
          run: () => setNewChat({ envId: e.id }),
        });
        items.push({ id: `integrations:${e.id}`, group: 'action', title: `Connectors & skills on ${e.name}`, keywords: 'mcp servers plugins integrations', run: () => navigate([{ kind: 'env' }, { kind: 'integrations' }], e.id) });
        items.push({
          id: `send:${e.id}`, group: 'action', title: `Send a project from ${e.name}`,
          keywords: 'transfer env copy move folder', run: () => navigate([{ kind: 'env' }, { kind: 'transfer-browse' }], e.id),
        });
      }
    }
    items.push({ id: 'a:new', group: 'action', title: 'New chat', keywords: 'start create agent session', run: () => setNewChat({}) });
    // A chat in no folder, on the machine on screen (or asked, when that one is not there).
    items.push({
      id: 'a:quick', group: 'action', title: 'Quick chat', sub: 'no folder, for a small question', keywords: 'start new agent question scratch',
      run: () => setNewChat({ envId: envs.find((e) => e.id === selected && e.online)?.id, quick: true }),
    });
    const go = (id: string, title: string, keywords: string, stack: MainView[]) =>
      items.push({ id, group: 'action', title, keywords, run: () => navigate(stack) });
    go('a:settings', 'Settings', 'preferences', [{ kind: 'app-settings' }]);
    go('a:updates', 'Updates', 'version upgrade machines', [{ kind: 'app-settings' }, { kind: 'updates' }]);
    go('a:devices', 'Devices & pairing', 'phone key link', [{ kind: 'app-settings' }, { kind: 'devices' }]);
    go('a:cost', 'What it has cost', 'usage tokens spend', [{ kind: 'usage' }]);
    go('a:defaults', 'CLI defaults', 'model thinking permissions', [{ kind: 'app-settings' }, { kind: 'network-settings' }]);
    go('a:links', 'Public links', 'share spin private forward port', [{ kind: 'app-settings' }, { kind: 'links' }]);
    for (const t of ['light', 'dark', 'system'] as Theme[]) {
      items.push({
        id: `theme:${t}`, group: 'action', title: `Theme: ${t[0].toUpperCase()}${t.slice(1)}`, keywords: 'appearance colour',
        run: () => saveAppearance({ ...loadAppearance(), theme: t }),
      });
    }
    items.push({ id: 'a:keys', group: 'action', title: 'Keyboard shortcuts', keywords: 'keys help', run: () => setHelp(true) });
    return items;
  };

  // The sidebar's ⋯: the same three things the machine screen offers. The
  // list is reloaded either way, so a row that would not go stays and says so.
  const threadActions = (e: Environment, s: Session) => {
    const act = async (method: string, params: object) => {
      try { await client.rpc(e.id, method, params, 20_000); }
      catch (err: any) { console.error(`${method} failed on ${e.name}: ${err.message}`); }
      loadSessions(e.id);
    };
    return {
      onRename: (title: string) => act('session.title', { id: s.id, title }),
      onArchive: () => act('session.archive', { id: s.id, archived: !s.archived }),
      onDelete: () => act('session.kill', { id: s.id }),
    };
  };

  const env = envs.find((e) => e.id === selected) ?? null;
  const view = stack[stack.length - 1];
  const viewSession = view.kind === 'session'
    ? (sessions[selected ?? ''] ?? []).find(s => s.id === view.session.id) ?? view.session : null;
  // A quick chat's scratch folder is not a place anyone would start in again.
  const inQuick = !!viewSession?.quick || (view.kind === 'start' && !!view.quick);
  const currentFolder = inQuick ? undefined
    : viewSession ? viewSession.cwd
    : view.kind === 'start' || view.kind === 'transfer' ? view.cwd
    : view.kind === 'verify' ? view.path
    : view.kind === 'new' || view.kind === 'browse' || view.kind === 'transfer-browse' ? view.path ?? '~'
    : undefined;

  useEffect(() => {
    if (selected && currentFolder) rememberChatFolder(selected, currentFolder);
  }, [selected, currentFolder, rememberChatFolder]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.isComposing || e.key.toLowerCase() !== 'n') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      // From a quick chat, "the same place" is another quick chat.
      const target = selected && inQuick ? { envId: selected, quick: true }
        : selected && currentFolder ? { envId: selected, folder: currentFolder } : lastFolder;
      setPalette(false);
      setNewChat(target ?? {});
    };
    // Capture before a focused terminal handles the key as terminal input.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [selected, currentFolder, inQuick, lastFolder]);

  /**
   * Which session this window is looking at, told to the service worker so
   * a push about it stays silent: the sheet already on screen is the
   * notification. Posted on every navigation, including the one back to a
   * list - "looking at nothing" is real information.
   */
  useEffect(() => {
    navigator.serviceWorker?.controller?.postMessage({
      type: 'helm:viewing',
      envId: view?.kind === 'session' ? selected : null,
      sessionId: view?.kind === 'session' ? view.session.id : null,
    });
  }, [view, selected]);

  /**
   * The same, told to this computer's own hub, which shows desktop
   * notifications itself (desktop-notify.js) - and which answers this
   * request with a chat to open when one of them is clicked.
   */
  const viewingNow = useRef<{ envId: string | null; sessionId: string | null }>({ envId: null, sessionId: null });
  const desktopNudge = useRef<() => void>(() => {});
  useEffect(() => {
    viewingNow.current = {
      envId: view?.kind === 'session' ? selected : null,
      sessionId: view?.kind === 'session' ? view.session.id : null,
    };
    desktopNudge.current();
  }, [view, selected]);
  useEffect(() => {
    if (!/^(127(?:\.\d{1,3}){3}|localhost|\[::1\])$/.test(location.hostname)) return;
    const windowId = Math.random().toString(36).slice(2, 10);
    let stopped = false;
    let abort: AbortController | null = null;
    const nudge = () => abort?.abort();
    desktopNudge.current = nudge;
    const loop = async () => {
      let failures = 0;
      while (!stopped) {
        abort = new AbortController();
        try {
          const { open } = await client.desktopWait({
            window: windowId,
            focused: document.visibilityState === 'visible' && document.hasFocus(),
            ...viewingNow.current,
          }, abort.signal);
          failures = 0;
          if (open?.envId && open.sessionId) {
            window.dispatchEvent(new MessageEvent('helm:open', { data: { type: 'helm:open', ...open } }));
          }
        } catch {
          if (stopped) return;
          if (abort.signal.aborted) continue;
          // A hub without this, or one restarting: back off and try again.
          failures += 1;
          await new Promise((r) => setTimeout(r, Math.min(60_000, 2000 * failures)));
        }
      }
    };
    loop();
    window.addEventListener('focus', nudge);
    window.addEventListener('blur', nudge);
    document.addEventListener('visibilitychange', nudge);
    return () => {
      stopped = true;
      abort?.abort();
      desktopNudge.current = () => {};
      window.removeEventListener('focus', nudge);
      window.removeEventListener('blur', nudge);
      document.removeEventListener('visibilitychange', nudge);
    };
  }, [client]);

  /**
   * The tab's title answers "is anything waiting" from the app switcher
   * alone, and names the thread a notification lands on - the one place a
   * session's name matters outside the app itself.
   */
  const blockedCount = envs.reduce((n, e) =>
    n + (sessions[e.id] ?? []).filter((s) => listedThread(s) && s.engine !== 'shell' && !s.archived && attentionOn(e.id, s)).length, 0);
  useEffect(() => {
    const parts: string[] = [];
    if (view?.kind === 'session') parts.push(view.session.title);
    else if (view?.kind === 'env' && env) parts.push(env.name);
    if (blockedCount) parts.unshift(`${blockedCount} waiting`);
    if (!conn.online) parts.push('offline');
    document.title = parts.length ? `${parts.join(' · ')} · helm` : 'helm';
    return () => { document.title = 'helm'; };
  }, [view, env?.id, blockedCount, conn.online]);

  /**
   * What an offline machine last said about itself.
   *
   * The snapshot is merged on whichever machine answers - usually the
   * always-on home - so asking any live machine yields every machine's
   * last-known sessions, timestamped. It is re-read while the app is open
   * rather than once: a laptop that went to sleep ten minutes ago has a
   * fresher memory than the file that booted the app.
   */
  const firstOnline = envs.find((e) => e.online)?.id;
  // Its only reader is the "last known" section on a machine that cannot be
  // asked - when nothing is down, the answer would arrive and be thrown away.
  const hasOffline = envs.some((e) => !e.online);
  useEffect(() => {
    if (!conn.online || !firstOnline || !hasOffline) { setSnap(null); return; }
    let stale = false;
    const ask = () => client.rpc<any>(firstOnline, 'brain.snapshot', { cached: true }, 15_000)
      .then((r) => { if (!stale && r?.snapshot) setSnap(r.snapshot); })
      .catch(() => {});
    ask();
    const timer = setInterval(() => { if (!document.hidden) ask(); }, 60_000);
    return () => { stale = true; clearInterval(timer); };
  }, [client, conn.online, firstOnline, hasOffline]);

  // Stable per machine. Handed to EnvView, which lists it as an effect
  // dependency: a fresh arrow on every render would repeatedly re-list the
  // sessions.
  const reloadEnv = useCallback(() => {
    if (env) loadSessions(env.id);
  }, [loadSessions, env?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const openEnv = (id: string) => {
    if (id === nav.current.selected && nav.current.stack.length === 1) return;
    navigate([{ kind: 'env' }], id);
  };
  const attentionVisit = useRef(0);
  const openSession = (envId: string, s: Session, reviewChildren = false) => {
    if (s.id.startsWith('found:')) {
      // The tap is the look. Opening a chat Helm did not start can be slow
      // or fail, and the "new" tick stayed until it had opened.
      if (markSeen(s.id)) client.rpc(envId, 'session.seen', { id: s.id }).catch(() => { /* an older machine: this device still knows */ });
      void resumeFound(envId, s);
      return;
    }
    navigate([{ kind: 'env' }, { kind: 'session', session: s, reviewChildren: reviewChildren ? ++attentionVisit.current : undefined }], envId);
  };
  // A session that changed under an open view: refresh the machine's list and
  // fold the new record into the stack, so the title in the bar and the title
  // in the history entry behind it do not disagree.
  const onSessionChanged = (envId: string) => (s: Session) => {
    recordSession(envId, s);
    loadSessions(envId);
    restate(nav.current.stack.map((v) => (
      v.kind === 'session' && v.session.id === s.id ? { ...v, session: { ...v.session, ...s, recovery: s.recovery } } : v)));
  };
  const push = (v: MainView) => navigate([...nav.current.stack, v]);

  // A chat that was starting in the background is up: open it in place of
  // its placeholder, or, if nobody is looking and nothing was written, let
  // it go the way an unused chat does.
  const chatStarted = useRef<(chat: StartingChat) => void>(() => {});
  chatStarted.current = (chat) => {
    if (chat.state !== 'started' || !chat.session) return;
    const session = chat.session;
    loadSessions(chat.envId);
    const top = nav.current.stack.at(-1);
    if (nav.current.selected === chat.envId && top?.kind === 'starting' && top.startId === chat.id) {
      restate([...nav.current.stack.slice(0, -1), { kind: 'session', session }]);
    } else if (!chat.message && !chat.draft.trim()) {
      client.rpc<{ discarded: boolean }>(chat.envId, 'session.discard-empty', { id: session.id }, 10_000)
        .then((r) => { if (r.discarded) setSessions((all) => ({ ...all, [chat.envId]: (all[chat.envId] ?? []).filter((s) => s.id !== session.id) })); })
        .catch(() => { /* offline: the empty chat stays recoverable */ });
    }
    forgetChat(chat.id);
  };
  useEffect(() => onStartingChat((chat) => chatStarted.current(chat)), []);
  const back = () => {
    // One history entry per push, so any stack deeper than its root has
    // somewhere to pop to. At the root there is no such entry; there the ‹
    // means "back to the machine list" on a phone and nothing on desktop.
    if (nav.current.depth > 0) history.back();
    else if (nav.current.stack.length > 1) restate([{ kind: 'env' }]);
    else if (!wide) restate([{ kind: 'env' }], null);
  };

  const openRelatedSession = (envId: string, session: Session) => {
    loadSessions(envId);
    const current = nav.current.stack.at(-1);
    if (nav.current.selected === envId && current?.kind === 'session') {
      if (current.session.delegation?.parentId === session.id) {
        let parentIndex = -1;
        nav.current.stack.forEach((v, index) => {
          if (v.kind === 'session' && v.session.id === session.id) parentIndex = index;
        });
        const steps = nav.current.stack.length - 1 - parentIndex;
        if (parentIndex >= 0 && steps > 0 && nav.current.depth >= steps) history.go(-steps);
        // A restored or directly opened child has no parent entry to pop.
        // Replace it so Back cannot send the owner straight into it again.
        else restate([{ kind: 'env' }, { kind: 'session', session }], envId);
        return;
      }
      if (session.delegation?.parentId === current.session.id) {
        navigate([...nav.current.stack, { kind: 'session', session }], envId);
        return;
      }
    }
    navigate([{ kind: 'env' }, { kind: 'session', session }], envId);
  };

  const agentsOf = (id: string) => (sessions[id] ?? []).filter((s) => listedThread(s) && s.engine !== 'shell' && !s.archived);
  const workingThreadsOn = (machine: Environment) =>
    machine.online ? agentsOf(machine.id).filter((thread) => !attentionOn(machine.id, thread) && runningThread(thread)) : [];
  const waitingCountOn = (machine: Environment) => agentsOf(machine.id).filter(s => attentionOn(machine.id, s)).length;
  /** "3 running · 1 status unavailable": a thread the machine cannot read is not idle. */
  const activityOn = (machine: Environment, nothing: string) => {
    const working = workingThreadsOn(machine).length;
    const unknown = agentsOf(machine.id).filter(unknownThread).length;
    return [working ? `${working} running` : '', unknown ? `${unknown} status unavailable` : ''].filter(Boolean).join(' · ') || nothing;
  };

  /**
   * Turning a recording into words, on whichever machine can.
   *
   * The key lives on a machine, never on this device, so the device's job is
   * to find a machine that has one. The session's own machine first - it is
   * already connected and probably nearest - then any other that is online
   * and says it can. That fallback is not hypothetical: the owner's VM is the
   * always-on machine and its Groq key is the one that was expired, so the
   * laptop is what answers.
   */
  /**
   * Continue a conversation that was started at a keyboard.
   *
   * Opening reads the exact conversation without starting or stopping an
   * agent. Sending later hands the conversation to Helm when its CLI is idle.
   */
  const [resuming, setResuming] = useState<string | null>(null);
  const resumeFound = async (envId: string, s: Session) => {
    if (resuming) return;
    setResuming(s.id);
    setError('');
    try {
      const r = await client.rpc<{ session: Session }>(envId, 'session.resume', {
        engine: s.engine, account: (s as any).account,
        id: s.engineSessionId, cwd: s.cwd,
      }, 60_000);
      loadSessions(envId);
      navigate([...nav.current.stack, { kind: 'session', session: r.session }], envId);
    } catch (e: any) {
      setError(`could not continue that thread: ${e.message}`);
    } finally { setResuming(null); }
  };

  const voiceEnvs = envs.filter((e) => e.online && e.info.voice);
  /**
   * Speech to text runs on this device: it calls Groq itself with the key a
   * machine handed over once (see voice.ts). A machine is only asked for the
   * key, or - when the direct call cannot be made - to transcribe as before,
   * the quickest one to reach first and the chat's own machine on a tie.
   */
  const transcribeVia = (preferred?: string) => {
    if (!voiceEnvs.length && !keptVoice()) return undefined;
    const byReach = () => {
      const speed = (id: string) => client.latency(id) ?? Infinity;
      return [...voiceEnvs].sort((a, b) => speed(a.id) - speed(b.id)
        || Number(b.id === preferred) - Number(a.id === preferred));
    };
    let asking: Promise<DirectVoice | null> | null = null;
    const fetchKey = () => asking ??= (async () => {
      for (const e of byReach()) {
        try { const v = await client.rpc<DirectVoice>(e.id, 'voice.direct', {}, 20_000); keepVoice(v); return v; }
        catch { /* an older machine, or no key there */ }
      }
      return null;
    })().finally(() => { asking = null; });
    const run = async (audio: Blob, mime: string) => {
      let direct = keptVoice() ?? await fetchKey();
      if (direct) {
        try { return await groqDirect(direct, audio, mime); }
        catch (err: any) {
          // A changed key: ask again once. Anything else falls back below.
          if (err?.status === 401 || err?.status === 403) {
            keepVoice(null);
            direct = await fetchKey();
            if (direct) { try { return await groqDirect(direct, audio, mime); } catch { /* fall back */ } }
          }
        }
      }
      const data = toBase64(await audio.arrayBuffer());
      let last = '';
      for (const e of byReach()) {
        try {
          const r = await client.rpc<{ text: string }>(e.id, 'voice.transcribe', { audio: data, mime }, 60_000);
          return r.text;
        } catch (err: any) { last = err?.message ?? 'transcription failed'; }
      }
      throw new Error(last || 'no machine could transcribe that');
    };
    // While you speak: fetch the key if this device has none yet, and time
    // the machines in case the direct call has to fall back.
    const warm = () => {
      if (keptVoice()) return () => {};
      void fetchKey();
      const stops = voiceEnvs.map((e) => client.watchLatency(e.id));
      return () => stops.forEach((stop) => stop());
    };
    return Object.assign(run, { warm });
  };

  // The brain always belongs to the VM, even while it is asleep. Saved
  // sessions are signposts until that machine's live list arrives.
  const brainEnv = brainHost(envs);
  const [remembered, setRemembered] = useState<RememberedBrain[]>(loadBrains);
  const [brainOpening, setBrainOpening] = useState(false);
  useEffect(() => {
    let next = remembered;
    for (const e of brainEnv ? [brainEnv] : []) {
      const list = sessions[e.id];
      if (!list || !e.online) continue; // no fresh answer from the brain host
      const s = list.find((x) => x.brain) ?? null;
      const had = next.find((b) => b.envId === e.id);
      if (s) {
        if (had && had.session.id === s.id && had.session.model === s.model
          && had.session.status === s.status) continue;
        saveBrain(e.id, s);
        next = [...next.filter((b) => b.envId !== e.id), { envId: e.id, session: s }];
      } else if (had) {
        forgetBrain(e.id);
        next = next.filter((b) => b.envId !== e.id);
      }
    }
    if (next !== remembered) setRemembered(next);
  }, [brainEnv, sessions, remembered]);

  /** This machine's brain, live record if there is one and signpost if not. */
  const brainOn = (envId: string): Session | null =>
    (sessions[envId] ?? []).find((s) => s.brain)
    ?? remembered.find((b) => b.envId === envId)?.session
    ?? null;

  const openBrain = async () => {
    if (!brainEnv || brainOpening) return;
    const s = brainOn(brainEnv.id);
    if (!s) { navigate([{ kind: 'brain' }], brainEnv.id); return; }
    if (!brainEnv.online) { navigate([{ kind: 'session', session: s }], brainEnv.id); return; }
    setBrainOpening(true);
    try {
      const r = await client.rpc<{ session: Session }>(brainEnv.id, 'brain.open', {}, 60_000);
      rememberBrain(brainEnv.id, r.session);
      loadSessions(brainEnv.id);
      navigate([{ kind: 'session', session: r.session }], brainEnv.id);
    } catch (e: any) { setError(`Could not open the Helm brain: ${e.message}`); }
    finally { setBrainOpening(false); }
  };
  const rememberBrain = (envId: string, s: Session) => {
    saveBrain(envId, s);
    setRemembered((prev) => [...prev.filter((b) => b.envId !== envId), { envId, session: s }]);
  };
  const dropBrain = (envId: string) => {
    forgetBrain(envId);
    setRemembered((prev) => prev.filter((b) => b.envId !== envId));
  };

  const blockedAll = envs.flatMap((e) => agentsOf(e.id).filter(needsAttention).map((s) => ({ env: e, s })));
  const blocked = blockedAll.filter(({ env: e, s }) => !snoozedNow(e.id, s.id));
  const asleep = blockedAll.filter(({ env: e, s }) => snoozedNow(e.id, s.id));
  // Home is one list across every machine: what needs you, and what is
  // running. A brain has its own place under "brains".
  const everyone = envs.flatMap((e) => agentsOf(e.id).filter((s) => !s.brain).map((s) => ({ env: e, s })));
  const byNewest = (a: { s: Session }, b: { s: Session }) => (b.s.updatedAt ?? 0) - (a.s.updatedAt ?? 0);
  const runningNow = everyone.filter(({ env: machine, s: thread }) => machine.online && !attentionOn(machine.id, thread) && runningThread(thread)).sort(byNewest);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !event.ctrlKey || event.metaKey || event.altKey || event.isComposing
          || document.querySelector('[aria-modal="true"]') || !runningNow.length) return;
      const current = nav.current.stack.at(-1);
      // In a terminal, Ctrl+Tab walks that machine's terminals (SessionView).
      if (current?.kind === 'session' && current.session.engine === 'shell') return;
      // Capture before a composer completes a suggestion or xterm sends input.
      event.preventDefault();
      event.stopPropagation();
      const index = runningNow.findIndex(({ env, s }) => env.id === nav.current.selected
        && current?.kind === 'session' && s.id === current.session.id);
      const next = index < 0 ? (event.shiftKey ? runningNow.length - 1 : 0)
        : (index + (event.shiftKey ? -1 : 1) + runningNow.length) % runningNow.length;
      const { env, s } = runningNow[next];
      if (index !== next) openSession(env.id, s);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [runningNow, openSession]);
  // Ctrl/Cmd+Shift+E opens a terminal, next to Shift+B for the browser (T is
  // the browser's own "reopen tab" and cannot be taken). From a chat it is
  // that chat's folder; the same key in a terminal goes back to where you
  // were. A terminal already open there is reused, so a running build or
  // server is never cut off.
  const terminalOpening = useRef(false);
  /** Back to the newest terminal on a machine (or the one in `cwd`), else a new one there. */
  const openTerminalOn = useCallback((envId: string, cwd = '~', inFolder = false) => {
    const open = (sessions[envId] ?? []).filter(ownTerminal).sort(byRecent);
    const reuse = inFolder ? open.find((s) => s.cwd === cwd) : open[0];
    if (reuse) { openSession(envId, reuse); return; }
    if (terminalOpening.current) return;
    terminalOpening.current = true;
    client.rpc<{ session: Session }>(envId, 'session.start', { cwd, profileId: 'shell' }, 45_000)
      .then((r) => { loadSessions(envId); if (r?.session) openSession(envId, r.session); })
      .catch(() => { /* the machine is off or has no shell; nothing to open */ })
      .finally(() => { terminalOpening.current = false; });
  }, [sessions, openSession, client, loadSessions]);
  // The machine this window runs on, when it is one of yours: the laptop's
  // own app window is served by the laptop at a loopback address.
  const [hereId, setHereId] = useState<string | null>(null);
  useEffect(() => {
    if (!LOOPBACK_HOST.test(location.hostname)) return;
    fetch(`${location.origin}/api/health`, { signal: AbortSignal.timeout(5000) })
      .then((r) => r.ok ? r.json() : null)
      .then((health) => setHereId(typeof health?.machine === 'string' ? health.machine : null))
      .catch(() => { /* an older machine does not say; the other choices still work */ });
  }, []);
  // Ctrl/Cmd+Alt+T: a new terminal right away, like a desktop's own key.
  // On the machine you are in; with none chosen, this computer when the app
  // runs on one of your machines, else where you last used a terminal, else
  // the first machine that is on.
  const instantTerminal = useRef<() => void>(() => {});
  instantTerminal.current = () => {
    const online = envs.filter((e) => e.online);
    const current = nav.current.stack.at(-1);
    const global = !current || ['usage', 'brain', 'links', 'updates', 'models', 'devices', 'app-settings', 'network-settings'].includes(current.kind)
      && !(current.kind === 'usage' && current.envId);
    const chosen = !global && nav.current.selected !== autoPicked.current ? nav.current.selected : null;
    const lastUsed = (e: Environment) => Math.max(0, ...(sessions[e.id] ?? []).filter(ownTerminal).map((s) => s.updatedAt ?? 0));
    const machine = online.find((e) => e.id === chosen)
      ?? online.find((e) => e.id === hereId)
      ?? [...online].sort((a, b) => lastUsed(b) - lastUsed(a)).find((e) => lastUsed(e) > 0)
      ?? online[0];
    if (!machine || terminalOpening.current) return;
    const chat = current?.kind === 'session' && !current.session.quick && current.session.engine !== 'shell' && machine.id === chosen ? current.session : null;
    terminalOpening.current = true;
    client.rpc<{ session: Session }>(machine.id, 'session.start', { cwd: chat?.cwd || '~', profileId: 'shell' }, 45_000)
      .then((r) => { loadSessions(machine.id); if (r?.session) openSession(machine.id, r.session); })
      .catch(() => { /* the machine is off or has no shell; nothing to open */ })
      .finally(() => { terminalOpening.current = false; });
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== 'KeyT' || !(event.ctrlKey || event.metaKey) || !event.altKey || event.shiftKey || event.isComposing
          || document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      instantTerminal.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  // Ctrl/Cmd+Shift+T: pick a device, land in its terminal. Only the Helm app
  // window gets this key; an ordinary browser tab keeps it for "reopen tab".
  const [terminalPicker, setTerminalPicker] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== 'KeyT' || !(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey || event.isComposing
          || document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      setPalette(false);
      setTerminalPicker(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== 'KeyE' || !(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey || event.isComposing
          || document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      const current = nav.current.stack.at(-1);
      if (current?.kind === 'session' && current.session.engine === 'shell') { history.back(); return; }
      const envId = nav.current.selected ?? envs.find((e) => e.online)?.id;
      if (!envId) return;
      const chat = current?.kind === 'session' && !current.session.quick ? current.session : null;
      openTerminalOn(envId, chat?.cwd || '~', !!chat);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [envs, openTerminalOn]);
  const runningCount = envs.reduce((total, machine) => total + workingThreadsOn(machine).length, 0);
  // A thread that stops working leaves "running" for "done" rather than
  // vanishing from the sidebar. Keep the latest three days in date order;
  // older work stays available on its machine and through search.
  //
  // Only machines that are on, like Working: a machine that is off is known
  // here only from what this device happened to save the last time it saw
  // it, so each phone and computer counted a different, frozen list. Until
  // the live machine list arrives (or with no connection at all) the saved
  // lists are all there is, and they show, marked as saved.
  // A chat that cloned a repo stays listed before its first message: the
  // owner leaves it while the repo comes down and comes back to it here.
  const doneNow = everyone.filter(({ env: machine, s }) => ((s.driver || s.adopted) && ((s.turns ?? 0) > 0 || !!s.clone) || s.nativeCli && s.alive)
    && (machine.online || !liveEnvsSeen.current)
    && settledThread(s)
    && tick - (s.updatedAt ?? 0) < DONE_FOR_MS).sort(byNewest);
  const doneIsSaved = doneNow.some(({ env }) => !env.online || !liveListsSeen.current.has(env.id));
  useSeenVersion();
  const unreadDone = doneNow.filter(({ s }) => isUnread(s)).length;
  const isOpen = ({ env: e, s }: { env: Environment; s: Session }) => selected === e.id && view.kind === 'session' && view.session.id === s.id;
  const homeRow = (x: { env: Environment; s: Session }, slim = false) => (
    <HomeRow key={x.s.id} s={x.s} machine={x.env.name} slim={slim} selected={isOpen(x)} onOpen={() => openSession(x.env.id, x.s)} actions={threadActions(x.env, x.s)} />
  );
  // A chat you have open is a chat you have seen, including what it finishes while you watch.
  const openId = view.kind === 'session' ? view.session.id : null;
  const openStamp = everyone.find(({ s }) => s.id === openId)?.s;
  // The machine keeps the look too, so the tick clears on every device.
  useEffect(() => {
    if (openId && selected && markSeen(openId)) client.rpc(selected, 'session.seen', { id: openId }).catch(() => { /* an older machine: this device still knows */ });
  }, [openId, openStamp?.updatedAt, openStamp?.status]);
  // Chats this device opened before its machine kept the look: hand each
  // over once, so a chat read here stops showing as new everywhere else.
  const handedOver = useRef(new Set<string>());
  const doneKey = doneNow.map(({ s }) => `${s.id}:${s.updatedAt}:${s.seenAt}`).join();
  useEffect(() => {
    for (const { env: machine, s } of doneNow) {
      if (!machine.online || handedOver.current.has(s.id) || (s.seenAt ?? 0) >= (s.updatedAt ?? 0)) continue;
      if (seenHere(s.id) < (s.updatedAt ?? 0)) continue;
      handedOver.current.add(s.id);
      client.rpc(machine.id, 'session.seen', { id: s.id }).catch(() => { /* an older machine: this device still knows */ });
    }
  }, [doneKey]);
  const snoozeThread = (envId: string, s: Session, until: number) => {
    setSnooze(`${envId}:${s.id}`, until);
    setSnoozeUndo({ key: `${envId}:${s.id}`, title: s.title, until });
  };

  // On a phone the two panes are one screen at a time: the main pane is shown
  // once a machine is selected, and every view - the brain included - belongs
  // to one.
  // Usage across every machine is a main-pane view that belongs to no machine,
  // so it has to open the main pane on a phone without one being selected -
  // and what devices hold keys, and the settings they live under, belong to
  // no machine either.
  const showMain = wide || !!selected || view.kind === 'usage' || view.kind === 'devices'
    || view.kind === 'network-settings' || view.kind === 'app-settings' || view.kind === 'updates'
    || view.kind === 'links';

  // Honest connection words. A dropped socket with a hub that still answers
  // HTTP is "reconnecting", quietly; only a long silence from everything
  // deserves red.
  const downFor = downSince ? Date.now() - downSince : 0;
  const status = conn.online ? 'live' : conn.reachable ? 'reconnecting' : downFor > 12_000 ? 'offline' : 'connecting';

  return (
    <div className="shell">
      <aside className={`sidebar${!showMain ? ' showing' : ''}${wide && sidebarCollapsed ? ' collapsed' : ''}`}>
        <div className="bar side">
          <div className="brand">
            <img src="/favicon.svg" alt="" />
            <b className="wordmark">helm</b>
          </div>
          {/* Live with every machine up is just the dot: the machines list
              below already says who is online. Words appear when something
              is off. */}
          {(() => {
            const online = envs.filter((e) => e.online).length;
            const quiet = status === 'live' && online === envs.length;
            return <span className={`conn ${status}`} title={conn.error || (quiet ? `Connected · ${online} of ${envs.length} machines online` : status)}
              role="status" aria-label={quiet ? `Connected, all ${envs.length} machines online` : undefined}>
              <i />{quiet ? '' : status === 'live' ? `${online}/${envs.length} online` : status}
            </span>;
          })()}
          <span className="side-tools">
            <button
              className="iconbtn settings-toggle" title="Settings" aria-label="Settings"
              onClick={() => navigate([{ kind: 'app-settings' }])}
            ><Gear /></button>
            <button
              className="iconbtn collapse-toggle"
              title={sidebarCollapsed ? 'expand sidebar' : 'collapse sidebar'}
              aria-label={sidebarCollapsed ? 'expand sidebar' : 'collapse sidebar'}
              onClick={() => collapseSidebar(!sidebarCollapsed)}
            ><Icon name="sidebar" size={17} /></button>
          </span>
        </div>

        {/* Folded, the sidebar keeps what is live: a new chat, then each
            chat that needs you or is working, as its agent's mark. */}
        {wide && sidebarCollapsed && (
          <nav className="side-rail" aria-label="Active chats">
            <button
              type="button" className="iconbtn rail-new" onClick={() => setNewChat({})}
              disabled={!envs.some((e) => e.online)} aria-label="New chat" title="New chat (Ctrl+N)"
            ><Icon name="plus" size={17} /></button>
            {[...blocked.map((x) => ({ ...x, need: true })), ...runningNow.map((x) => ({ ...x, need: false }))].map(({ env: e, s, need }) => {
              const open = isOpen({ env: e, s });
              const word = need ? 'needs you' : 'working';
              return (
                <button
                  key={`${e.id}:${s.id}`} type="button" className={`rail-chat ${need ? 'rail-need' : 'rail-working'}${open ? ' active' : ''}`}
                  aria-current={open ? 'page' : undefined} aria-label={`${s.title}, ${e.name}, ${word}`} title={`${s.title}\n${e.name} · ${word}`}
                  onClick={() => openSession(e.id, s, need && s.status !== 'blocked' && !s.recovery && !!(s.team?.blocked || s.team?.failed))}
                >
                  <EngineMark engine={engineOf(s.engine).cls} />
                  <i className="rail-dot" aria-hidden="true" />
                </button>
              );
            })}
          </nav>
        )}

        <div className="scroll">
          <div className="side-pad">
            {!showMain && sends.notices.slice(-1).map(job => <SendNotice key={job.id} job={job}
              onDismiss={() => sends.store.dismiss(job.id)} onOpen={() => {
                sends.store.dismiss(job.id);
                navigate([{ kind: 'env' }, { kind: 'transfer', cwd: job.source.path, jobId: job.id }], job.source.machineId);
              }} />)}
            {status === 'offline' && (
              <div className="banner error">
                No machine answered for a while. Check the VM, or that this phone has internet.
              </div>
            )}

            <button
              type="button" className="home-search" onClick={() => setPalette(true)}
              aria-label="Search threads, machines and folders" aria-keyshortcuts="/ Control+K Meta+K"
              title="Search threads, machines and folders"
            >
              <Icon name="search" size={15} />
              <span className="grow">Search anything</span>
            </button>
            <button
              type="button" className="home-search" onClick={() => setNewChat({})}
              disabled={!envs.some((e) => e.online)}
              aria-label="New chat" aria-keyshortcuts="Control+N Meta+N Control+Shift+N Meta+Shift+N Control+Shift+O Meta+Shift+O" title="New chat (Ctrl+N); in current folder (Ctrl+Shift+N)"
            >
              <Icon name="plus" size={15} />
              <span className="grow">New chat</span>
            </button>

            <div className="rows plain brain-entry">
                {brainEnv ? (() => {
                  const s = brainOn(brainEnv.id);
                  return <button className="row tall" disabled={brainOpening} onClick={() => void openBrain()}>
                    <EngineMark engine={s ? engineOf(s.engine).cls : undefined} />
                    <span className="grow">
                      <span className="rt"><span className="rt-text">Helm brain</span>{s?.status === 'blocked' && <span className="tag">needs you</span>}</span>
                      <span className="rm">
                        {brainEnv.name} · {s ? engineOf(s.engine).label : 'Choose an account'}{!brainEnv.online ? ' · offline' : ''}
                      </span>
                    </span>
                    {brainOpening ? <span className="chip working"><i />opening</span>
                      // The brain is counted in its machine's "running", so it says so here.
                      : s && brainEnv.online && !attentionOn(brainEnv.id, s) && runningThread(s) ? <StatusChip status={busyWord(s.status, s.compacting)} at={s.updatedAt} />
                      : <span className="chev"><Icon name="forward" size={15} /></span>}
                  </button>;
                })() : <button className="row tall" disabled>
                  <EngineMark />
                  <span className="grow"><span className="rt">Helm brain</span><span className="rm">Add a VM to start</span></span>
                </button>}
            </div>

            {blocked.length > 0 && (
              <Fold shelf attention defaultOpen title="Needs you" count={blocked.length} remember="sidebar:needs">
                {blocked.map(({ env: e, s }) => (
                  <NeedCard
                    key={s.id} s={s} machine={e.name} onOpen={() => openSession(e.id, s, s.status !== 'blocked' && !s.recovery && !!(s.team?.blocked || s.team?.failed))}
                    onSnooze={(until) => snoozeThread(e.id, s, until)}
                    onDismiss={async () => { await client.rpc(e.id, 'session.dismiss-child-failures', { id: s.id }); }}
                  />
                ))}
              </Fold>
            )}

            {asleep.some(({ s }) => !runningThread(s)) && (
              <Fold shelf title="Snoozed" count={asleep.filter(({ s }) => !runningThread(s)).length} remember="sidebar:snoozed">
                <div className="rows plain">
                  {asleep.filter(({ s }) => !runningThread(s)).map(({ env: e, s }) => (
                    <HomeRow
                      key={s.id} s={s} machine={e.name} onOpen={() => { setSnooze(`${e.id}:${s.id}`, null); openSession(e.id, s); }}
                      note={snoozed[`${e.id}:${s.id}`] === NEVER_SNOOZE ? 'Snoozed \u00b7 Never' : `back ${when(snoozed[`${e.id}:${s.id}`])}`}
                      actions={threadActions(e, s)}
                    />
                  ))}
                </div>
              </Fold>
            )}

            {runningNow.length > 0 && (
              <Fold
                shelf defaultOpen title="Working" count={runningNow.length} remember="sidebar:working"
                peek={runningNow.some(isOpen) ? <div className="rows plain">{runningNow.filter(isOpen).map((x) => homeRow(x))}</div> : undefined}
              >
                <div className="rows plain">{runningNow.map((x) => homeRow(x))}</div>
              </Fold>
            )}

            {doneNow.length > 0 && (
              <Fold
                shelf defaultOpen title="Settled" count={doneNow.length} remember="sidebar:settled"
                note={unreadDone ? `${unreadDone} new` : doneIsSaved ? 'saved' : undefined} noteTone={unreadDone ? 'fresh' : undefined}
                peek={doneNow.some(isOpen) ? <div className="rows plain">{doneNow.filter(isOpen).map((x) => homeRow(x, true))}</div> : undefined}
              >
                <PagedRows
                  items={doneNow} isSelected={isOpen} row={(x) => homeRow(x, true)}
                  first={SETTLED_FIRST} step={SETTLED_STEP}
                />
              </Fold>
            )}

            <SendActivity jobs={sends.jobs} onOpen={(job) => navigate([
              { kind: 'env' }, { kind: 'transfer', cwd: job.source.path, jobId: job.id },
            ], job.source.machineId)} />

            <Fold shelf title="Machines" count={envs.length} defaultOpen remember="sidebar:machines" showEmpty>
              <div className="rows plain">
                {envs.map((e) => {
                  const waiting = waitingCountOn(e);
                  return (
                    <button
                      key={e.id}
                      className={`row tall machine${e.id === selected && wide ? ' active' : ''}${e.online ? '' : ' offline'}`}
                      aria-current={e.id === selected && wide ? 'true' : undefined}
                      onClick={() => openEnv(e.id)}
                    >
                      <span className={`mdot ${e.online ? 'on' : 'off'}`} />
                      <span className="grow">
                        <span className="rt"><span className="rt-text">{e.name}</span></span>
                        <span className="rm">
                          {e.online
                            ? activityOn(e, 'idle')
                            : e.lastSeen ? `seen ${ago(e.lastSeen)}` : 'never connected'}
                        </span>
                      </span>
                      {waiting > 0 && <span className="badge">{waiting}</span>}
                      <span className="chev"><Icon name="forward" size={15} /></span>
                    </button>
                  );
                })}
                {!envs.length && !error && (
                  <div className="empty quiet">
                    No machines yet
                    <div className="note">Run <code>helm add pc</code> on a machine that is already in your network.</div>
                  </div>
                )}
              </div>
            </Fold>

            {/* Setup, spend and pairing are a page of their own now - the
                gear up top. The home screen is just the machines and what
                is running on them. */}
            {error && <div className="error">{error}</div>}
            {envError && <p className="note" role="status">{envs.length ? 'Saved workspace · reconnecting…' : 'Connecting to your machines…'}</p>}
          </div>
        </div>
      </aside>

      <section className={`main${showMain ? ' showing' : ''}`}>
        {sends.notices.slice(-1).map(job => <SendNotice key={job.id} job={job}
          onDismiss={() => sends.store.dismiss(job.id)} onOpen={() => {
            sends.store.dismiss(job.id);
            navigate([{ kind: 'env' }, { kind: 'transfer', cwd: job.source.path, jobId: job.id }], job.source.machineId);
          }} />)}
        {view.kind !== 'transfer' && sends.jobs.some(sending) && <div className="send-mobile-status">
          <button className="linkish" onClick={() => {
            const job = sends.jobs.find(sending)!;
            navigate([{ kind: 'env' }, { kind: 'transfer', cwd: job.source.path, jobId: job.id }], job.source.machineId);
          }}>{sends.jobs.filter(sending).length > 1 ? `${sends.jobs.filter(sending).length} sends in progress`
            : `Sending to ${sends.jobs.find(sending)!.target.name} · View`}</button>
        </div>}
        <MachineUpdateNotice envs={envs} onOpen={() => push({ kind: 'updates' })} />
        {view.kind === 'app-settings' ? (
          <SettingsView
            client={client} envs={envs} onBack={back}
            onVoice={(ids) => setEnvs((list) => list.map((m) => (ids.includes(m.id) ? { ...m, info: { ...m.info, voice: true } } : m)))}
            onOpen={(v) => push(v)} onUnpair={() => setUnpairing(true)}
          />
        ) : view.kind === 'usage' ? (
          <Suspense fallback={<ViewLoading title="Usage" onBack={back} />}>
            <UsageView client={client} envs={envs} initialEnvId={view.envId} onBack={back} />
          </Suspense>
        ) : view.kind === 'devices' ? (
          <DevicesView client={client} onBack={back} />
        ) : view.kind === 'updates' ? (
          <Suspense fallback={<ViewLoading title="Updates" onBack={back} />}>
            <UpdatesView client={client} envs={envs} onBack={back} onRefresh={loadEnvs} onOpenSession={openSession} />
          </Suspense>
        ) : view.kind === 'links' ? (
          <LinksView client={client} envs={envs} onBack={back} />
        ) : view.kind === 'network-settings' ? (
          <NetworkSettings
            client={client} envs={envs} onBack={back}
            onOpen={(envId, account) => navigate([
              { kind: 'env' }, { kind: 'settings' }, { kind: 'models', account },
            ], envId)}
          />
        ) : !env ? (
          // A wide screen with no machine open yet: the machines themselves,
          // as large rows, rather than a whisper in an empty pane.
          <div className="scroll"><div className="pad column chooser">
            <h2 className="screen-title">Machines</h2>
            <p className="readout">
              {envs.length === 1 ? '1 machine' : `${envs.length} machines`}
              {' · '}{envs.filter((e) => e.online).length} online
              {runningCount > 0 && ` · ${runningCount} running`}
              {blocked.length > 0 && <span className="attention"> · {blocked.length} {blocked.length === 1 ? 'needs' : 'need'} you</span>}
            </p>
            {envs.length > 0 ? (
              <div className="rows plain">
                {envs.map((e) => {
                  const waiting = waitingCountOn(e);
                  return (
                    <button key={e.id} className={`row tall machine${e.online ? '' : ' offline'}`} onClick={() => openEnv(e.id)}>
                      <span className={`mdot ${e.online ? 'on' : 'off'}`} />
                      <span className="grow">
                        <span className="rt"><span className="rt-text">{e.name}</span></span>
                        <span className="rm">
                          {e.online
                            ? activityOn(e, 'Nothing running')
                            : e.lastSeen ? `Offline · seen ${ago(e.lastSeen)}` : 'Never connected'}
                        </span>
                      </span>
                      {waiting > 0 && <span className="badge">{waiting}</span>}
                      <span className="chev"><Icon name="forward" size={15} /></span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="empty quiet">
                {envError ? 'The hub did not answer' : 'No machines yet'}
                {!error && <div className="note">Run <code>helm add pc</code> on a machine that is already in your network.</div>}
              </div>
            )}
          </div></div>
        ) : view.kind === 'brain' ? (
          <BrainView
            key={env.id}
            client={client} env={env} brain={brainOn(env.id)} onBack={back}
            // Replaces this screen rather than stacking on it: choosing a
            // network brain happens once, and going back to a form offering
            // to start the thing you just started is nonsense.
            onStarted={(s) => {
              rememberBrain(env.id, s);
              loadSessions(env.id);
              restate([{ kind: 'session', session: s }], env.id);
            }}
            onReplaced={() => loadSessions(env.id)}
          />
        ) : view.kind === 'env' ? (
          <EnvView
            key={env.id}
            client={client} env={env} wide={wide} onBack={back}
            sendJobs={sends.jobs} sendTarget={envs.find(e => e.id !== env.id && e.name.toLowerCase() === 'vm')?.name ?? envs.find(e => e.id !== env.id && e.online)?.name}
            sessions={(sessions[env.id] ?? []).filter(listedThread)} reload={reloadEnv}
            isSnoozed={(s) => snoozedNow(env.id, s.id)}
            remembered={env.online ? undefined : snap?.machines?.[env.id]?.sessions.filter((s) => listedThread(s)
              && !(sessions[env.id] ?? []).some(known => known.id === s.id))}
            rememberedAt={env.online ? undefined : snap?.machines?.[env.id]?.at}
            onResume={(s) => resumeFound(env.id, s)} resuming={resuming}
            onNewSession={() => setNewChat({ envId: env.id })}
            onAddProject={() => push({ kind: 'browse' })}
            onIntegrations={() => push({ kind: 'integrations' })}
            onSendProject={(cwd) => push(cwd ? { kind: 'transfer', cwd } : { kind: 'transfer-browse' })}
            onCheckProject={(path) => push({ kind: 'verify', path })}
            onStart={(cwd) => push({ kind: 'start', cwd })}
            onSettings={() => push({ kind: 'settings' })}
            onUsage={() => push({ kind: 'usage', envId: env.id })}
            onMedia={() => push({ kind: 'media' })}
            onOpen={(s) => push({ kind: 'session', session: s })}
          />
        ) : view.kind === 'integrations' ? (
          <Suspense fallback={<ViewLoading title="Connectors & skills" onBack={back} />}>
            <IntegrationsView key={env.id} client={client} env={env} onBack={back} onOpenSession={(s) => openSession(env.id, s)} />
          </Suspense>
        ) : view.kind === 'media' ? (
          <MediaView key={env.id} client={client} env={env} onBack={back} />
        ) : view.kind === 'starting' ? (
          <StartingChatView key={view.startId} client={client} env={env} startId={view.startId} onBack={back} />
        ) : view.kind === 'native-agent' ? (
          <NativeAgentView key={`${env.id}:${view.parent.id}:${view.agent.id}`} client={client} env={env} parent={view.parent} agent={view.agent} onBack={back} />
        ) : view.kind === 'settings' ? (
          <EnvSettings
            client={client} env={env} onBack={back}
            onRenamed={loadEnvs}
            onEdit={(account) => push({ kind: 'models', account })}
          />
        ) : view.kind === 'models' ? (
          <ModelPrefsView client={client} env={env} account={view.account} onBack={back} />
        ) : view.kind === 'new' ? (
          <Browse
            client={client} env={env} path={view.path} onBack={back}
            title="New session" action="Choose this folder"
            onInto={(path) => push({ kind: 'new', path })}
            onPick={(cwd) => push({ kind: 'start', cwd })}
            onQuick={() => push({ kind: 'start', cwd: '', quick: true })}
          />
        ) : view.kind === 'browse' ? (
          <Browse
            client={client} env={env} path={view.path} onBack={back}
            title="Add project" action="Add this project" onSend={(cwd) => push({ kind: 'transfer', cwd })}
            onInto={(path) => push({ kind: 'browse', path })}
            onPick={async (cwd) => {
              await client.rpc<{ project: Project }>(env.id, 'project.save', { path: cwd }, 20_000);
              restate([{ kind: 'env' }]);
            }}
          />
        ) : view.kind === 'transfer-browse' ? (
          <Browse
            client={client} env={env} path={view.path} onBack={back}
            title="Send" action="Send this folder" sendFiles
            onInto={(path) => push({ kind: 'transfer-browse', path })}
            onPick={(cwd) => push({ kind: 'transfer', cwd })}
          />
        ) : view.kind === 'transfer' ? (
          <Suspense fallback={<ViewLoading title="Send a project" onBack={back} />}>
            <TransferView
              key={`${env.id}:${view.cwd}`}
              client={client} source={env} envs={envs} folder={view.cwd} session={view.session} jobId={view.jobId} onBack={back}
              onJob={(job) => restate([...nav.current.stack.slice(0, -1), { kind: 'transfer', cwd: job.source.path, jobId: job.id }])}
              onAgain={() => restate([...nav.current.stack.slice(0, -1), { kind: 'transfer', cwd: view.cwd }])}
              onOpenFolder={(targetId, path) => navigate([{ kind: 'env' }, { kind: 'browse', path }], targetId)}
              onStartChat={(targetId, path) => navigate([{ kind: 'env' }, { kind: 'start', cwd: path }], targetId)}
              onOpenSession={(targetId, session) => navigate([
                { kind: 'env' }, { kind: 'session', session },
              ], targetId)}
            />
          </Suspense>
        ) : view.kind === 'verify' ? (
          <Suspense fallback={<ViewLoading title="Check setup" onBack={back} />}>
            <VerifyView
              client={client} env={env} folder={view.path} onBack={back}
              onOpenSession={(envId, session) => navigate([
                { kind: 'env' }, { kind: 'session', session },
              ], envId)}
            />
          </Suspense>
        ) : view.kind === 'start' ? (
          <Start
            client={client} env={env} cwd={view.cwd} quick={view.quick} onBack={back}
            onStarted={(s) => {
              loadSessions(env.id);
              // The browsing chain collapses into the session it produced:
              // this entry is replaced so back lands on the folder picker,
              // not on a form for a session that already exists.
              restate([{ kind: 'env' }, { kind: 'session', session: s }]);
            }}
          />
        ) : (view.session.driver || (sessions[env.id] ?? []).find((s) => s.id === view.session.id)?.driver) ? (
          <DrivenSession
            key={`${env.id}:${view.session.id}`}
            client={client} env={env} machines={envs} conn={conn} onTranscribe={transcribeVia(env.id)} reviewChildren={view.reviewChildren}
            onSendTask={view.session.quick || view.session.external || view.session.brain || view.session.engine === 'shell'
              ? undefined : () => push({ kind: 'transfer', cwd: view.session.cwd, session: view.session })}
            onSendFolder={view.session.quick || !view.session.cwd ? undefined : () => push({ kind: 'transfer', cwd: view.session.cwd })}
            session={(sessions[env.id] ?? []).find((s) => s.id === view.session.id) ?? view.session}
            onBack={back}
            onSettings={() => navigate([{ kind: 'brain' }], env.id)}
            onOpenSession={(s) => openRelatedSession(env.id, s)}
            onOpenNative={(agent) => push({ kind: 'native-agent', parent: view.session, agent })}
            onOpenMachineSession={openSession}
            onClosed={() => { if (view.session.brain) dropBrain(env.id); loadSessions(env.id); back(); }}
            onArchived={() => { loadSessions(env.id); back(); }}
            onSession={onSessionChanged(env.id)}
          />
        ) : (
          <SessionView
            key={`${env.id}:${view.session.id}`}
            client={client} env={env} machines={envs} onTranscribe={transcribeVia(env.id)}
            onSendTask={view.session.quick || view.session.external || view.session.brain || view.session.engine === 'shell'
              ? undefined : () => push({ kind: 'transfer', cwd: view.session.cwd, session: view.session })}
            onSendFolder={view.session.quick || !view.session.cwd ? undefined : () => push({ kind: 'transfer', cwd: view.session.cwd })}
            session={(sessions[env.id] ?? []).find((s) => s.id === view.session.id) ?? view.session}
            terminals={(sessions[env.id] ?? []).filter(ownTerminal).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))}
            onSwitch={(s) => restate([...nav.current.stack.slice(0, -1), { kind: 'session', session: s }])}
            onOpenNative={(agent) => push({ kind: 'native-agent', parent: view.session, agent })}
            onNewTerminal={async () => {
              const r = await client.rpc<{ session: Session }>(env.id, 'session.start', { cwd: '~', profileId: 'shell' }, 45_000);
              loadSessions(env.id);
              restate([...nav.current.stack.slice(0, -1), { kind: 'session', session: r.session }]);
            }}
            onBack={back}
            onClosed={() => {
              loadSessions(env.id);
              // Closing one terminal of several lands on a neighbour, not the machine.
              const next = view.session.engine === 'shell'
                ? (sessions[env.id] ?? []).filter((s) => ownTerminal(s) && s.id !== view.session.id).sort(byRecent)[0]
                : undefined;
              if (next) restate([...nav.current.stack.slice(0, -1), { kind: 'session', session: next }]);
              else back();
            }}
            onArchived={() => { loadSessions(env.id); back(); }}
            onSession={onSessionChanged(env.id)}
          />
        )}
      </section>

      {/* Another thread started waiting while this one was open. A tap on
          the toast is the whole journey to answering it. */}
      {toast && (
        <NotificationToast session={toast.session} machine={envs.find((m) => m.id === toast.envId)?.name} onDismiss={() => setToast(null)}
          onOpen={() => { const t = toast; setToast(null); openSession(t.envId, t.session); }} />
      )}

      {snoozeUndo && (
        <div className="undo" role="status">
          <span className="undo-text">Snoozed <b>{snoozeUndo.title}</b> {snoozeUndo.until === NEVER_SNOOZE ? 'indefinitely' : `until ${when(snoozeUndo.until)}`}</span>
          <button onClick={() => { setSnooze(snoozeUndo.key, null); setSnoozeUndo(null); }}>Undo</button>
        </div>
      )}
      {palette && <Palette items={paletteItems()} onClose={() => setPalette(false)} engineOf={engineOf} />}
      {terminalPicker && <Palette heading="Open a terminal" placeholder="Pick a device" engineOf={engineOf}
        onClose={() => setTerminalPicker(false)}
        items={envs.filter((e) => e.online).map((e) => {
          const open = (sessions[e.id] ?? []).filter(ownTerminal).length;
          return { id: `term:${e.id}`, group: 'machine' as const, title: e.name,
            sub: open ? `${open} terminal${open === 1 ? '' : 's'} open` : 'new terminal', keywords: 'device machine terminal shell',
            run: () => openTerminalOn(e.id) };
        })} />}
      {newChat && (
        <NewChat
          key={`${newChat.envId ?? ''}:${newChat.folder ?? ''}:${newChat.quick ? 'quick' : ''}`}
          client={client} envs={envs} envId={newChat.envId} initialFolder={newChat.folder} quick={newChat.quick} near={selected} engineOf={engineOf}
          onFolder={rememberChatFolder}
          onClose={() => setNewChat(null)}
          onStarting={(info, run) => { const chat = beginChat(client, info, run); navigate([{ kind: 'env' }, { kind: 'starting', startId: chat.id }], info.envId); }}
        />
      )}
      {help && <ShortcutsHelp onClose={() => setHelp(false)} />}

      {unpairing && (
        <Confirm
          title="Unpair this device?"
          body="You will need a fresh link from `helm link` to sign back in."
          confirmLabel="Unpair" danger
          onCancel={() => setUnpairing(false)}
          onConfirm={() => { setUnpairing(false); onSignOut(); }}
        />
      )}
    </div>
  );
}

function EnvView({ client, env, wide, sessions, remembered, rememberedAt, reload, onBack, onNewSession, onAddProject, onSendProject, onIntegrations, onCheckProject, onStart, onSettings, onUsage, onMedia, onOpen, onResume, resuming, isSnoozed = () => false, sendJobs = [], sendTarget }: {
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
  // Named, because archiving one of these has to refresh the list it came
  // from - the machine is the only place that remembers what was filed away.
  const reloadEarlier = useCallback(() => {
    if (!env.online) { setEarlier([]); return; }
    client.rpc(env.id, 'session.inventory', {}, 20_000)
      .then((r: any) => setEarlier(r.recent ?? []))
      .catch(() => {});
  }, [client, env.id, env.online]);
  useEffect(() => { reloadEarlier(); }, [reloadEarlier]);
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
            {env.name} is offline{env.lastSeen ? ` · last seen ${ago(env.lastSeen)}` : ''}. Threads open again when it reconnects.
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
            <p className="note">as it was when this machine last answered - it may be different now.</p>
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
          body="Projects with threads must be emptied first. Removing it never deletes files."
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

// -------------------------------------------------------------------- brain

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
function BrainView({ client, env, brain, onBack, onStarted, onReplaced }: {
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
      .catch((e) => setError(e.message));
  }, [client, env.id, env.online, picking]);

  // What this brain could think with. Asked of the live session, so the list
  // is what the running agent will actually accept.
  useEffect(() => {
    if (!brain || replacing || !env.online) return;
    client.rpc(env.id, 'model.list', { profileId: brain.profileId, id: brain.id })
      .then((r: any) => setModels(r))
      .catch(() => {});
  }, [client, env.id, brain?.id, env.online, replacing]);

  const start = async (a: Account) => {
    setBusy(a.key); setError('');
    try {
      // Replacing means the old thread goes: two brains on one machine would
      // each hold half of what you had told it.
      if (brain && replacing) await client.rpc(env.id, 'session.kill', { id: brain.id }, 30_000);
      const r = await client.rpc<{ session: Session }>(env.id, 'brain.open', { profileId: a.profile.id }, 60_000);
      onStarted(r.session);
    } catch (e: any) { setError(e.message); setBusy(''); }
  };

  const setModel = async (model: string) => {
    if (!brain) return;
    setBusy(model); setError('');
    try {
      await client.rpc(env.id, 'session.model', { id: brain.id, model }, 30_000);
      onReplaced();
    } catch (e: any) { setError(e.message); }
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
              One conversation for your whole network, living on {env.name}.
              It knows where your projects and sessions are. Tell it
              “go to why, open this folder, do this” and it works on that machine.
              Your laptop can sleep; the brain stays here.
            </p>
            {replacing && (
              <div className="banner warn">
                Starting a different brain on {env.name} ends this conversation.
                Its saved network map and knowledge notes stay on the VM.
              </div>
            )}
            <div className="section">Choose its account</div>
            {!accounts && !error && env.online && <div className="empty quiet">asking {env.name}…</div>}
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
                no agent accounts on that machine
                <div className="note" style={{ marginTop: 6 }}>the brain needs a CLI helm can drive headless</div>
              </div>
            )}
            {!env.online && <div className="empty quiet">{env.name} is offline</div>}
            {replacing && <button className="row" onClick={() => setReplacing(false)}><span className="grow"><span className="rt">Keep the brain I have</span></span></button>}
          </>
        ) : (
          <>
            <div className="section">thinking with</div>
            <div className="rows">
              {(models?.models ?? []).map((m) => {
                const current = (brain!.model ?? models?.default) === m;
                return (
                  <button key={m} className={`row${current ? ' active' : ''}`} disabled={!!busy} onClick={() => setModel(m)}>
                    <span className="grow">
                      <span className="rt"><span className="rt-text">{models?.labels?.[m] ?? m}</span></span>
                      {current && <span className="rm">what it thinks with now</span>}
                    </span>
                    {busy === m ? <span className="chip working"><i />changing</span> : current ? <span className="tag key">current</span> : <span className="chev"><Icon name="forward" size={15} /></span>}
                  </button>
                );
              })}
              {!models && <div className="empty quiet">{env.online ? 'asking the machine…' : `${env.name} is offline`}</div>}
            </div>
            <p className="note">
              The same picker is in the composer inside the conversation; this
              is here so the gear leads somewhere when you are looking for it.
            </p>

            <div className="section">where it lives</div>
            <div className="rows">
              <div className="row">
                <EngineMark engine={engineOf(brain!.engine).cls} />
                <span className="grow">
                  <span className="rt">{engineOf(brain!.engine).label} on {env.name}</span>
                  <span className="rm">{[brain!.profileId, shortPath(brain!.cwd), money(brain!.costUsd)].filter(Boolean).join(' · ')}</span>
                </span>
              </div>
            </div>

            <div className="section">rarely</div>
            <div className="rows">
              <button className="row destructive" onClick={() => setReplacing(true)}>
                <span className="grow">
                  <span className="rt">Start a different brain</span>
                  <span className="rm">starts a new conversation; keeps saved knowledge</span>
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

// ----------------------------------------------------------------- settings

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
          This machine is offline. A machine writes its own name, so the
          rename has to wait until it is back.
        </div>
      )}
      <p className="note">
        {changed && !ok
          ? `A name is ${MACHINE_NAME_RULE}.`
          // "Renamed" under "this machine is offline" is two answers to the
          // same question; the banner is the one that matters now.
          : done && env.online
            ? `Renamed. Every machine and device in this network calls it ${env.name} now.`
            // A machine that joined under a hostname with a space or an
            // apostrophe in it keeps that name - nothing rewrites a record
            // behind its owner's back - but ssh cannot reach it under one.
            : !validMachineName(env.name)
              ? <>The name every screen shows. ssh cannot use this one: rename it to
                  {' '}{MACHINE_NAME_RULE} and <code>ssh {env.name.replace(/[^A-Za-z0-9._-]/g, '')}</code> works.</>
              : <>The name every screen shows, and the one ssh answers to: <code>ssh {env.name}</code></>}
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
    { id: 'pc' as const, label: 'Computer', hint: 'runs agents, and controls others' },
    { id: 'vm' as const, label: 'Always-on server', hint: 'a home the others dial - takes an https address and serves it' },
    { id: 'nas' as const, label: 'Storage', hint: 'storage for the network - stays reachable' },
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
      <p className="note">
        An always-on server takes an https address and serves it; switching
        away stops advertising that address. This only changes what the other
        machines expect - the name shown everywhere stays the same.
      </p>
      {!env.online && (
        <div className="banner warn">
          This machine is offline. A machine writes its own record, so the
          change has to wait until it is back.
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </>
  );
}

/**
 * The settings page: everything that used to fill the bottom of the home
 * screen.
 *
 * None of it is the day's work - what the machines cost, what this device
 * can do, a join code for a new computer - so it lives one tap away under
 * the gear instead of under the machine list, where it outweighed the
 * machines themselves.
 */
function SettingsView({ client, envs, onBack, onVoice, onOpen, onUnpair }: {
  client: Client; envs: Environment[]; onBack: () => void; onVoice: (envIds: string[]) => void;
  onOpen: (v: MainView) => void; onUnpair: () => void;
}) {
  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <div className="titles"><h1>Settings</h1></div>
      </div>
      <div className="scroll"><div className="pad column">
        <div className="rows">
          <button className="row" onClick={() => onOpen({ kind: 'devices' })}>
            <span className="grow"><span className="rt">Devices & pairing</span></span>
            <span className="chev"><Icon name="forward" size={15} /></span>
          </button>
          <button className="row" onClick={() => onOpen({ kind: 'network-settings' })}>
            <span className="grow"><span className="rt">CLI defaults</span></span>
            <span className="chev"><Icon name="forward" size={15} /></span>
          </button>
          <button className="row" onClick={() => onOpen({ kind: 'links' })}>
            <span className="grow"><span className="rt">Public links</span></span>
            <span className="chev"><Icon name="forward" size={15} /></span>
          </button>
          <button className="row" onClick={() => onOpen({ kind: 'usage' })}>
            <span className="grow"><span className="rt">Usage & cost</span></span>
            <span className="chev"><Icon name="forward" size={15} /></span>
          </button>
          <button className="row" onClick={() => onOpen({ kind: 'updates' })}>
            <span className="grow"><span className="rt">Updates</span></span>
            <span className="chev"><Icon name="forward" size={15} /></span>
          </button>
        </div>

        <div className="section">dictation</div>
        <DictationKey client={client} envs={envs} onSaved={onVoice} />

        <div className="section">appearance</div>
        <div className="rows">
          <Suspense fallback={<div className="row appearance"><span className="grow"><span className="rt">Appearance</span></span></div>}>
            <AppearanceSettings />
          </Suspense>
          <Notifications client={client} />
          <InstallPwa />
        </div>

        <details className="note">
          <summary>Connection details</summary>
          <p>App address: {location.origin}</p>
          <p>App build: {document.querySelector<HTMLScriptElement>('script[type="module"]')?.src.split('/').at(-1) ?? 'development'}</p>
          <p>Hub: {client.relay}</p>
          <p>Socket: {client.connected ? 'connected' : 'reconnecting'}</p>
          {client.lastError && <p>Last connection error: {client.lastError}</p>}
        </details>
        <div className="rows">
          <button className="row destructive" onClick={onUnpair}>
            <span className="grow"><span className="rt">Unpair this device</span></span>
          </button>
        </div>
      </div></div>
    </>
  );
}

/**
 * Every machine's links in one place. They live on the machine that serves
 * them, so this is each machine's own list, one after another - the same
 * list its own settings show.
 */
function LinksView({ client, envs, onBack }: { client: Client; envs: Environment[]; onBack: () => void }) {
  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <div className="titles"><h1>Public links</h1><span className="sub">all machines</span></div>
      </div>
      <div className="scroll"><div className="pad column">
        <p className="note">
          A link shows something running on one of your machines. It ends by itself after 3 hours unless it was kept.
          A private one opens only on devices signed in to your Helm.
        </p>
        {envs.map((env) => (
          <div key={env.id}>
            <div className="section">{env.name}</div>
            <PublicLinks client={client} env={env} />
          </div>
        ))}
      </div></div>
    </>
  );
}

/** One place to inspect every machine's account defaults. */
function NetworkSettings({ client, envs, onBack, onOpen }: {
  client: Client; envs: Environment[]; onBack: () => void; onOpen: (envId: string, account: Account) => void;
}) {
  const [accounts, setAccounts] = useState<Record<string, Account[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let stale = false;
    for (const env of envs.filter((e) => e.online)) {
      client.rpc(env.id, 'profile.list')
        .then((r: any) => { if (!stale) setAccounts((all) => ({ ...all, [env.id]: accountsFrom(r.profiles) })); })
        .catch((e) => { if (!stale) setErrors((all) => ({ ...all, [env.id]: e.message })); });
    }
    return () => { stale = true; };
  }, [client, envs.map((e) => `${e.id}:${e.online}`).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <div className="titles"><h1>CLI defaults</h1><span className="sub">all machines</span></div>
      </div>
      <div className="scroll"><div className="pad column">
        <p className="note">
          These defaults live on each machine, so a session started from any paired device uses the same model,
          thinking, permissions and speed.
        </p>
        {envs.map((env) => {
          const list = accounts[env.id];
          return (
            <div key={env.id}>
              <div className="section">{env.name}</div>
              <div className="rows">
                {!env.online ? (
                  <div className="empty quiet">offline — its saved defaults will appear when it reconnects</div>
                ) : errors[env.id] ? (
                  <div className="empty quiet">{errors[env.id]}</div>
                ) : !list ? (
                  <div className="empty quiet">looking for agents…</div>
                ) : list.length === 0 ? (
                  <div className="empty quiet">no supported CLIs found</div>
                ) : list.map((a) => (
                  <button key={a.key} className="row tall" onClick={() => onOpen(env.id, a)}>
                    <EngineMark engine={engineOf(a.engine).cls} />
                    <span className="grow">
                      <span className="rt">{engineOf(a.engine).label} <span className="dim">· {a.account}</span></span>
                      <span className="rm">{startSummary(a)}</span>
                    </span>
                    <span className="chev"><Icon name="forward" size={15} /></span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div></div>
    </>
  );
}

/**
 * Per-machine settings: what the machine is called, and for each account on
 * it, which models the picker offers and which one a new session starts with.
 * The prefs live in the machine's ~/.helm/config.json and the name lives in
 * its roster record, so both follow the machine no matter which device asks.
 */
function EnvSettings({ client, env, onBack, onEdit, onRenamed }: {
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

        <div className="section">kind</div>
        <MachineKind client={client} env={env} onChanged={onRenamed} />

        <div className="section">public links</div>
        <PublicLinks client={client} env={env} />

        <div className="section">CLI accounts</div>
        {accounts === null && !error && <div className="empty quiet">looking for agents…</div>}
        {accounts?.length === 0 && <div className="empty quiet">no agents on {env.name}</div>}
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
        <p className="note">
          The checked models are what the model picker offers; everything else
          stays one tap away under “more”. Start defaults apply from every
          paired device.
        </p>
        {error && <div className="error">{error}</div>}
      </div></div>
    </>
  );
}

/**
 * The model prefs editor for one account: a checklist over the CLI's full
 * list - long for opencode, so it filters - plus the model new sessions
 * start with. Checking nothing means "offer everything", the state the
 * account was in before this screen existed.
 */
export function ModelPrefsView({ client, env, account, onBack }: {
  client: Client; env: Environment; account: Account; onBack: () => void;
}) {
  const [list, setList] = useState<ModelList | null>(null);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [def, setDef] = useState('');
  // On unless the owner switched it off; an older machine says nothing, and acts as on.
  const [auto, setAuto] = useState(true);
  const [news, setNews] = useState<ModelNote[]>([]);
  const [effort, setEffort] = useState(account.defaults?.effort ?? '');
  const [mode, setMode] = useState(account.defaults?.mode === 'plan' ? '' : account.defaults?.mode ?? '');
  const [speed, setSpeed] = useState(account.defaults?.speed ?? '');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const eng = engineOf(account.engine);

  useEffect(() => {
    let stale = false;
    let initialized = false;
    const take = (r: ModelList, remembered?: boolean) => {
      if (stale) return;
      setList(r);
      if (!initialized) {
        setApproved(new Set(r.prefs?.approved ?? []));
        setDef(r.prefs?.default ?? '');
        setAuto(r.auto !== false);
        setNews(r.news ?? []);
      }
      if (!remembered) initialized = true;
      if (!remembered) saveModels(env.id, account.profile.id, r, true);
    };
    // Paint the catalogue this device already knows - the whole list, which is
    // the slowest thing the app asks for - and let the real answer replace it.
    loadModels(env.id, account.profile.id, true).then((c) => { if (c && !initialized) take(c, true); });
    const catalog = followModelRefresh(
      () => client.rpc<ModelList>(env.id, 'model.list', { profileId: account.profile.id, all: true }, 45_000),
      (r) => take(r),
      (e) => { if (!list) setError(e instanceof Error ? e.message : String(e)); },
    );
    return () => { stale = true; catalog.stop(); };
  }, [client, env.id, account.profile.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (m: string) => {
    const next = new Set(approved);
    if (next.has(m)) next.delete(m); else next.add(m);
    // A default has to be something the picker offers - unless the picker
    // offers everything, which is what an empty list means.
    if (def && next.size && !next.has(def)) setDef('');
    setApproved(next);
  };

  const save = async () => {
    setBusy(true); setError('');
    try {
      await Promise.all([
        client.rpc(env.id, 'model.prefs', {
          profileId: account.profile.id,
          default: def || null,
          approved: [...approved],
          auto,
        }, 20_000),
        client.rpc(env.id, 'profile.defaults', {
          profileId: account.profile.id,
          effort: efforts.includes(effort) ? effort : null,
          mode: mode || null,
          speed: speed || null,
        }, 20_000),
      ]);
      onBack();
    } catch (e: any) { setError(e.message); setBusy(false); }
  };

  const all = list?.models ?? [];
  const q = query.trim().toLowerCase();
  const match = (m: string) =>
    !q || m.toLowerCase().includes(q) || (list?.labels?.[m] ?? '').toLowerCase().includes(q);
  // Approved first in the CLI's own order, including any the CLI no longer
  // offers (kept visible so a stale entry can be unchecked, not hidden).
  const on = [...all.filter((m) => approved.has(m)), ...[...approved].filter((m) => !all.includes(m))]
    .filter(match);
  const off = all.filter((m) => !approved.has(m)).filter(match);
  // Approving nothing leaves the picker whole, so the default may be any
  // model the CLI offers: "start me on the big one" is a setting on its own,
  // and the daemon stores it as one.
  const defaults = approved.size ? all.filter((m) => approved.has(m)) : [...all];
  // A stored default the CLI stopped offering is still what sessions start
  // with - keep it selectable rather than silently dropping it.
  if (def && !defaults.includes(def)) defaults.push(def);
  const selectedModel = def || list?.default || list?.models?.[0] || '';
  const efforts = list?.effortsByModel?.[selectedModel] ?? list?.efforts ?? [];
  useEffect(() => {
    if (list && effort && !efforts.includes(effort)) setEffort('');
  }, [list, selectedModel, effort]);
  const speeds = [...new Set([
    ...(list?.speedByModel?.[selectedModel] ?? list?.speeds ?? []),
    ...(speed ? [speed] : []),
  ])];
  const modes = (list?.modes ?? []).filter((m) => m.id !== 'plan');
  if (mode && mode !== 'plan' && !modes.some((m) => m.id === mode)) modes.push({ id: mode, label: mode });

  const row = (m: string, checked: boolean) => (
    <button key={m} className={`row tall${checked ? ' active' : ''}`} onClick={() => toggle(m)}>
      <span className="grow">
        <span className="rt"><span className="rt-text">{list?.labels?.[m] ?? m}</span></span>
        {(list?.labels?.[m] && list.labels[m] !== m) && <span className="rm">{m}</span>}
        {!all.includes(m) && <span className="rm">not offered by the CLI anymore</span>}
      </span>
      {checked && <span className="check"><Icon name="check" size={16} /></span>}
    </button>
  );

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <div className="titles"><h1>CLI defaults</h1><span className="sub">{eng.label} · {account.account} · {env.name}</span></div>
      </div>
      <div className="scroll"><div className="pad column">
        {list === null && !error && <div className="empty quiet">asking the CLI for its models…</div>}

        {list !== null && (
          <>
            {news.length > 0 && (
              <div className="model-news" role="status">
                <span className="grow">{newsLines(news).map((l) => <span key={l}>{l}</span>)}</span>
                <button onClick={() => {
                  setNews([]);
                  client.rpc(env.id, 'model.news', { profileId: account.profile.id }, 15_000).catch(() => { /* shows once more */ });
                }}>OK</button>
              </div>
            )}
            <div className="section">start new sessions with</div>
            <select value={def} onChange={(e) => setDef(e.target.value)} disabled={!defaults.length}>
              <option value="">the CLI's default</option>
              {defaults.map((m) => <option key={m} value={m}>{list.labels?.[m] ?? m}</option>)}
            </select>
            {efforts.length > 0 && (
              <label className="field-label">Thinking
                <select value={effort} onChange={(e) => setEffort(e.target.value)}>
                  <option value="">the CLI's default</option>
                  {efforts.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </label>
            )}
            {modes.length > 0 && (
              <label className="field-label">Permissions
                <select value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="">YOLO (default)</option>
                  {modes.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                </select>
              </label>
            )}
            {speeds.length > 0 && (
              <label className="field-label">Speed
                <select value={speed} onChange={(e) => setSpeed(e.target.value)}>
                  <option value="">normal</option>
                  {speeds.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </label>
            )}

            <div className="section">in the picker</div>
            <input
              value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder={`filter ${all.length} models`} autoCapitalize="off" autoCorrect="off"
            />
            {on.length > 0 && <div className="rows">{on.map((m) => row(m, true))}</div>}
            {on.length > 0 && off.length > 0 && <div className="section">everything else</div>}
            <div className="rows">{off.map((m) => row(m, false))}</div>
            {q && !on.length && !off.length && <div className="empty quiet">no matches</div>}

            <div className="section">new models</div>
            <div className="rows">
              <button className="row tall toggle" role="switch" aria-checked={auto} onClick={() => setAuto(!auto)}>
                <span className="grow">
                  <span className="rt">Add new models automatically</span>
                  <span className="rm wrap">A new release joins the short list. If your default was the newest of its kind, it moves up too.</span>
                </span>
                <span className={`switch${auto ? ' on' : ''}`}><i /></span>
              </button>
            </div>

            <p className="note">
              Checked models are the picker's short list; the rest stay reachable
              under “more”. Check nothing to offer the whole list.
            </p>
            <button className="primary big" disabled={busy} onClick={save}>
              {busy ? 'saving…' : 'Save'}
            </button>
          </>
        )}
        {error && <div className="error">{error}</div>}
      </div></div>
    </>
  );
}

// ----------------------------------------------------------------- browsing

function Browse({ client, env, path, title = 'Where?', action = 'Start here', onBack, onInto, onPick, onQuick, sendFiles = false, onSend }: {
  client: Client; env: Environment; path?: string; title?: string; action?: string; sendFiles?: boolean; onSend?: (path: string) => void;
  onBack: () => void; onInto: (p: string) => void; onPick: (p: string) => void | Promise<void>;
  /** Offered on the way in: a chat that needs no folder at all. */
  onQuick?: () => void;
}) {
  // What this device already knows is inside shows at once; the machine's
  // own answer replaces it when it lands.
  const [entries, setEntries] = useState<DirEntry[]>(() => knownInside(env.id, path ?? '~') ?? []);
  const [loading, setLoading] = useState(() => !knownInside(env.id, path ?? '~'));
  const [sendPath, setSendPath] = useState('');
  const [here, setHere] = useState(path ?? '~');
  const [error, setError] = useState('');
  const [picking, setPicking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [folder, setFolder] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<{ name: string; path: string; repo: boolean }[] | null>(null);
  const [indexed, setIndexed] = useState(0);

  // The folders a session last started in on this machine: a real project
  // is usually nested a few levels under home, and remembering the last few
  // turns "open it again" into one tap instead of five. Three stay on top:
  // enough to cover "the one I was just in" without becoming a second list.
  const [recent] = useState<string[]>(() => recentFolders(env.id));
  const pick = async (p: string) => {
    rememberFolder(env.id, p);
    setError(''); setPicking(true);
    try { await onPick(p); }
    catch (e: any) { setError(e.message); }
    finally { setPicking(false); }
  };

  const load = useCallback(() => {
    setError('');
    const known = knownInside(env.id, path ?? '~');
    if (known) setEntries(known);
    setLoading(!known);
    let answered = false;
    // The folder list this device keeps may still be on its way from storage.
    if (!known) void loadFolders(env.id).then(() => {
      const held = knownInside(env.id, path ?? '~');
      if (held && !answered) { setEntries(held); setLoading(false); }
    });
    listFolder(client, env.id, path ?? '~')
      .then((r) => { answered = true; setEntries(r.entries); setHere(r.path); })
      .catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [client, env.id, path, sendFiles]);

  useEffect(() => { load(); }, [load]);
  // The agent step comes next; ask for its list while the folder is chosen.
  useEffect(() => { if (!sendFiles) prefetchAccounts(client, env.id); }, [client, env.id, sendFiles]);

  // The machine indexes its folders once, so a query answered from memory
  // costs a debounce and a round trip rather than a disk walk per letter.
  const q = query.trim();
  useEffect(() => {
    if (!q) { setHits(null); return; }
    setHits(null);
    let stale = false;
    const t = setTimeout(() => {
      client.rpc(env.id, 'fs.search', { query: q }, 20_000)
        .then((r: any) => { if (!stale) { setHits(r.results ?? []); setIndexed(r.indexed ?? 0); } })
        .catch((e) => { if (!stale) { setHits([]); setError(e.message); } });
    }, 250);
    return () => { stale = true; clearTimeout(t); };
  }, [q, client, env.id]);

  const makeFolder = async () => {
    const name = folder.trim();
    if (!name) return;
    try {
      await client.rpc(env.id, 'fs.mkdir', { path: here, name });
      setFolder(''); setCreating(false); load();
    } catch (e: any) { setError(e.message); }
  };

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <div className="titles"><h1>{title}</h1><span className="sub"><Route machine={env.name} folder={here} full /></span></div>
      </div>
      <div className="scroll"><div className="pad column">
        <button className="primary big" disabled={picking || loading || !!error} onClick={() => pick(here)}>
          {picking ? 'working…' : loading ? 'Loading folders…' : action}
        </button>

        {sendFiles && <details className="send-details"><summary>Use a file or folder path</summary>
          <div className="inline-form"><input aria-label="File or folder on this machine" placeholder={`${here}/name`} value={sendPath}
            autoCapitalize="off" autoCorrect="off" onChange={event => setSendPath(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && sendPath.trim()) void pick(sendPath.trim()); }} />
            <button className="linkish" disabled={picking || !sendPath.trim()} onClick={() => void pick(sendPath.trim())}>Use this path</button></div>
        </details>}
        {onSend && <button className="linkish" disabled={loading || !!error} onClick={() => onSend(here)}>Send this folder</button>}
        <div className="filterbar">
          <input
            className="sheetfilter grow" value={query}
            placeholder={`search folders on ${env.name}`}
            autoCapitalize="off" autoCorrect="off" autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {q ? (
          <div className="rows">
            {(hits ?? []).map((h) => (
              <button key={h.path} className="row" onClick={() => pick(h.path)}>
                <span className={`glyph${h.repo ? ' repo' : ''}`}><Icon name={h.repo ? 'repo' : 'folder'} size={16} /></span>
                <span className="grow">
                  <span className="rt"><span className="rt-text">{h.name}</span></span>
                  <span className="rm">{h.path}</span>
                </span>
                <span className="chev"><Icon name="forward" size={15} /></span>
              </button>
            ))}
            {hits === null
              ? <div className="empty quiet">searching…</div>
              : !hits.length && <div className="empty quiet">nothing matches{indexed ? ` · ${indexed} folders indexed` : ''}</div>}
          </div>
        ) : (
          <>
            {!path && onQuick && (
              <div className="rows">
                <button className="row" onClick={onQuick}>
                  <span className="glyph"><Icon name="bolt" size={16} /></span>
                  <span className="grow">
                    <span className="rt"><span className="rt-text">No folder · quick chat</span></span>
                    <span className="rm">a small question, in no folder</span>
                  </span>
                  <span className="chev"><Icon name="forward" size={15} /></span>
                </button>
              </div>
            )}
            {/* Only on the way in: once you are browsing, the list on screen
                already says where you are. */}
            {!path && recent.length > 0 && (
              <>
                <div className="section">recent</div>
                <div className="rows">
                  {recent.slice(0, 3).map((p) => (
                    <button key={p} className="row" onClick={() => pick(p)}>
                      <span className="glyph repo"><Icon name="folder" size={16} /></span>
                      <span className="grow">
                        <span className="rt"><span className="rt-text">{shortPath(p)}</span></span>
                        <span className="rm">{p}</span>
                      </span>
                      <span className="chev"><Icon name="forward" size={15} /></span>
                    </button>
                  ))}
                </div>
              </>
            )}

            <div className="section">
              folders<span className="spacer" />
              {!sendFiles && <button className="linkish" onClick={() => setCreating((v) => !v)}>
                {creating ? 'Cancel' : 'New folder'}
              </button>}
            </div>

            {creating && (
              <div className="inline-form">
                <input
                  autoFocus value={folder} placeholder="folder name"
                  onChange={(e) => setFolder(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') makeFolder(); }}
                />
                <button className="send" onClick={makeFolder} disabled={!folder.trim()} aria-label="create folder" title="create folder"><Icon name="arrow-up" size={16} /></button>
              </div>
            )}

            <div className="rows">
              {entries.map((e) => sendFiles ? (
                <div key={e.path} className="row rowx">
                  <button className="rowmain" onClick={() => pick(e.path)}>
                    <span className={`glyph${e.isRepo ? ' repo' : ''}`}><Icon name={e.isRepo ? 'repo' : 'folder'} size={16} /></span>
                    <span className="grow"><span className="rt"><span className="rt-text">{e.name}</span></span></span>
                  </button>
                  <button className="rowend" aria-label={`Browse ${e.name}`} onClick={() => onInto(e.path)}><Icon name="forward" size={15} /></button>
                </div>
              ) : (
                <button key={e.path} className="row" onClick={() => onInto(e.path)}>
                  <span className={`glyph${e.isRepo ? ' repo' : ''}`}><Icon name={e.isRepo ? 'repo' : 'folder'} size={16} /></span>
                  <span className="grow"><span className="rt"><span className="rt-text">{e.name}</span></span></span>
                  <span className="chev"><Icon name="forward" size={15} /></span>
                </button>
              ))}
              {loading ? <div className="empty quiet" role="status">Loading folders…</div> : !entries.length && !error && <div className="empty quiet">no subfolders</div>}
            </div>
          </>
        )}
        {error && <><div className="error">{error}</div><button className="linkish" onClick={load}>Retry</button></>}
      </div></div>
    </>
  );
}

// -------------------------------------------------------------------- media

/**
 * What a machine designated 'nas' shares: the folders it was given, browsed
 * and played where they lie.
 *
 * Listing is ordinary RPC - small JSON, made for this channel. Playback is
 * not: a media element speaks real HTTP and cannot set an Authorization
 * header, so the screen mints a short-lived ticket and hands the element a
 * URL to fetch itself. The URL prefers the machine's own hub - the direct
 * path on the same network - and retries through the hub this page is
 * attached to, which proxies the same stream when the direct one cannot be
 * reached. The bytes never touch the JSON socket either way.
 */
function MediaView({ client, env, onBack }: {
  client: Client; env: Environment; onBack: () => void;
}) {
  const [roots, setRoots] = useState<MediaRoot[] | null>(null);
  const [root, setRoot] = useState<MediaRoot | null>(null);
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<MediaEntry[] | null>(null);
  const [playing, setPlaying] = useState<{ entry: MediaEntry; url: string } | null>(null);
  const [error, setError] = useState('');
  // The minted credential, kept so the relayed retry can reuse it.
  const ticket = useRef<{ value: string; relayed: boolean } | null>(null);

  useEffect(() => {
    client.mediaRoots(env.id)
      .then((r) => setRoots(r.roots))
      .catch((e: any) => setError(e.message));
  }, [client, env.id]);

  useEffect(() => {
    if (!root) return;
    setEntries(null);
    setError('');
    client.mediaList(env.id, root.id, path)
      .then((r) => setEntries(r.entries))
      .catch((e: any) => setError(e.message));
  }, [client, env.id, root, path]);

  const play = async (entry: MediaEntry) => {
    if (!root) return;
    setError('');
    try {
      const t = await client.mediaTicket(env.id);
      ticket.current = { value: t.ticket, relayed: false };
      setPlaying({
        entry,
        url: client.mediaStreamUrl(env, { root: root.id, path: entry.path, ticket: t.ticket }),
      });
    } catch (e: any) { setError(e.message); }
  };

  /**
   * A media error is ambiguous: the direct address may be unreachable from
   * here (different network), or the browser may simply not decode the file.
   * The first failure retries the same file through the attached hub - cheap
   * and usually the answer - and only the second says unplayable.
   */
  const unplayable = () => {
    const t = ticket.current;
    if (playing && root && t && !t.relayed) {
      t.relayed = true;
      setPlaying({
        entry: playing.entry,
        url: client.mediaStreamUrl(env,
          { root: root.id, path: playing.entry.path, ticket: t.value },
          { direct: false }),
      });
    } else {
      setError(`this browser cannot play ${playing?.entry.name ?? 'that file'}`);
    }
  };

  const crumbs = [root?.name, ...(path ? path.split('/') : [])].filter(Boolean).join(' / ');
  const backTo = playing ? () => setPlaying(null)
    : root ? () => { setRoot(null); setPath(''); }
    : onBack;

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={backTo}><BackIcon /></button>
        <div className="titles">
          <h1>{playing ? playing.entry.name : env.name}</h1>
          <span className="sub">{playing ? 'playing' : crumbs || 'media'}</span>
        </div>
      </div>

      <div className="scroll"><div className="pad column">
        {playing ? (
          <>
            <div className="player">
              {playing.entry.mime?.startsWith('audio/') ? (
                <audio controls autoPlay src={playing.url} onError={unplayable} />
              ) : (
                <video controls autoPlay playsInline src={playing.url} onError={unplayable} />
              )}
            </div>
            <div className="quiet media-meta">
              {playing.entry.path}
              {playing.entry.size != null && ` · ${bytes(playing.entry.size)}`}
            </div>
          </>
        ) : !root ? (
          <div className="rows">
            {(roots ?? []).map((r) => (
              <button key={r.id} className="row" onClick={() => { setRoot(r); setPath(''); }}>
                <span className="glyph repo"><Icon name="folder" size={16} /></span>
                <span className="grow">
                  <span className="rt"><span className="rt-text">{r.name}</span></span>
                  <span className="rm">{r.path}</span>
                </span>
                <span className="chev"><Icon name="forward" size={15} /></span>
              </button>
            ))}
            {roots === null
              ? <div className="empty quiet">asking {env.name}…</div>
              : !roots.length && !error && (
                <div className="empty quiet">
                  nothing shared yet — on {env.name}: helm nas add ~/Movies
                </div>
              )}
          </div>
        ) : (
          <div className="rows">
            {path && (
              <button className="row" onClick={() => setPath(path.split('/').slice(0, -1).join('/'))}>
                <span className="glyph"><Icon name="back" size={16} /></span>
                <span className="grow"><span className="rt">up a folder</span></span>
              </button>
            )}
            {(entries ?? []).map((e) => (
              <button
                key={e.path}
                className={`row${e.dir || e.media ? '' : ' quiet'}`}
                disabled={!e.dir && !e.media}
                onClick={() => (e.dir ? setPath(e.path) : play(e))}
              >
                <span className={`glyph${e.dir ? ' repo' : ''}`}>{e.dir ? <Icon name="folder" size={16} /> : e.media ? <Play /> : '·'}</span>
                <span className="grow">
                  <span className="rt"><span className="rt-text">{e.name}</span></span>
                  {!e.dir && e.size != null && <span className="rm">{bytes(e.size)}</span>}
                </span>
                {e.dir && <span className="chev"><Icon name="forward" size={15} /></span>}
              </button>
            ))}
            {entries === null && !error && <div className="empty quiet">listing…</div>}
            {entries?.length === 0 && <div className="empty quiet">empty</div>}
          </div>
        )}
        {error && <div className="error">{error}</div>}
      </div></div>
    </>
  );
}

// ------------------------------------------------------------------ session

function SessionView({ client, env, machines, session, terminals = [], onSwitch, onNewTerminal, onBack, onClosed, onArchived, onSession, onTranscribe, onSendTask, onSendFolder, onOpenNative }: {
  client: Client; env: Environment; session: Session;
  /** Every machine, for settings that belong to the account. */
  machines?: Environment[];
  onSendTask?: () => void; onSendFolder?: () => void;
  onOpenNative?: (agent: NativeAgent) => void;
  /** This machine's open terminals, for the tabs above one. */
  terminals?: Session[];
  onSwitch?: (s: Session) => void;
  onNewTerminal?: () => Promise<void>;
  onBack: () => void; onClosed: () => void; onArchived: () => void; onSession: (s: Session) => void;
  /** Absent when no machine in the network holds a Groq key. */
  onTranscribe?: Transcribe;
}) {
  const isShell = session.engine === 'shell';
  const isExternal = !!session.external;
  const readVisual = useCallback((ref: string) => client.rpc<{ html: string }>(env.id, 'session.visual', { id: session.id, ref }, 60_000), [client, env.id, session.id]);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [readError, setReadError] = useState('');
  const reading = useRef(false), readAgain = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [raw, setRaw] = useState(isShell || !!session.nativeCli && !session.nativeChat && !nativeConversation(session.engine));
  const [agentsOpen, setAgentsOpen] = useState(false);
  const browser = useBrowserDock(client, env, session, !isShell);
  const [status, setStatus] = useState(session.status);
  const [compacting, setCompacting] = useState(session.compacting || false);
  // When it entered the status it is in, for "working 14m" beside the word.
  const [statusAt, setStatusAt] = useState(session.updatedAt);
  const [draft, setDraft] = useState(() => loadDraft(env.id, session.id));
  useEffect(() => saveDraft(env.id, session.id, draft), [env.id, session.id, draft]);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState(false);
  useDismiss(menu, useCallback(() => setMenu(false), []));
  const eng = engineOf(session.engine);

  const [nativeOptions, setNativeOptions] = useState<ModelList | null>(null);
  const [nativeCommands, setNativeCommands] = useState<{ name: string; description?: string; source?: string }[]>([]);
  const [settingBusy, setSettingBusy] = useState(false);
  const [nativeNotice, setNativeNotice] = useState('');
  useEffect(() => {
    setNativeOptions(null); setNativeCommands([]);
    if (!session.nativeCli) return;
    let stale = false;
    const catalog = followModelRefresh(
      () => client.rpc<ModelList>(env.id, 'model.list', { id: session.id, profileId: session.profileId }, 30_000),
      (options) => {
        // The same tray a Helm chat has. `default` and `effort` stay empty:
        // the chips show what Claude itself reports, never an account guess.
        if (!stale && Array.isArray(options.models)) setNativeOptions({ ...options, default: null, effort: null, speeds: [], speedByModel: {} });
      },
      () => {},
    );
    const loadCommands = () => client.rpc<{ commands: typeof nativeCommands }>(env.id, 'session.commands', { id: session.id }, 20_000)
      .then((result) => { if (!stale) setNativeCommands(result.commands ?? []); }).catch(() => {});
    void loadCommands();
    const off = client.on((machine, kind, payload) => {
      if ((kind === 'connection' && payload?.online) || (machine === env.id && kind === 'presence' && payload?.online)) {
        void catalog.refresh(); void loadCommands();
      }
    });
    return () => { stale = true; catalog.stop(); off(); };
  }, [client, env.id, session.id, session.profileId, session.nativeCli, session.engineModel, session.permissionControl]);

  const nativeCommand = async (command: string) => {
    if (settingBusy || sending) return;
    setSettingBusy(true); setError('');
    try {
      await client.input(env.id, { id: session.id, data: command });
      setNativeNotice(command);
    } catch (e: any) { setError(e.message); }
    finally { setSettingBusy(false); }
  };
  // A model picked here is checked with Claude first: its PreModelSwitch
  // hook says whether the switch rewrites a warm cache, and only then does
  // Helm ask, with Claude's figures. Helm makes no estimate of its own here.
  const [switchAsk, setSwitchAsk] = useState<{ value: string; warn: string } | null>(null);
  const pickNative = async (kind: Kind, value: string, confirmed = false) => {
    if (settingBusy || sending || kind === 'speed' || status === 'blocked' || !env.online) return;
    setSettingBusy(true); setError('');
    try {
      const check = kind === 'model' && session.nativeChat && session.engine === 'claude' ? { pick: true, ...(confirmed ? {} : { ask: true }) } : {};
      const r = await client.rpc<{ session?: Session; ask?: Recache }>(env.id, `session.${kind}`, { id: session.id, [kind]: value, ...check }, 70_000);
      if (r?.ask) { setSwitchAsk({ value, warn: recacheWarning('model', r.ask, true) }); return; }
      // The machine reads Claude's footer after each shift+tab, so a mode
      // that comes back is one Claude is showing.
      if (kind === 'mode') { if (r?.session) onSession(r.session); }
      // Writing a command is not confirmation that Claude applied it.
      // Keep the reported setting and let the user inspect native output.
      else {
        setNativeNotice(`/${kind} ${value}`);
        if (!session.nativeChat) setRaw(true);
      }
    } catch (e: any) { setError(e.message); }
    finally { setSettingBusy(false); }
  };

  // Read back from the CLI's own transcript, so this chat costs a round trip
  // to say anything at all. Paint the copy on the device first: what you read
  // last time is a better opening than a blank screen, and the refresh behind
  // it is usually a second or two.
  const refresh = useCallback(async (): Promise<void> => {
    if (isShell || !mounted.current) return;
    if (reading.current) { readAgain.current = true; return; }
    reading.current = true;
    let success = false;
    try {
      const r = await client.rpc<{ messages: Message[]; status?: Session['status'] }>(env.id, 'session.messages', { id: session.id }, 15_000);
      if (!mounted.current) return;
      setMessages(r.messages);
      if (r.status) setStatus(r.status);
      setReadError(''); success = true;
      saveMessages(env.id, session.id, r.messages);
    } catch (e: any) { if (mounted.current) setReadError(e.message); }
    finally {
      reading.current = false;
      const again = readAgain.current; readAgain.current = false;
      if (success && again && mounted.current) void refresh();
    }
  }, [client, env.id, session.id, isShell]);

  useEffect(() => {
    if (isShell) return;
    let stale = false;
    loadMessages<Message>(env.id, session.id).then((cached) => {
      if (!stale && cached?.length) setMessages((now) => now ?? cached);
    });
    return () => { stale = true; };
  }, [env.id, session.id, isShell]);

  useEffect(() => {
    refresh();
    const off = client.on((e, kind, payload) => {
      if (kind === 'connection' && payload?.online) void refresh();
      if (e !== env.id) return;
      if (kind === 'transport' || (kind === 'presence' && payload?.online)) void refresh();
      if (kind === 'session.transcript' && payload?.id === session.id) refresh();
      if (kind === 'session.update' && payload.session?.id === session.id) {
        setStatus(payload.session.status);
        setCompacting(payload.session.compacting || false);
        setStatusAt(payload.session.updatedAt ?? Date.now());
        refresh();
      }
    });
    const catchUp = () => { if (!document.hidden) void refresh(); };
    window.addEventListener('focus', catchUp);
    window.addEventListener('online', catchUp);
    document.addEventListener('visibilitychange', catchUp);
    return () => {
      off(); window.removeEventListener('focus', catchUp); window.removeEventListener('online', catchUp);
      document.removeEventListener('visibilitychange', catchUp);
    };
  }, [client, env.id, session.id, refresh]);

  // The transcript events above are the live stream; the poll is only the
  // reconciliation for a frame that got lost, so it can be slow - and a
  // transcript whose process is gone cannot change at all.
  useLiveInterval(status === 'exited' ? null : 15_000, refresh, [status, refresh]);

  const [sending, setSending] = useState(false);
  const { images, setImages, loading: loadingImages, saving: savingImages } = useDraftImages<{ name: string; mime: string; data: string; url: string }>(env.id, session.id, setError);
  const [preparingImages, setPreparingImages] = useState(false);
  const imageBusy = useRef(false);
  const attachImages = async (files: FileList | File[]) => {
    if (imageBusy.current || sending || loadingImages || savingImages) return [];
    const picked = Array.from(files);
    if (!picked.length) return [];
    imageBusy.current = true; setPreparingImages(true); setError('');
    const ready: { name: string; mime: string; data: string; url: string }[] = [];
    const failures: string[] = [];
    try {
      for (const file of picked) {
        try { ready.push(await prepareAttachment(file)); }
        catch (e: any) { failures.push(`${file.name}: ${e.message}`); }
      }
      await setImages(current => [...current, ...ready]);
      if (failures.length) setError(`Not added — ${failures.join('; ')}`);
      return ready;
    } finally { imageBusy.current = false; setPreparingImages(false); }
  };
  const questionHandle = useRef<QuestionHandle | null>(null);
  const send = async () => {
    const body = draft;
    const attachments = images;
    if ((!body.trim() && !attachments.length) || sending || settingBusy || imageBusy.current || loadingImages || savingImages) return;
    // While Claude's question is on screen, typing is the answer to it.
    if (questionHandle.current && body.trim() && !attachments.length) {
      if (questionHandle.current.submit(body.trim()) === 'sent') setDraft('');
      return;
    }
    // `/model` on its own opens the model picker, as it does in a Helm chat.
    if (session.nativeCli && /^\/model$/i.test(body.trim()) && !attachments.length && nativeControls.show('model')) {
      setDraft('');
      return;
    }
    setSending(true); setError('');
    try {
      const result = await client.input(env.id, { id: session.id, data: body + '\n',
        ...(attachments.length ? { attachments: attachments.map(image => ({ filename: image.name, mime: image.mime, data: image.data })) } : {}) });
      setDraft(current => current === body ? '' : current);
      await setImages(current => current.filter(image => !attachments.includes(image)));
      if (session.nativeChat && (result?.terminal || body.trimStart().startsWith('/'))) setNativeNotice(body.trim());
      else setMessages((m) => m ? [...m, { role: 'user', text: body, tools: [], at: Date.now(),
        attachments: attachments.map(image => ({ filename: image.name, mime: image.mime, data: image.data })) }] : m);
      setTimeout(refresh, 600);
    } catch (e: any) { setError(e.message); }
    finally { setSending(false); }
  };

  const key = async (k: string) => {
    try { await client.rpc(env.id, 'session.keys', { id: session.id, keys: [k] }); }
    catch (e: any) { setError(e.message); }
  };

  const [killing, setKilling] = useState(false);
  const [naming, setNaming] = useState(false);
  const [opening, setOpening] = useState(false);
  const newTerminal = async () => {
    if (!onNewTerminal) return;
    setOpening(true);
    try { await onNewTerminal(); } catch (e: any) { setError(e.message); } finally { setOpening(false); }
  };

  const stopNative = async () => {
    try { await client.rpc(env.id, 'session.interrupt', { id: session.id }); }
    catch (e: any) { setError(e.message); }
  };

  const kill = async () => {
    try { await client.rpc(env.id, 'session.kill', { id: session.id }); onClosed(); }
    catch (e: any) { setError(e.message); }
  };

  // A terminal's own tab keys, the way a terminal app has them: Ctrl/Cmd+T a
  // new one, Ctrl/Cmd+W closes this one, Ctrl(+Shift)+Tab walks them. Taken
  // before xterm sees them, so the shell's Ctrl+W (delete a word) and Ctrl+T
  // give way here. Only the Helm app window gets these keys; an ordinary
  // browser tab keeps them for itself.
  const terminalKeys = useRef({ newTerminal, kill, terminals, session, onSwitch, opening });
  terminalKeys.current = { newTerminal, kill, terminals, session, onSwitch, opening };
  useEffect(() => {
    if (!isShell) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.isComposing || document.querySelector('[aria-modal="true"]')) return;
      const { newTerminal, kill, terminals, session, onSwitch, opening } = terminalKeys.current;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (event.key === 'Tab' && event.ctrlKey && !event.metaKey) {
        event.preventDefault(); event.stopPropagation();
        const at = terminals.findIndex((t) => t.id === session.id);
        if (terminals.length < 2 || at < 0) return;
        const next = terminals[(at + (event.shiftKey ? -1 : 1) + terminals.length) % terminals.length];
        onSwitch?.(next);
      } else if (mod && !event.shiftKey && key === 't') {
        event.preventDefault(); event.stopPropagation();
        if (!opening) void newTerminal();
      } else if (mod && !event.shiftKey && key === 'w') {
        event.preventDefault(); event.stopPropagation();
        void kill();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isShell]);

  const archive = async () => {
    setMenu(false);
    try { await client.rpc(env.id, 'session.archive', { id: session.id, archived: !session.archived }); onArchived(); }
    catch (e: any) { setError(e.message); }
  };

  // Terminals are named by the machine ("Terminal 3") and agents by their
  // first prompts; both are guesses worth correcting.
  const renameThread = async (next: string) => {
    if (next === session.title) return;
    try {
      const r: any = await client.rpc(env.id, 'session.title', { id: session.id, title: next });
      onSession(r.session);
    } catch (e: any) { setError(e.message); }
  };

  const nativeProfile = nativeOptions?.profileId ?? session.profileId;
  const limits = useAccountLimits(client, env.id, session.engine, nativeProfile);

  const nativePrefs = trayPrefs({ client, env: env.id, engine: session.engine, profileId: nativeOptions?.profileId,
    options: nativeOptions, setOptions: setNativeOptions, setError });
  const openNativeControl = async (kind: NativeControl) => {
    if (settingBusy || sending || status === 'blocked' || status === 'working' || !env.online) return;
    setSettingBusy(true); setError('');
    try {
      await client.rpc(env.id, 'session.control', { id: session.id, kind }, 70_000);
      setRaw(true);
    } catch (e: any) { setError(e.message); }
    finally { setSettingBusy(false); }
  };
  const nativeControls = Controls({ options: nativeOptions, session,
    busy: settingBusy || sending || status === 'blocked' || (!session.nativeChat && status === 'working') || !env.online,
    onPick: pickNative, onNativeControl: openNativeControl, ...nativePrefs });
  // The same keys as a Helm chat, wherever this tray is shown. There is no
  // agents panel here, so that key is left to the browser.
  useChatKeys(session.nativeCli ? {
    effort: () => nativeControls.step('effort'),
    model: () => nativeControls.step('model'),
  } : {});

  useEffect(() => {
    if (!session.nativeChat || raw) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !event.shiftKey || event.ctrlKey || event.metaKey || event.altKey
        || settingBusy || sending || status === 'blocked' || !env.online
        || document.querySelector('[aria-modal="true"]')) return;
      const ring = (nativeOptions?.modes ?? []).filter(mode => mode.id !== 'plan');
      if (ring.length < 2) return;
      event.preventDefault();
      const at = ring.findIndex(mode => mode.id === session.mode);
      void pickNative('mode', ring[(at + 1) % ring.length].id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session.nativeChat, session.mode, raw, nativeOptions, settingBusy, sending, status, env.online]);

  const composer = (ask: { banner?: ReactNode; ask?: 'question' | 'approval' } = {}) => (
    <Composer
      {...ask}
      onTranscribe={onTranscribe}
      draft={draft} setDraft={setDraft} onSend={send} onKey={key}
      // The phone key row is for typing into a plain terminal; an agent chat
      // has its own controls. A terminal Pi stops on Esc (sessions.interrupt).
      keys={isShell} preparing={sending || preparingImages || loadingImages || savingImages}
      commands={session.nativeCli ? nativeCommands : undefined}
      foot={session.nativeCli ? nativeControls.chips : undefined}
      statusLine={nativeProfile || limits.length || session.context ? <LimitsLine windows={limits} account={nativeProfile || undefined} context={session.context && <ContextLimit client={client} env={env} machines={machines} session={session} />} /> : undefined}
      compacting={compacting || undefined}
      onAttach={session.nativeChat ? attachImages : undefined} attachments={images}
      onRemoveAttachment={index => setImages(current => current.filter((_, i) => i !== index))}
      canAttach={!!session.nativeChat}
      onAttachUnsupported={() => setError('This terminal cannot receive images through chat. Open a Claude or Codex chat to attach images.')}
      waiting={status === 'blocked'} engine={eng.label}
      working={status === 'working' || status === 'blocked'}
      onStop={session.nativeCli && session.engine === 'pi' ? stopNative : undefined}
      history={(messages ?? []).filter((message) => message.role === 'user').map((message) => message.text)}
    >
      {nativeControls.sheet}
      {switchAsk && (
        <Confirm
          title="Change it anyway?"
          body={switchAsk.warn}
          confirmLabel="Change" busy={settingBusy}
          onCancel={() => setSwitchAsk(null)}
          onConfirm={() => { const { value } = switchAsk; setSwitchAsk(null); void pickNative('model', value, true); }}
        />
      )}
      {(error || (!messages && readError)) && <div className="error floating" role="alert" onClick={() => setError('')}>{error || readError}</div>}
    </Composer>
  );

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <div className="titles">
          <h1>{session.title}</h1>
          <span className="sub">
            <EngineMark engine={eng.cls} />
            <Route machine={env.name} folder={session.cwd} quick={session.quick} />
            <span className="sep"> · </span>{eng.label}{(session as any).model ? ` · ${(session as any).model}` : ''}
            {!isShell && messages && (readError || !env.online) && <span className="offline" role="status"> · Saved chat · reconnecting…</span>}
          </span>
        </div>
        <StatusChip status={compacting && status === 'working' ? 'compacting' : status} at={statusAt} />
        {!isShell && <button className="iconbtn browser-launch" title="Browser (Ctrl/⌘ Shift B)" aria-label={browser.dot ? 'Browser: the agent opened a tab' : 'Browser'} aria-pressed={browser.open} onClick={browser.toggle}><Icon name="web" size={17} />{browser.dot && <b className="browser-new" aria-hidden="true" />}</button>}
        {!isShell && !isExternal && (
          <button className="iconbtn" title={raw ? 'conversation' : 'terminal'} aria-label={raw ? 'show the conversation' : 'show the terminal'} onClick={() => setRaw((v) => !v)}>
            <Icon name={raw ? 'raw' : 'terminal'} size={18} />
          </button>
        )}
        {/* Claude Code's own subagents, read-only: Helm cannot delegate from a terminal thread. */}
        {!!session.nativeCards?.length && (
          <button className="iconbtn thread-details-launch" aria-label="Agents" title="Claude Code subagents" onClick={() => setAgentsOpen(true)}>
            <Icon name="subagents" size={17} /><b className="cbadge quiet">{session.nativeCards.length}</b>
          </button>
        )}
        {isShell && onNewTerminal && (
          <button className="iconbtn" title="New terminal" aria-label="New terminal" disabled={opening} onClick={() => void newTerminal()}>
            <Icon name="plus" size={18} />
          </button>
        )}
        <button className="iconbtn" title="more" aria-label="more" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}><Icon name="more" size={18} /></button>
        {menu && (isShell ? (
          <div className="menu" onClick={() => setMenu(false)}>
            <button onClick={() => setNaming(true)}>Rename terminal</button>
            {onSendFolder && <button disabled={!env.online} onClick={onSendFolder}>Send folder</button>}
            <button className="destructive" onClick={() => setKilling(true)}>Close terminal</button>
          </div>
        ) : (
          <div className="menu" onClick={() => setMenu(false)}>
            <button onClick={() => setNaming(true)}>Rename thread</button>
            {session.nativeChat && <>
              <button disabled={settingBusy || sending || status === 'blocked' || !env.online} onClick={() => void nativeCommand('/permissions')}>Claude permissions</button>
              <button disabled={settingBusy || sending || status === 'blocked' || !env.online} onClick={() => void nativeCommand('/config')}>Claude settings</button>
            </>}
            {onSendFolder && <button disabled={!env.online} onClick={onSendFolder}>Send folder</button>}
            {!isExternal && onSendTask && <button disabled={!env.online} onClick={onSendTask}>Send task to another machine</button>}
            <button onClick={archive}>{session.archived ? 'Unarchive thread' : 'Archive thread'}</button>
            <button className="destructive" onClick={() => setKilling(true)}>{session.nativeCli ? 'End session' : 'Delete thread'}</button>
          </div>
        ))}
      </div>

      {agentsOpen && <Subagents nativeOnly client={client} env={env} parent={session} onClose={() => setAgentsOpen(false)}
        onOpenNative={onOpenNative ? (agent) => { setAgentsOpen(false); onOpenNative(agent); } : undefined} />}
      {!isShell && browser.open && <BrowserDock client={client} env={env} session={session} onClose={() => browser.setOpen(false)} />}

      {/* Every open terminal on this machine, one tap apart. */}
      {isShell && terminals.length > 1 && (
        <div className="termtabs" role="tablist" aria-label="Open terminals">
          {terminals.map((t) => (
            <button key={t.id} role="tab" aria-selected={t.id === session.id}
              className={t.id === session.id ? 'on' : undefined}
              onClick={() => { if (t.id !== session.id) onSwitch?.(t); }}>
              <Icon name="terminal" size={13} />{t.title}
            </button>
          ))}
        </div>
      )}

      {naming && (
        <TextPrompt
          title={isShell ? 'Name this terminal' : 'Name this thread'} value={session.title}
          onCancel={() => setNaming(false)} onSubmit={renameThread}
        />
      )}
      {killing && (
        <Confirm
          title={isShell ? `Close "${session.title}"?` : session.nativeCli ? `End "${session.title}"?` : `Delete "${session.title}"?`}
          body={isShell
            ? 'Anything still running in it stops.'
            : session.nativeCli ? 'This stops the same CLI running on your laptop. Closing this view leaves it running.' : 'The agent process is closed and the thread is removed from helm.'}
          confirmLabel={isShell ? 'Close' : session.nativeCli ? 'End session' : 'Delete'} danger
          onCancel={() => setKilling(false)}
          onConfirm={() => { setKilling(false); kill(); }}
        />
      )}

      <ExternalSessionNotice session={session}
        onTakeOver={(cancel) => client.rpc(env.id, 'session.takeover', { id: session.id, cancel }, 20_000)} />
      {raw
        ? <Suspense fallback={<div className="xterm-host" />}>
            <Terminal client={client} env={env.id} sessionId={session.id} />
          </Suspense>
        : <Chat messages={messages} status={status} compacting={compacting} readVisual={readVisual} />}

      {session.nativeChat && raw && !session.nativeCli && <NativeClaudeApprovals client={client} env={env.id} sessionId={session.id} />}
      {session.nativeChat && !raw && nativeNotice && (
        <div className="composer-wrap"><div className="composer-col">
          <div className="banner native-command" role="status">
            <span>Sent <code>{nativeNotice}</code> to {eng.label}.</span>
            <button className="ghost" onClick={() => setRaw(true)}>View in terminal</button>
            <button className="iconbtn" aria-label="Dismiss command notice" onClick={() => setNativeNotice('')}><Icon name="close" size={14} /></button>
          </div>
        </div></div>
      )}
      {(!raw || session.nativeCli) && (session.nativeChat
        ? <NativeClaudeApprovals client={client} env={env.id} sessionId={session.id} handle={questionHandle}>{composer}</NativeClaudeApprovals>
        : composer())}
      {raw && !session.nativeCli && error && <div className="error floating" role="alert" onClick={() => setError('')}>{error}</div>}
    </>
  );
}

// --------------------------------------------------------------------- chat

function NativeClaudeApprovals({ client, env, sessionId, handle, children }: {
  client: Client; env: string; sessionId: string;
  /** Where a question banner leaves the way to answer it with what is typed in the composer. */
  handle?: React.MutableRefObject<QuestionHandle | null>;
  /** With a render function the request becomes the top of that composer; without, it stands alone. */
  children?: (ask: { banner?: ReactNode; ask?: 'question' | 'approval' }) => ReactNode;
}) {
  const { log, refresh } = useSessionLog(client, env, sessionId);
  const pending = log.pending[0];
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const answer = async (decision: Decision) => {
    if (!pending) return;
    setBusy(true); setError('');
    try { await client.rpc(env, 'session.answer', { id: sessionId, requestId: pending.requestId, decision }); await refresh(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  const hold = useCallback((h: QuestionHandle | null) => { if (handle) handle.current = h; }, [handle]);
  if (children) {
    return <>{children({
      ask: pending ? (pending.kind === 'question' ? 'question' : 'approval') : undefined,
      banner: pending ? <div className="ask-box">
        <PermissionSheet key={pending.requestId} variant="banner" permission={pending} busy={busy} onAnswer={d => void answer(d)} onHandle={hold} />
        {error && <div className="error" role="alert">{error}</div>}
      </div> : undefined,
    })}</>;
  }
  if (!pending && !error) return null;
  return <div className="composer-wrap"><div className="composer-col">
    {pending && <PermissionSheet key={pending.requestId} permission={pending} busy={busy} onAnswer={d => void answer(d)} />}
    {error && <div className="error" role="alert">{error}</div>}
  </div></div>;
}

function Chat({ messages, status, compacting = false, readVisual }: { messages: Message[] | null; status: string; compacting?: number | boolean; readVisual?: VisualReader }) {
  const box = useRef<HTMLDivElement>(null);
  useCopySelection(box);
  const stuck = useRef(true);
  const [unread, setUnread] = useState(false);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (stuck.current) setUnread(false);
  };
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (stuck.current) el.scrollTop = el.scrollHeight;
    else setUnread(true);
  }, [messages, status]);

  const jump = () => {
    const el = box.current;
    if (el) { el.scrollTop = el.scrollHeight; stuck.current = true; setUnread(false); }
  };

  return (
    <div className="chat-wrap">
      <div className="chat" ref={box} onScroll={onScroll}>
        <div className="timeline">
          {messages === null && <p className="placeholder">Loading the conversation…</p>}
          {messages?.length === 0 && (
            <p className="placeholder">
              {status === 'blocked' || status === 'working'
                ? 'No transcript found for this session yet. The terminal view shows what it is doing.'
                : 'Send a message to start the conversation.'}
            </p>
          )}
          <Visuals.Provider value={readVisual}>{messages?.map((m, i) => <Turn key={m.sourceId ?? i} m={m} />)}</Visuals.Provider>
          {compacting ? <CompactionLine live />
            : status === 'working' && <div className="working"><span className="shine">Working…</span></div>}
        </div>
      </div>
      {unread && <button className="jump" onClick={jump}><Icon name="arrow-down" size={14} />new</button>}
    </div>
  );
}

function Turn({ m }: { m: Message }) {
  if (m.visual) return <div className="turn assistant"><VisualReply visual={m.visual} /></div>;
  if (m.role === 'user') {
    const display = userMessage(m.text, m.attachments);
    return (
      <div className="turn user">
        <div className="bubble">{!!display.attachments?.length && <div className="turn-images">{display.attachments.map((a, i) => a.data
          ? <img key={i} className="turn-image" src={`data:${a.mime};base64,${a.data}`} alt={a.filename} title={`Image #${i + 1}${a.filename ? ` · ${a.filename}` : ''}`} loading="lazy" decoding="async" />
          : <span key={i} className="turn-image-gone"><Icon name="image" size={14} /> {a.filename} — no longer stored</span>
        )}</div>}{display.text}</div>
      </div>
    );
  }
  // Every step folds into one line you can open, whatever the count.
  const kinds = new Map<string, number>();
  for (const t of m.tools) { const k = toolKind(t.name); kinds.set(k, (kinds.get(k) ?? 0) + 1); }
  const word = (k: string, n: number) => k === 'read' ? (n === 1 ? 'Read 1 file' : `Read ${n} files`)
    : k === 'edit' ? (n === 1 ? 'Edited 1 file' : `Edited ${n} files`)
    : k === 'run' ? (n === 1 ? 'Ran 1 command' : `Ran ${n} commands`)
    : k === 'search' ? (n === 1 ? 'Searched' : `Searched ${n} times`)
    : (n === 1 ? 'Used 1 tool' : `Used ${n} tools`);
  const summary = [...kinds].map(([k, n]) => word(k, n)).join(' · ');
  const many = m.tools.length > 1;
  const rows = m.tools.map((t, j) => (
    <div key={j} className="act">
      <span className="aicon"><Icon name={toolKind(t.name)} size={15} /></span>
      <span className="alabel"><b>{t.name}</b>{t.input && <> {t.input}</>}</span>
    </div>
  ));
  return (
    <div className="turn assistant">
      {m.tools.length > 0 && (many
        ? <details className="actgroup"><summary><span className="aicon"><Icon name="tool" size={15} /></span><span className="alabel">{summary}</span><span className="achev"><Icon name="forward" size={13} /></span></summary>{rows}</details>
        : rows)}
      {m.text && <Markdown text={m.text} className="prose" />}
      {!m.text && !m.tools.length && m.thinking && <div className="act"><span className="aicon"><Icon name="think" size={15} /></span><span className="alabel">Thinking</span></div>}
    </div>
  );
}
