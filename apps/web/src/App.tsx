import { groqDirect, keepVoice, keptVoice, toBase64, type DirectVoice } from './session/voice';
import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react';
import { Confirm } from './Modal';
import { useNow } from './useNow';
import { isUnread, markSeen, seenHere, useSeenVersion } from './threadStatus';
import { Palette, ShortcutsHelp, type PaletteItem } from './Palette';
import { NewChat } from './NewChat';
import type { Account } from './accounts';
import { loadAppearance, saveAppearance, type Theme } from './appearance';
import { DrivenSession } from './session/DrivenSession';
import { NativeAgentView } from './session/NativeAgentView';
import { StartingChatView } from './session/StartingChatView';
import { beginChat, forgetChat, onStartingChat, type StartingChat } from './startingChats';
import { EngineMark } from './EngineMark';
import { NotificationToast } from './NotificationToast';
import { MachineUpdateNotice } from './MachineUpdateNotice';
import { sending, useSends } from './send/store';
import { SendActivity, SendNotice } from './send/SendActivity';
import { BackIcon, Icon } from './Icon';
import { loadAuthSync, loadAuthDurable, saveAuth, clearAuth } from './store';
import { loadBrains, saveBrain, forgetBrain, type RememberedBrain } from './brainStore';
import { brainHost } from '@helm/protocol/brain-host';
import { Client, LOOPBACK_HOST, type Environment, type Session, type Project, type NativeAgent } from './client';
import { busyWord, needsAttention, runningThread, settledThread, unknownThread, listedThread } from './format';
import { loadWorkspace, loadWorkspaceDurable, saveWorkspace, updateWorkspaceSession, forgetWorkspace, workspaceScope } from './workspaceCache';
import { engineOf } from './engines';
import { useLiveInterval } from './useLiveInterval';
import { useViewingReport } from './useViewingReport';
import { ownTerminal, byRecent, ago } from './screens/common';
import { Gear } from './screens/icons';
import { whereOf, HomeRow, StatusChip, Fold, NeedCard, NEVER_SNOOZE, when, PagedRows, SETTLED_FIRST, SETTLED_STEP } from './screens/ThreadRows';
import { shareHopTarget, ShareHop } from './screens/ShareHop';
import { type Auth, Login } from './screens/Login';
import { DevicesView } from './screens/Devices';
import { EnvView } from './screens/EnvView';
import { BrainView } from './screens/Brain';
import { EnvSettings } from './screens/MachineSettings';
import { SettingsView, LinksView, NetworkSettings } from './screens/Settings';
import { ModelPrefsView } from './screens/ModelPrefs';
import { Browse } from './screens/Browse';
import { MediaView } from './screens/Media';
import { Start } from './screens/Start';
import { SessionView } from './session/SessionView';

// Tests import the model list editor from here, where it used to live.
export { ModelPrefsView };

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

const UsageView = lazy(() => import('./Usage').then((m) => ({ default: m.UsageView })));
const UpdatesView = lazy(() => import('./Updates').then((m) => ({ default: m.UpdatesView })));
const IntegrationsView = lazy(() => import('./Integrations').then((m) => ({ default: m.IntegrationsView })));
const TransferView = lazy(() => import('./Transfer').then((m) => ({ default: m.TransferView })));
const VerifyView = lazy(() => import('./Transfer').then((m) => ({ default: m.VerifyView })));

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

export type MainView =
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
  const [newChat, setNewChat] = useState<{ envId?: string; folder?: string; quick?: boolean; draft?: string } | null>(null);
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

  // Keys, on a keyboard. Every one needs Ctrl/Cmd - never a bare key, which
  // the owner hit by accident. Ctrl/Cmd+K opens the palette; Ctrl/Cmd+N
  // starts a new chat. In an ordinary browser tab the browser keeps Ctrl+N,
  // so Ctrl/Cmd+Shift+O does the same there. Ctrl/Cmd+[ and ] walk back and
  // forward; Ctrl/Cmd+/ lists them. A phone never sends any of them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); setPalette((v) => !v); return; }
      // The key list. Every shortcut needs Ctrl/Cmd (the owner's rule); with
      // Shift held, some layouts report "/" as "?".
      if (mod && !e.altKey && (e.key === '/' || e.key === '?') && !el?.closest?.('.xterm')) { e.preventDefault(); setPalette(false); setHelp((v) => !v); return; }
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

  // The sidebar's ⋯: the machine screen's three, plus carrying on. The list
  // is reloaded either way, so a row that would not go stays and says so.
  const threadActions = (e: Environment, s: Session) => {
    const act = async (method: string, params: object) => {
      try { await client.rpc(e.id, method, params, 20_000); }
      catch (err: any) { console.error(`${method} failed on ${e.name}: ${err.message}`); }
      loadSessions(e.id);
    };
    // A finished chat carries on in a fresh one: no handoff file, the new
    // agent reads where this one stopped with `helm pickup` (pickup.js).
    const done = !s.adopted && !s.quick && !!s.cwd && !s.id.startsWith('found:') && !['working', 'blocked'].includes(s.status);
    return {
      onContinue: done ? () => setNewChat({ envId: e.id, folder: s.cwd,
        draft: `Continue the work of the chat "${s.title}". Run \`helm pickup ${s.id}\` first.` }) : undefined,
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

  useViewingReport(client, view, selected);

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
                No machine answers. Check the VM and this device's internet.
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
            {/* The rows below show each machine and its dot; the readout
                only says what is running and what waits for the owner. */}
            {(runningCount > 0 || blocked.length > 0) && <p className="readout">
              {runningCount > 0 && `${runningCount} running`}
              {runningCount > 0 && blocked.length > 0 && ' · '}
              {blocked.length > 0 && <span className="attention">{blocked.length} {blocked.length === 1 ? 'needs' : 'need'} you</span>}
            </p>}
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
          onStarting={(info, run) => { const chat = beginChat(client, info, run, newChat.draft); navigate([{ kind: 'env' }, { kind: 'starting', startId: chat.id }], info.envId); }}
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
