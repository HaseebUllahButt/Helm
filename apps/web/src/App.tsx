import { useCallback, useEffect, useRef, useState, lazy, Suspense, type FormEvent, type ReactNode } from 'react';
import { Confirm, TextPrompt } from './Modal';
import { useNow, waitingSince } from './useNow';
import { Markdown } from './Markdown';
import { Composer } from './session/Composer';
import { DrivenSession } from './session/DrivenSession';
import { EngineMark } from './EngineMark';
import { UsageView } from './Usage';
import { loadAuthSync, loadAuthDurable, saveAuth, clearAuth, type StoredAuth } from './store';
import { loadBrains, saveBrain, forgetBrain, type RememberedBrain } from './brainStore';
import {
  Client, login, validMachineName, MACHINE_NAME_RULE,
  type Environment, type Profile, type Session, type DirEntry, type Message, type ModelList, type ModelPrefs,
  type InventorySession, type Device, type Project,
} from './client';
import { money } from './format';
import { loadModels, saveModels } from './modelCache';
import { loadMessages, saveMessages } from './session/logCache';

type Auth = StoredAuth;
type PairingTarget = { endpoint: string; password: string };

/**
 * Pairing secrets live in the URL fragment. Browsers never send the fragment
 * to the server, so opening a link can be one tap without putting the secret
 * in Caddy, tunnel or browser request logs.
 */
function pairingTarget(value: string): PairingTarget | null {
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const fragment = url.hash.replace(/^#\/?/, '');
    const password = new URLSearchParams(fragment).get('pair') || '';
    return { endpoint: url.origin, password };
  } catch {
    return null;
  }
}

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

// ------------------------------------------------------------------ engines

// The badge itself is EngineMark; this is what an engine is called.
const ENGINE: Record<string, { label: string; cls: string }> = {
  claude:   { label: 'Claude Code', cls: 'claude' },
  codex:    { label: 'Codex',       cls: 'codex' },
  opencode: { label: 'opencode',    cls: 'opencode' },
  devin:    { label: 'Devin',       cls: 'devin' },
  shell:    { label: 'Terminal',    cls: 'shell' },
};
/**
 * xterm is a third of this app's JavaScript and matters only once a terminal
 * is open, so it is fetched then rather than on every cold start. The wait is
 * hidden behind the round trip that opens the pty anyway.
 */
const Terminal = lazy(() => import('./Terminal').then((m) => ({ default: m.Terminal })));

const engineOf = (id?: string) => ENGINE[id ?? ''] ?? { label: id ?? 'agent', cls: 'other' };

/**
 * Settings, drawn rather than typed. `⚙` is U+2699, which most systems render
 * from the emoji font - so the quietest button on the bar came out as a
 * full-colour cyan gear, the brightest thing on the screen.
 */
const Meter = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <path d="M5 20V10M12 20V5M19 20v-7" />
  </svg>
);

const Sliders = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2.2" /><circle cx="10" cy="17" r="2.2" />
  </svg>
);

/**
 * An account is a CLI plus the home directory (or credential) it runs with.
 * A shell full of aliases yields the same account many times over, each with
 * different flags - `d`, `codexp`, `codexpx` are all "Codex, personal". The
 * flags are choices to make when starting, not separate things to pick from,
 * so collapse the aliases to accounts and keep the plainest alias of each as
 * the one to launch.
 */
interface Account {
  key: string;
  engine: string;
  account: string;
  token: boolean;
  profile: Profile;
  aliases: string[];
  prefs?: ModelPrefs | null;
  defaults?: { effort?: string; mode?: string; speed?: string } | null;
}

function accountsFrom(profiles: Profile[]): Account[] {
  const by = new Map<string, Account>();
  for (const p of profiles) {
    if (p.engine === 'shell' || (p as any).disabled) continue;
    const home = Object.values(p.env ?? {}).find((v) => /^[~/]/.test(v));
    // Engine + home + credential is what makes an account; an alias that
    // also unsets a variable is the same account with a different mood. The
    // daemon computes the same key, which is what its model prefs index by.
    const key = p.account ?? [p.engine, home ?? '', [...(p.envFrom ?? [])].sort().join(',')].join('|');
    const leaf = home?.split('/').pop() ?? '';
    const suffix = leaf.replace(/^\.?(claude|codex|opencode|devin|config)-?/, '');
    const existing = by.get(key);
    if (existing) {
      existing.aliases.push(p.id);
      existing.prefs ??= p.prefs;
      existing.defaults ??= p.defaults;
      // Fewest arguments = the plainest way to launch this account.
      if ((p.args ?? []).length < (existing.profile.args ?? []).length) existing.profile = p;
      continue;
    }
    by.set(key, {
      key, engine: p.engine,
      account: suffix || 'default',
      token: (p.envFrom ?? []).some((k) => /TOKEN|KEY/i.test(k)),
      profile: p, aliases: [p.id], prefs: p.prefs, defaults: p.defaults,
    });
  }
  const order = ['claude', 'codex', 'opencode', 'devin'];
  return [...by.values()].sort((a, b) =>
    (order.indexOf(a.engine) - order.indexOf(b.engine)) || a.account.localeCompare(b.account));
}

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

const shortPath = (p: string) => {
  const parts = p.replace(/\/$/, '').split('/');
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : p;
};

const byRecent = (a: Session, b: Session) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);

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
  s.alive === true || s.status === 'blocked' || s.status === 'working' ||
  (s.updatedAt ?? 0) >= Date.now() - WEEK;

/** `~/x` on the machine and `/home/u/x` on the wire are the same folder. */
const collapseCwd = (p: string) => p.replace(/^\/home\/[^/]+/, '~');

const sameDir = (a: string, b: string) => collapseCwd(a) === collapseCwd(b);

/** An inventory row wearing the shape a session row draws: external, dead. */
const foundRow = (x: InventorySession): Session => ({
  id: `found:${x.engine}:${x.id}`,
  title: x.title, cwd: x.cwd, engine: x.engine,
  profileId: '', status: 'idle', adopted: true, alive: false,
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
 * engineSessionId is the CLI's id), or the history file of an agent that is
 * live right now in the same folder - that one is the live row above, not a
 * second thread.
 */
function dedupeDetected(list: Session[], found: InventorySession[]): InventorySession[] {
  const own = new Set(list.map((s) => s.engineSessionId).filter(Boolean));
  const live = list.filter((s) => s.alive);
  const now = Date.now();
  return found.filter((x) => {
    if (own.has(x.id)) return false;
    if ((x.updatedAt ?? 0) > now - 15 * 60_000 &&
        live.some((s) => s.engine === x.engine && collapseCwd(s.cwd) === collapseCwd(x.cwd))) {
      return false;
    }
    return true;
  });
}

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
        clearAuth();
        setNotice('This device is no longer in the network. Pair it again with a fresh link from `helm link`.');
        setAuth(null); setClient(null);
      }
    });
    c.connect().catch(() => {});
    setClient(c);
    return () => { off(); c.close?.(); };
  }, [auth]);

  const signOut = () => { clearAuth(); setAuth(null); setClient(null); };

  if (auth === undefined) return null;
  if (!auth) {
    return <Login notice={notice} onDone={(a) => { setNotice(''); saveAuth(a); setAuth(a); }} />;
  }
  if (!client) return null;
  return <Shell client={client} conn={conn} onSignOut={signOut} />;
}

// ------------------------------------------------------------------- shell

type MainView =
  | { kind: 'env' }
  // Every machine summed, or one machine's own scope. Same screen, same
  // facets - the question is the same, only the scope changes.
  | { kind: 'usage'; envId?: string }
  | { kind: 'brain' }
  | { kind: 'new'; path?: string }
  | { kind: 'browse'; path?: string }
  | { kind: 'start'; cwd: string }
  | { kind: 'settings' }
  | { kind: 'network-settings' }
  | { kind: 'models'; account: Account }
  // Which phones and browsers hold a key to this network: pair another, or
  // stop trusting one.
  | { kind: 'devices' }
  | { kind: 'session'; session: Session };

/** A request answered elsewhere, or a session that just started waiting -
    the toast the sidebar cannot show while it is hidden behind a session. */
interface Toast { envId: string; session: Session; at: number }

/**
 * An interval that pauses while the page is hidden and catches up the
 * moment it comes back.
 *
 * Every poll in the app - session lists, transcripts, a machine's last
 * word - used to keep asking while the phone sat in a pocket with the
 * screen off, on a metered connection that did not care nobody was
 * looking. A hidden tab needs no fresher answer than the one it has, and
 * on wake the first tick comes immediately rather than up to `ms` late.
 * `ms` of null means do not poll at all.
 */
function useLiveInterval(ms: number | null, fn: () => void, deps: readonly unknown[] = []) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (ms == null) return;
    const tick = () => { if (!document.hidden) ref.current(); };
    const timer = setInterval(tick, ms);
    const wake = () => { if (!document.hidden) ref.current(); };
    document.addEventListener('visibilitychange', wake);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', wake); };
    // The callback is read through a ref; deps are the caller's own
    // interests, like any other effect.
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
}

function Shell({ client, conn, onSignOut }: {
  client: Client; conn: { online: boolean; reachable: boolean; error?: string }; onSignOut: () => void;
}) {
  const wide = useWide();
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [sessions, setSessions] = useState<Record<string, Session[]>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [stack, setStack] = useState<MainView[]>([{ kind: 'env' }]);
  const [error, setError] = useState('');
  const [downSince, setDownSince] = useState<number | null>(null);
  /** "thread X needs you" while a different session is on screen. */
  const [toast, setToast] = useState<Toast | null>(null);
  /** Search every machine's threads from the sidebar, not only the open one. */
  const [query, setQuery] = useState('');
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
    { stack: [{ kind: 'env' }], selected: null, depth: 0 });

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
      if (!s?.helm) return;
      discardEmpty(nav.current, s.stack);
      nav.current = { stack: s.stack, selected: s.selected, depth: s.depth };
      setStack(s.stack);
      setSelected(s.selected);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [discardEmpty]);

  /** A real move: new view, new history entry, phone-back returns from it. */
  const navigate = (next: MainView[], sel = nav.current.selected) => {
    discardEmpty(nav.current, next);
    const depth = nav.current.depth + 1;
    nav.current = { stack: next, selected: sel, depth };
    setStack(next);
    setSelected(sel);
    history.pushState({ helm: 1, depth, stack: next, selected: sel }, '');
  };

  /** Same place, fresher snapshot: session records change under a view. */
  const restate = (next: MainView[], sel = nav.current.selected) => {
    nav.current = { ...nav.current, stack: next, selected: sel };
    setStack(next);
    setSelected(sel);
    history.replaceState({ helm: 1, depth: nav.current.depth, stack: next, selected: sel }, '');
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
    const m = /^#open=([^/]+)\/(.+)$/.exec(location.hash);
    if (m) {
      take(m[1], m[2]);
      history.replaceState(history.state, '', location.pathname + location.search);
    }
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'helm:open') take(e.data.envId, e.data.sessionId);
    };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    const want = wanted.current;
    if (!want) return;
    const found = (sessions[want.envId] ?? []).find((x) => x.id === want.sessionId);
    if (!found) return;
    wanted.current = null;
    navigate([{ kind: 'env' }, { kind: 'session', session: found }], want.envId);
  }, [sessions]);

  useEffect(() => {
    if (conn.online) { setDownSince(null); return; }
    setDownSince((t) => t ?? Date.now());
  }, [conn.online]);

  const loadEnvs = useCallback(() => {
    client.environments()
      .then((r) => { setEnvs(r.environments); setError(''); })
      .catch((e) => setError(e.message));
  }, [client]);

  const loadSessions = useCallback((envId: string) => {
    client.rpc<{ sessions: Session[] }>(envId, 'session.list', {}, 15_000)
      .then((r) => setSessions((s) => ({ ...s, [envId]: r.sessions })))
      .catch(() => {});
  }, [client]);

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
      if (kind === 'connection' && payload.online) loadEnvs();
      if (kind === 'session.update' && e) {
        loadSessions(e);
        // A session that just started waiting, on a machine this window is
        // not looking at, earns a tap-target in front of whatever is open -
        // on a phone the sidebar that would say so is hidden behind the
        // session you are in. The sheet inside that session is the notice
        // for the one you are looking at, so it is not toasted about.
        const s = payload?.session;
        if (payload?.transition?.to === 'blocked' && s) {
          const top = nav.current.stack[nav.current.stack.length - 1];
          const looking = top?.kind === 'session' && top.session.id === s.id;
          if (!looking) {
            setToast({ envId: e, session: s, at: Date.now() });
            try { navigator.vibrate?.(60); } catch { /* no haptics here */ }
          }
        }
      }
    });
  }, [loadEnvs, loadSessions, client]);

  const liveIds = envs.filter((e) => e.online).map((e) => e.id).join(',');
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
    if (wide && !selected && envs.length) setSelected(envs[0].id);
  }, [wide, selected, envs]);

  const env = envs.find((e) => e.id === selected) ?? null;
  const view = stack[stack.length - 1];

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
   * The tab's title answers "is anything waiting" from the app switcher
   * alone, and names the thread a notification lands on - the one place a
   * session's name matters outside the app itself.
   */
  const blockedCount = envs.reduce((n, e) =>
    n + (sessions[e.id] ?? []).filter((s) => s.engine !== 'shell' && !s.archived && s.status === 'blocked').length, 0);
  useEffect(() => {
    const parts: string[] = [];
    if (view?.kind === 'session') parts.push(view.session.title);
    else if (view?.kind === 'env' && env) parts.push(env.name);
    if (blockedCount) parts.unshift(`${blockedCount} waiting`);
    if (!conn.online) parts.push('offline');
    document.title = parts.length ? `${parts.join(' · ')} · helm` : 'helm';
    return () => { document.title = 'helm'; };
  }, [view, env?.id, blockedCount, conn.online]);

  // The toast is a glance, not a summons: it dismisses itself rather than
  // sit over the composer until it is acknowledged.
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 9000);
    return () => clearTimeout(timer);
  }, [toast]);

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
  const openSession = (envId: string, s: Session) => {
    navigate([{ kind: 'env' }, { kind: 'session', session: s }], envId);
  };
  // A session that changed under an open view: refresh the machine's list and
  // fold the new record into the stack, so the title in the bar and the title
  // in the history entry behind it do not disagree.
  const onSessionChanged = (envId: string) => (s: Session) => {
    loadSessions(envId);
    restate(nav.current.stack.map((v) => (
      v.kind === 'session' && v.session.id === s.id ? { kind: 'session', session: { ...v.session, ...s } } : v)));
  };
  const push = (v: MainView) => navigate([...nav.current.stack, v]);
  const back = () => {
    // One history entry per push, so any stack deeper than its root has
    // somewhere to pop to. At the root there is no such entry; there the ‹
    // means "back to the machine list" on a phone and nothing on desktop.
    if (nav.current.depth > 0) history.back();
    else if (!wide) setSelected(null);
  };

  const agentsOf = (id: string) => (sessions[id] ?? []).filter((s) => s.engine !== 'shell' && !s.archived);

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
   * The row came out of a CLI's own history and has no process behind it, so
   * there is nothing to attach to: the machine starts a fresh driven session
   * carrying the old conversation's id, the engine resumes it, and what comes
   * back is an ordinary helm thread. It takes a moment - a CLI is starting -
   * so the row says so rather than looking ignored.
   */
  const [resuming, setResuming] = useState<string | null>(null);
  const resumeFound = async (envId: string, s: Session) => {
    if (resuming) return;
    setResuming(s.id);
    setError('');
    try {
      const r = await client.rpc<{ session: Session }>(envId, 'session.resume', {
        engine: s.engine, account: (s as any).account,
        id: s.engineSessionId, cwd: s.cwd, title: s.title,
      }, 60_000);
      loadSessions(envId);
      navigate([...nav.current.stack, { kind: 'session', session: r.session }], envId);
    } catch (e: any) {
      setError(`could not continue that thread: ${e.message}`);
    } finally { setResuming(null); }
  };

  const voiceEnvs = envs.filter((e) => e.online && e.info.voice);
  const transcribeVia = (preferred?: string) => {
    const order = [
      ...voiceEnvs.filter((e) => e.id === preferred),
      ...voiceEnvs.filter((e) => e.id !== preferred),
    ];
    if (!order.length) return undefined;
    return async (audio: string, mime: string) => {
      let last = '';
      for (const e of order) {
        try {
          const r = await client.rpc<{ text: string }>(e.id, 'voice.transcribe', { audio, mime }, 60_000);
          return r.text;
        } catch (err: any) { last = err?.message ?? 'transcription failed'; }
      }
      throw new Error(last || 'no machine could transcribe that');
    };
  };

  /**
   * The brains: one per machine, and none until you start one.
   *
   * The live lists are the truth and the remembered records are signposts:
   * without them, the seconds before a machine has answered `session.list`
   * make "does this machine have a brain?" answer no, and tapping its row
   * lands on the screen that offers to start one - which reads as helm having
   * forgotten the brain you chose. A list that has arrived and holds no brain
   * is an answer, though, so it clears the signpost. See `brainStore`.
   */
  const [remembered, setRemembered] = useState<RememberedBrain[]>(loadBrains);
  useEffect(() => {
    let next = remembered;
    for (const e of envs) {
      const list = sessions[e.id];
      if (!list) continue; // that machine has not answered yet
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
  }, [envs, sessions, remembered]);

  /** This machine's brain, live record if there is one and signpost if not. */
  const brainOn = (envId: string): Session | null =>
    (sessions[envId] ?? []).find((s) => s.brain)
    ?? remembered.find((b) => b.envId === envId)?.session
    ?? null;

  /** Straight into the conversation. The picker is for a machine with none. */
  const openBrain = (envId: string) => {
    const s = brainOn(envId);
    if (s) navigate([{ kind: 'session', session: s }], envId);
    else navigate([{ kind: 'brain' }], envId);
  };
  const rememberBrain = (envId: string, s: Session) => {
    saveBrain(envId, s);
    setRemembered((prev) => [...prev.filter((b) => b.envId !== envId), { envId, session: s }]);
  };
  const dropBrain = (envId: string) => {
    forgetBrain(envId);
    setRemembered((prev) => prev.filter((b) => b.envId !== envId));
  };

  const blocked = envs.flatMap((e) => agentsOf(e.id).filter((s) => s.status === 'blocked').map((s) => ({ env: e, s })));
  // On a phone the two panes are one screen at a time: the main pane is shown
  // once a machine is selected, and every view - the brain included - belongs
  // to one.
  // Usage across every machine is a main-pane view that belongs to no machine,
  // so it has to open the main pane on a phone without one being selected -
  // and what devices hold keys belongs to no machine either.
  const showMain = wide || !!selected || view.kind === 'usage' || view.kind === 'devices' || view.kind === 'network-settings';

  // Honest connection words. A dropped socket with a hub that still answers
  // HTTP is "reconnecting", quietly; only a long silence from everything
  // deserves red.
  const downFor = downSince ? Date.now() - downSince : 0;
  const status = conn.online ? 'live' : conn.reachable ? 'reconnecting' : downFor > 12_000 ? 'offline' : 'connecting';
  const hubHost = (() => { try { return new URL(client.relay).host; } catch { return client.relay; } })();

  return (
    <div className="shell">
      <aside className={`sidebar${!showMain ? ' showing' : ''}${wide && sidebarCollapsed ? ' collapsed' : ''}`}>
        <div className="bar side">
          <div className="brand">
            <img src="/icon.svg" alt="" />
            <b>helm</b>
          </div>
          <span className={`conn ${status}`} title={conn.error || status}>
            <i />{status === 'live' ? `${envs.filter((e) => e.online).length}/${envs.length} online` : status}
          </span>
          <span className="side-tools">
            <button
              className="iconbtn settings-toggle" title="CLI defaults on every machine" aria-label="CLI settings"
              onClick={() => navigate([{ kind: 'network-settings' }])}
            ><Sliders /></button>
            <button
              className="iconbtn collapse-toggle"
              title={sidebarCollapsed ? 'expand sidebar' : 'collapse sidebar'}
              aria-label={sidebarCollapsed ? 'expand sidebar' : 'collapse sidebar'}
              onClick={() => collapseSidebar(!sidebarCollapsed)}
            >{sidebarCollapsed ? '›' : '‹'}</button>
          </span>
        </div>

        <div className="scroll">
          <div className="side-pad">
            {status === 'offline' && (
              <div className="banner error">
                No machine answered for a while. Check the VM, or that this phone has internet.
              </div>
            )}

            {/* "Which machine has the thread about X" is one question, not
                one per machine. The box searches every live list, and the
                remembered threads of machines that are asleep. */}
            <div className="filterbar">
              <input
                className="sheetfilter grow" value={query} placeholder="search threads & machines"
                autoCapitalize="off" autoCorrect="off" autoComplete="off"
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            {(() => {
              const q = query.trim().toLowerCase();
              if (!q) return null;
              const hits = envs.flatMap((e) => {
                const live = agentsOf(e.id)
                  .filter((s) => `${s.title} ${s.cwd} ${engineOf(s.engine).label}`.toLowerCase().includes(q))
                  .map((s) => ({ e, s, stale: false }));
                const remembered = !e.online
                  ? (snap?.machines?.[e.id]?.sessions ?? [])
                    .filter((s) => `${s.title} ${s.cwd} ${engineOf(s.engine).label}`.toLowerCase().includes(q))
                    .map((s) => ({ e, s, stale: true }))
                  : [];
                return [...live, ...remembered];
              }).sort((a, b) => (b.s.updatedAt ?? 0) - (a.s.updatedAt ?? 0)).slice(0, 40);
              const machines = envs.filter((e) => e.name.toLowerCase().includes(q));
              return (
                <>
                  <div className="section">everywhere</div>
                  <div className="rows">
                    {machines.map((e) => (
                      <button key={e.id} className="row" onClick={() => { setQuery(''); openEnv(e.id); }}>
                        <span className={`mdot ${e.online ? 'on' : 'off'}`} />
                        <span className="grow"><span className="rt">{e.name}</span><span className="rm">machine</span></span>
                        <span className="chev">›</span>
                      </button>
                    ))}
                    {hits.map(({ e, s, stale }) => (
                      <button key={`${e.id}:${s.id}`} className="row tall" onClick={() => {
                        setQuery('');
                        if (stale) openEnv(e.id);
                        else openSession(e.id, s);
                      }}>
                        <EngineMark engine={engineOf(s.engine).cls} />
                        <span className="grow">
                          <span className="rt">{s.title}{stale && <span className="tag">offline</span>}</span>
                          <span className="rm">{e.name} · {shortPath(s.cwd)}</span>
                        </span>
                        <StatusChip status={s.status} />
                      </button>
                    ))}
                    {!hits.length && !machines.length && <div className="empty quiet">nothing anywhere matches</div>}
                  </div>
                </>
              );
            })()}

            {!query.trim() && (<>

            {blocked.length > 0 && (
              <>
                <div className="section attention">needs you</div>
                <div className="rows">
                  {blocked.map(({ env: e, s }) => (
                    <button key={s.id} className="row" onClick={() => openSession(e.id, s)}>
                      <span className="sdot blocked" />
                      <span className="grow">
                        <span className="rt">{s.title}</span>
                        <span className="rm">{e.name} · {shortPath(s.cwd)}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}

            <Fold title="machines" count={envs.length} defaultOpen remember="sidebar:machines" showEmpty>
              <div className="rows cards">
                {envs.map((e) => {
                  const list = agentsOf(e.id);
                  const working = list.filter((s) => s.status === 'working').length;
                  const waiting = list.filter((s) => s.status === 'blocked').length;
                  return (
                    <button
                      key={e.id}
                      className={`row tall${e.id === selected && wide ? ' active' : ''}`}
                      onClick={() => openEnv(e.id)}
                    >
                      <span className={`mdot ${e.online ? 'on' : 'off'}`} />
                      <span className="grow">
                        <span className="rt">{e.name}</span>
                        <span className="rm">
                          {e.online
                            ? (list.length ? `${list.length} running${working ? `, ${working} working` : ''}` : 'idle')
                            : e.lastSeen ? `seen ${ago(e.lastSeen)}` : 'never connected'}
                        </span>
                      </span>
                      {waiting > 0 && <span className="badge">{waiting}</span>}
                      <span className="chev">›</span>
                    </button>
                  );
                })}
                {!envs.length && !error && <div className="empty quiet">no machines yet</div>}
              </div>
            </Fold>

            {/* One brain per machine: a thread that is not tied to a
                folder, on the machine it can act from. They are listed apart
                from the machines above because you come here for the brain,
                not for the machine - and a machine with none says so, which
                is the only way to start one. */}
            <Fold title="brains" count={envs.length} defaultOpen remember="sidebar:brains" showEmpty>
              <div className="rows">
                {envs.map((e) => {
                  const s = brainOn(e.id);
                  return (
                    <button key={e.id} className="row" onClick={() => openBrain(e.id)}>
                      {/* An empty slot rather than no slot: the rows line up
                          with each other, and with the machines above. */}
                      <EngineMark engine={s ? engineOf(s.engine).cls : undefined} />
                      <span className="grow">
                        <span className="rt">{e.name}{s?.status === 'blocked' && <span className="tag">needs you</span>}</span>
                        <span className="rm">
                          {s
                            ? `${engineOf(s.engine).label}${s.model ? ` · ${s.model}` : ''}`
                            : e.online ? 'no brain here yet' : 'no brain here yet · offline'}
                        </span>
                      </span>
                      <span className="chev">›</span>
                    </button>
                  );
                })}
              </div>
            </Fold>

            <div className="section">usage</div>
            <div className="rows">
              <button className="row" onClick={() => navigate([{ kind: 'usage' }])}>
                <span className="grow">
                  <span className="rt">What it has cost</span>
                  <span className="rm">tokens, spend and cache across every machine</span>
                </span>
                <span className="chev">›</span>
              </button>
            </div>

            {/* Setup is three things you do once and then never again. As
                full-width slabs they outweighed the machines above them,
                which is the wrong way round: they are a footer, so they
                look like one. */}
            <div className="section">this device</div>
            <div className="rows">
              <button className="row" onClick={() => navigate([{ kind: 'devices' }])}>
                <span className="grow">
                  <span className="rt">Devices & pairing</span>
                  <span className="rm">what holds a key to this network</span>
                </span>
                <span className="chev">›</span>
              </button>
              <AddMachine client={client} />
              <Notifications client={client} />
              <InstallPwa />
              <button className="row destructive" onClick={() => setUnpairing(true)}>
                <span className="grow"><span className="rt">Unpair this device</span></span>
              </button>
            </div>
            {error && <div className="error">{error}</div>}

            </>)}
          </div>
          <div className="diag">
            <span>{hubHost || 'no hub'}</span>
            <span>{conn.online ? 'socket live' : conn.error || 'socket down'}</span>
          </div>
        </div>
      </aside>

      <section className={`main${showMain ? ' showing' : ''}`}>
        {view.kind === 'usage' ? (
          <UsageView client={client} envs={envs} initialEnvId={view.envId} onBack={back} />
        ) : view.kind === 'devices' ? (
          <DevicesView client={client} onBack={back} />
        ) : view.kind === 'network-settings' ? (
          <NetworkSettings
            client={client} envs={envs} onBack={back}
            onOpen={(envId, account) => navigate([
              { kind: 'env' }, { kind: 'settings' }, { kind: 'models', account },
            ], envId)}
          />
        ) : !env ? (
          <div className="scroll"><div className="pad">
            <div className="empty quiet">select a machine</div>
          </div></div>
        ) : view.kind === 'brain' ? (
          <BrainView
            key={env.id}
            client={client} env={env} brain={brainOn(env.id)} onBack={back}
            // Replaces this screen rather than stacking on it: choosing a
            // machine's brain happens once, and going back to a form offering
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
            sessions={sessions[env.id] ?? []} reload={reloadEnv}
            remembered={env.online ? undefined : snap?.machines?.[env.id]?.sessions}
            rememberedAt={env.online ? undefined : snap?.machines?.[env.id]?.at}
            onResume={(s) => resumeFound(env.id, s)} resuming={resuming}
            onNewSession={() => push({ kind: 'new' })}
            onAddProject={() => push({ kind: 'browse' })}
            onStart={(cwd) => push({ kind: 'start', cwd })}
            onSettings={() => push({ kind: 'settings' })}
            onUsage={() => push({ kind: 'usage', envId: env.id })}
            onOpen={(s) => push({ kind: 'session', session: s })}
          />
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
          />
        ) : view.kind === 'browse' ? (
          <Browse
            client={client} env={env} path={view.path} onBack={back}
            title="Add project" action="Add this project"
            onInto={(path) => push({ kind: 'browse', path })}
            onPick={async (cwd) => {
              await client.rpc<{ project: Project }>(env.id, 'project.save', { path: cwd }, 20_000);
              restate([{ kind: 'env' }]);
            }}
          />
        ) : view.kind === 'start' ? (
          <Start
            client={client} env={env} cwd={view.cwd} onBack={back}
            onStarted={(s) => {
              loadSessions(env.id);
              // The browsing chain collapses into the session it produced:
              // this entry is replaced so back lands on the folder picker,
              // not on a form for a session that already exists.
              restate([{ kind: 'env' }, { kind: 'session', session: s }]);
            }}
          />
        ) : view.session.driver ? (
          <DrivenSession
            key={view.session.id}
            client={client} env={env} conn={conn} onTranscribe={transcribeVia(env.id)}
            session={(sessions[env.id] ?? []).find((s) => s.id === view.session.id) ?? view.session}
            onBack={back}
            onSettings={() => navigate([{ kind: 'brain' }], env.id)}
            onClosed={() => { if (view.session.brain) dropBrain(env.id); loadSessions(env.id); back(); }}
            onArchived={() => { loadSessions(env.id); back(); }}
            onSession={onSessionChanged(env.id)}
          />
        ) : (
          <SessionView
            key={view.session.id}
            client={client} env={env} onTranscribe={transcribeVia(env.id)}
            session={(sessions[env.id] ?? []).find((s) => s.id === view.session.id) ?? view.session}
            onBack={back}
            onClosed={() => { loadSessions(env.id); back(); }}
            onArchived={() => { loadSessions(env.id); back(); }}
            onSession={onSessionChanged(env.id)}
          />
        )}
      </section>

      {/* Another thread started waiting while this one was open. A tap on
          the toast is the whole journey to answering it. */}
      {toast && (
        <button
          className="toast"
          onClick={() => { const t = toast; setToast(null); openSession(t.envId, t.session); }}
        >
          <i className="sdot blocked" />
          <span className="grow">
            <b>{toast.session.title}</b>
            <small>{envs.find((e) => e.id === toast.envId)?.name ?? 'a machine'} needs you</small>
          </span>
          <span className="chev">›</span>
        </button>
      )}

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

// ------------------------------------------------------------------- login

function Login({ notice, onDone }: { notice?: string; onDone: (a: Auth) => void }) {
  const openedWith = useRef(pairingTarget(location.href));
  const autoStarted = useRef(false);
  const [link, setLink] = useState('');
  const [password, setPassword] = useState(() => openedWith.current?.password || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selfHosted, setSelfHosted] = useState<boolean | null>(null);
  const [linkSecretFailed, setLinkSecretFailed] = useState(false);

  const finish = (auth: Auth) => {
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    onDone(auth);
  };

  const connect = async (endpoint: string, secret: string, local?: string) => {
    setBusy(true); setError('');
    try {
      finish(await login(endpoint, secret, local));
    } catch (err: any) {
      setError(err.message);
      setLinkSecretFailed(true);
      setPassword((p) => (p === secret ? '' : p));
    } finally { setBusy(false); }
  };

  // `helm open` puts this machine's own key in the fragment. Nothing to type:
  // the daemon takes it only from loopback and only if it matches the file it
  // came from, so holding it already means holding the network key.
  useEffect(() => {
    const local = new URLSearchParams(location.hash.replace(/^#\/?/, '')).get('local');
    if (!local || autoStarted.current) return;
    autoStarted.current = true;
    connect(location.origin, '', local);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isLocal = /^(127\.|localhost|\[::1\])/.test(location.hostname);

  useEffect(() => {
    let cancelled = false;
    fetch(`${location.origin}/api/health`)
      .then((r) => r.ok)
      .then((ok) => { if (!cancelled) setSelfHosted(ok); })
      .catch(() => { if (!cancelled) setSelfHosted(false); });
    return () => { cancelled = true; };
  }, []);

  // The page is being served by a daemon on this very computer, which is the
  // whole claim a local sign-in makes - ask it for the local key directly
  // rather than waiting for a link. Nothing answers that but this machine.
  useEffect(() => {
    if (!isLocal || selfHosted !== true || autoStarted.current) return;
    autoStarted.current = true;
    fetch('/api/auth/local', { method: 'POST' })
      .then((r) => (r.ok ? r.json() : null))
      .then((v) => { if (v?.local) connect(location.origin, '', v.local); })
      .catch(() => {});
  }, [selfHosted]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The other direction: the app was installed from the VM's public address
   * but a daemon is also running on this computer, and that one signs itself
   * in. This used to be a sentence with a link in it, under a pairing form -
   * so the answer to "open helm on my desktop" was: read a paragraph, click
   * the link, every time. It goes there itself now.
   *
   * Only when there is nothing else to do: a link with a pairing code in it,
   * or a key from `helm open`, is a deliberate instruction to pair *here* and
   * outranks the local daemon. The local page cannot bounce back - it takes
   * the `isLocal` branch above - so there is no loop to get stuck in.
   */
  const [localHelm, setLocalHelm] = useState<string | null>(null);
  useEffect(() => {
    if (isLocal || openedWith.current?.password || autoStarted.current) return;
    fetch('http://127.0.0.1:8787/api/health', { cache: 'no-store' })
      .then((r) => {
        if (!r.ok || autoStarted.current) return;
        setLocalHelm('http://127.0.0.1:8787');
        location.replace('http://127.0.0.1:8787/');
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const target = openedWith.current;
    if (selfHosted !== true || !target?.password || autoStarted.current) return;
    autoStarted.current = true;
    connect(location.origin, target.password);
  }, [selfHosted]);

  const pasted = pairingTarget(link);
  const secretFromLink = selfHosted ? openedWith.current?.password : pasted?.password;
  const secretInLink = linkSecretFailed ? '' : secretFromLink;
  const endpoint = selfHosted ? location.origin : pasted?.endpoint || '';
  const secret = password || secretInLink || '';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!endpoint) { setError('paste the link printed by `helm link`'); return; }
    if (!secret) { setError('enter the pairing code'); return; }
    await connect(endpoint, secret);
  };

  // Found one on this computer: the redirect is already going. Showing the
  // pairing form underneath it only invites someone to start typing a code
  // into a screen that is about to be replaced.
  if (localHelm) {
    return (
      <div className="auth">
        <div className="auth-card">
          <div className="auth-brand">
            <img src="/icon.svg" alt="" />
            <h1>helm</h1>
            <p>opening the helm on this computer…</p>
          </div>
          <p className="note" style={{ textAlign: 'center' }}>
            <a href={localHelm}>{localHelm.replace(/^https?:\/\//, '')}</a>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <img src="/icon.svg" alt="" />
          <h1>helm</h1>
          <p>every coding agent, one place</p>
        </div>

        <form onSubmit={submit}>
          {notice && <div className="banner warn">{notice}</div>}
          {selfHosted ? (
            <div className="pair-ticket">
              <span className="mdot on" />
              <span><b>{location.host}</b><small>your Helm home</small></span>
            </div>
          ) : (
            <>
              <div className="section">private Helm link</div>
              <input
                value={link}
                onChange={(e) => { setLink(e.target.value); setLinkSecretFailed(false); }}
                placeholder="https://helm.example.com/#pair=…"
                autoCapitalize="off" autoCorrect="off" inputMode="url"
                autoFocus
              />
            </>
          )}

          {!secretInLink && (
            <>
              <div className="section">pairing code</div>
              <input
                type="password" value={password} autoFocus={!!selfHosted}
                onChange={(e) => setPassword(e.target.value)}
              />
            </>
          )}

          <button className="primary" disabled={busy || !endpoint || !secret}>
            {busy ? 'pairing…' : 'pair this device'}
          </button>
          {error && <div className="error">{error}</div>}
          <p className="note" style={{ marginTop: 14, textAlign: 'center' }}>
            Run <code>helm link</code> on your VM for a fresh link.
            Pair once; this device stays paired until you remove it.
          </p>
        </form>
        {/* The one place "install it" cannot wait for the sidebar: a phone
            that has not paired yet is exactly the phone this is for. */}
        <InstallPwa />
      </div>
    </div>
  );
}

function AddMachine({ client }: { client: Client }) {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState('');

  return (
    <>
      {code ? (
        <div className="setup-open">
          <div className="code">{code}</div>
          <pre className="snippet">helm join {code} {client.relay}</pre>
          <p className="note" style={{ marginTop: 8 }}>
            Run that on the machine you are adding. Expires in 10 minutes and
            carries the network key: treat it like a password.
          </p>
        </div>
      ) : (
        <button
          className="row"
          onClick={() => client.invite().then((r) => setCode(r.code)).catch((e) => setError(e.message))}
        >
          <span className="grow">
            <span className="rt">Add a computer</span>
            <span className="rm">create a join code</span>
          </span>
          <span className="chev">›</span>
        </button>
      )}
      {error && <div className="error">{error}</div>}
    </>
  );
}

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Turning on "tell me when a session is waiting".
 *
 * The browser only asks for permission from a real click, and only over
 * https, so this is a button and it stays hidden on plain http where the
 * whole thing is impossible anyway. Every way it can fail says why: a
 * permission the person already denied cannot be re-asked from inside the
 * page, and silently doing nothing is the worst answer to give there.
 */
function Notifications({ client }: { client: Client }) {
  const [state, setState] = useState<'unknown' | 'off' | 'on' | 'blocked' | 'unsupported'>('unknown');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const able = 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
    if (!able || location.protocol !== 'https:') { setState('unsupported'); return; }
    if (Notification.permission === 'denied') { setState('blocked'); return; }
    navigator.serviceWorker.ready
      .then(async (reg) => {
        const existing = await reg.pushManager.getSubscription();
        if (existing) return existing;
        // Browsers only let the permission prompt happen on a click. Once a
        // person has already granted it, however, restore the subscription
        // automatically so notifications remain on by default after a
        // browser reset or service-worker replacement.
        if (Notification.permission !== 'granted') return null;
        const { key } = await client.pushKey();
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64urlToBytes(key),
        });
        await client.pushSubscribe({
          endpoint: sub.endpoint,
          keys: (sub.toJSON() as any).keys,
          label: navigator.platform || 'this device',
        });
        return sub;
      })
      .then((sub) => setState(sub ? 'on' : 'off'))
      .catch(() => setState('off'));
  }, [client]);

  const enable = async () => {
    setBusy(true); setError('');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') { setState(permission === 'denied' ? 'blocked' : 'off'); return; }
      const { key } = await client.pushKey();
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64urlToBytes(key),
      });
      await client.pushSubscribe({
        endpoint: sub.endpoint,
        keys: (sub.toJSON() as any).keys,
        label: navigator.platform || 'this device',
      });
      setState('on');
    } catch (e: any) {
      setError(e?.message || 'could not turn notifications on');
    } finally { setBusy(false); }
  };

  const disable = async () => {
    setBusy(true); setError('');
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await client.pushUnsubscribe(sub.endpoint);
        await sub.unsubscribe();
      }
      setState('off');
    } catch (e: any) {
      setError(e?.message || 'could not turn them off');
    } finally { setBusy(false); }
  };

  if (state === 'unknown' || state === 'unsupported') return null;
  return (
    <>
      {state === 'blocked' ? (
        <p className="note setup-open">
          Notifications are blocked for this site. Turn them back on in the
          browser&rsquo;s settings for this address, then reload.
        </p>
      ) : (
        <button className="row" disabled={busy} onClick={state === 'on' ? disable : enable}>
          <span className="grow">
            <span className="rt">Notify this device</span>
            <span className="rm">when a session needs you or finishes</span>
          </span>
          <span className={`tag${state === 'on' ? ' key' : ''}`}>
            {busy ? '\u2026' : state === 'on' ? 'on' : 'off'}
          </span>
        </button>
      )}
      {error && <p className="note setup-open">{error}</p>}
    </>
  );
}

/**
 * The VAPID key travels as base64url; `subscribe` wants the raw bytes.
 * Typed as ArrayBuffer rather than Uint8Array because lib.dom's BufferSource
 * will not take a view whose buffer might be shared.
 */
function base64urlToBytes(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded);
  const out = new ArrayBuffer(raw.length);
  const view = new Uint8Array(out);
  for (let i = 0; i < raw.length; i += 1) view[i] = raw.charCodeAt(i);
  return out;
}

function InstallPwa() {
  const [offer, setOffer] = useState<InstallPromptEvent | null>(null);
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);

  useEffect(() => {
    const remember = (event: Event) => {
      event.preventDefault();
      setOffer(event as InstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', remember);
    return () => window.removeEventListener('beforeinstallprompt', remember);
  }, []);

  if (standalone || (!offer && !ios)) return null;
  return (
    <>
      {offer ? (
        <button className="row" onClick={async () => {
          await offer.prompt();
          await offer.userChoice;
          setOffer(null);
        }}>
          <span className="grow">
            <span className="rt">Install Helm app</span>
            <span className="rm">run it like a native app</span>
          </span>
          <span className="chev">›</span>
        </button>
      ) : (
        <p className="note install-note setup-open">On iPhone or iPad: tap Share, then Add to Home Screen.</p>
      )}
    </>
  );
}

// --------------------------------------------------------------- one machine

/**
 * Every device that holds a key to this network.
 *
 * Pairing used to end the moment it happened: the phone that paired was
 * trusted forever, and trusting another one meant walking back to a
 * terminal. Here they are listed, named by what they signed in as, and any
 * of them can be removed or another invited - the device doing the asking
 * is marked, because "remove the one I am holding" is a question with a
 * different answer than "remove the old tablet".
 */
function DevicesView({ client, onBack }: { client: Client; onBack: () => void }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<Device | null>(null);
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<{ link: string; expiresAt: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const now = useNow();

  const load = useCallback(() => {
    client.devices()
      .then((r) => setDevices(r.devices))
      .catch((e) => setError(e.message));
  }, [client]);
  useEffect(load, [load]);

  const pair = async () => {
    setBusy(true); setError('');
    try {
      const r = await client.newPassword(10 * 60_000);
      setInvite({ link: `${client.relay}/#pair=${r.password}`, expiresAt: r.expiresAt });
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    const d = removing;
    if (!d) return;
    setBusy(true); setError('');
    try {
      await client.removeDevice(d.id);
      setRemoving(null);
      if (d.self) { onBack(); location.reload(); return; } // this device's own key is gone
      load();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" onClick={onBack}>‹</button>
        <div className="titles"><h1>Devices</h1><span className="sub">what holds a key to this network</span></div>
      </div>
      <div className="scroll"><div className="pad column">
        {invite ? (
          <div className="setup-open">
            <p className="note">
              Open this link on the device you are pairing. It expires in a
              few minutes and carries a pairing secret - treat it like a
              password.
            </p>
            <pre className="snippet">{invite.link}</pre>
            <div className="rows">
              <button className="row" onClick={async () => {
                try { await navigator.clipboard.writeText(invite.link); setCopied(true); }
                catch { setError('could not copy - long-press the link instead'); }
              }}>
                <span className="grow"><span className="rt">{copied ? 'copied' : 'Copy link'}</span></span>
              </button>
              <button className="row" onClick={() => { setInvite(null); setCopied(false); }}>
                <span className="grow"><span className="rt">Done</span></span>
              </button>
            </div>
          </div>
        ) : (
          <button className="action" disabled={busy} onClick={pair}>
            <span className="plus">+</span>{busy ? 'making a link…' : 'Pair another device'}
          </button>
        )}

        <div className="section">paired</div>
        <div className="rows">
          {devices === null && !error && <div className="empty quiet">asking the hub…</div>}
          {devices?.map((d) => (
            <div key={d.id} className="row tall rowx">
              <div className="rowmain">
                <span className={`mdot ${d.self ? 'on' : 'off'}`} />
                <span className="grow">
                  <span className="rt">{d.label}{d.self && <span className="tag key">this device</span>}</span>
                  <span className="rm">paired {waitingSince(d.addedAt, now) === 'just now' ? 'just now' : `${waitingSince(d.addedAt, now)} ago`}</span>
                </span>
              </div>
              <button className="rowend" title={`remove ${d.label}`} aria-label={`remove ${d.label}`}
                onClick={() => setRemoving(d)}>×</button>
            </div>
          ))}
          {devices?.length === 0 && <div className="empty quiet">no devices paired</div>}
        </div>
        <p className="note">
          Removing a device revokes its key everywhere - it asks for a fresh
          pairing link the next time it opens helm.
        </p>
        {error && <div className="error">{error}</div>}
      </div></div>

      {removing && (
        <Confirm
          title={removing.self ? 'Remove this device?' : `Remove ${removing.label}?`}
          body={removing.self
            ? 'This is the device you are holding. You will need a fresh link from `helm link` to sign back in.'
            : 'Its key stops working at once, on every machine in the network.'}
          confirmLabel="Remove" danger busy={busy}
          onCancel={() => setRemoving(null)}
          onConfirm={remove}
        />
      )}
    </>
  );
}

function EnvView({ client, env, wide, sessions, remembered, rememberedAt, reload, onBack, onNewSession, onAddProject, onStart, onSettings, onUsage, onOpen, onResume, resuming }: {
  client: Client; env: Environment; wide: boolean; sessions: Session[];
  /** What this machine last said it was running, while it cannot be asked. */
  remembered?: Session[]; rememberedAt?: number;
  reload: () => void; onBack: () => void; onNewSession: () => void; onAddProject: () => void; onStart: (cwd: string) => void;
  onSettings: () => void;
  onUsage: () => void; onOpen: (s: Session) => void;
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
  const [renaming, setRenaming] = useState<Project | null>(null);
  const [removing, setRemoving] = useState<Project | null>(null);
  const [projectBusy, setProjectBusy] = useState(false);
  const reloadProjects = useCallback(() => {
    if (!env.online) { setProjects([]); return; }
    client.rpc<{ projects: Project[] }>(env.id, 'project.list', {}, 20_000)
      .then((r) => setProjects(r.projects ?? []))
      .catch((e) => setError(e.message));
  }, [client, env.id, env.online]);
  const projectCwds = sessions.filter((s) => s.engine !== 'shell').map((s) => s.cwd ?? '').sort().join('\n');
  useEffect(() => { reloadProjects(); }, [reloadProjects, projectCwds]); // eslint-disable-line react-hooks/exhaustive-deps

  const openTerminal = async () => {
    setOpening(true); setError('');
    try {
      // A machine has one terminal to return to until that shell ends. Only
      // then does opening the terminal create its replacement.
      const existing = sessions
        .filter((s) => s.engine === 'shell' && !s.archived && s.alive !== false)
        .sort(byRecent)[0];
      if (existing) {
        onOpen(existing);
        return;
      }
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
    !q || `${s.title} ${s.cwd} ${engineOf(s.engine).label}`.toLowerCase().includes(q);

  // Threads this machine's CLIs recorded without helm, beside helm's own.
  const detected = dedupeDetected(sessions, earlier);
  const external = detected.map(foundRow);
  // A terminal is reached through the machine's terminal button and kept
  // alive for that button to reopen. It is not a chat and should never be
  // recorded in the thread, archive or search lists.
  const rows = [...sessions.filter((s) => s.engine !== 'shell'), ...external];

  const live = (s: Session) => s.engine !== 'shell' && !s.archived && hit(s);
  const mine = sessions.filter(live);
  const blocked = mine.filter((s) => s.status === 'blocked').sort(byRecent);
  const working = mine.filter((s) => s.status === 'working').sort(byRecent);

  const rest = mine.filter((s) => s.status !== 'blocked' && s.status !== 'working');
  const externalLive = external.filter((s) => !s.archived && hit(s));
  const recent = [...rest, ...externalLive].sort(byRecent).slice(0, 3);
  const recentIds = new Set(recent.map((s) => s.id));

  const projectFolds = projects
    .map((p) => ({
      project: p,
      list: [
        ...rest.filter((s) => !recentIds.has(s.id) && sameDir(s.cwd || '~', p.path)),
        ...externalLive.filter((s) => !recentIds.has(s.id) && sameDir(s.cwd || '~', p.path)),
      ].sort(byRecent),
    }))
    .filter(({ project: p, list }) =>
      !q || list.length > 0 || `${p.title} ${p.path}`.toLowerCase().includes(q));
  const inProject = new Set(projectFolds.flatMap(({ list }) => list.map((s) => s.id)));

  // Threads from this week in folders helm has never started anything in,
  // newest first and capped - until someone types, and then the cap is the
  // thing standing between them and what they are looking for.
  const strays = [...rest, ...externalLive]
    .filter((s) => !inProject.has(s.id) && !recentIds.has(s.id) && thisWeek(s)).sort(byRecent);
  const elsewhere = q ? strays : strays.slice(0, 8);

  // Everything either side of the week, in one flat list rather than a second
  // set of folders: what is in here is, by definition, not what you are
  // working on. It has to stay reachable, though - "it is not here" and "it
  // is one tap down" are different answers and only one of them is true.
  const older = [...rest, ...externalLive]
    .filter((s) => !inProject.has(s.id) && !recentIds.has(s.id) && !thisWeek(s)).sort(byRecent);

  // Archived threads are on the machine they were archived on, folded away.
  const filed = rows.filter((s) => s.archived && hit(s)).sort(byRecent);

  // Enough on this machine that finding one by eye is work. The box stays
  // once something is typed in it, however few rows the typing leaves.
  const searchable = rows.length > 5 || !!q;

  const setArchived = async (s: Session, archived: boolean) => {
    setError('');
    try {
      await client.rpc(env.id, 'session.archive', { id: s.id, archived }, 20_000);
      reload(); reloadEarlier();
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
   * A thread helm started opens; a thread a CLI recorded on its own has no
   * process behind it, so opening it means asking the machine to resume the
   * conversation first - and it cannot be renamed, because the name is the
   * CLI's. Everything on this screen is now mixed into the same groups, so
   * that difference has to live in the row rather than in the group it is in.
   */
  const toggle = (id: string) => setMarked((m) => {
    const next = new Set(m);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const row = (s: Session) => s.id.startsWith('found:') ? (
    <SessionRow
      key={s.id} s={s} busy={resuming === s.id}
      selecting={selecting} marked={marked.has(s.id)} onToggle={() => toggle(s.id)}
      onOpen={env.online && !selecting ? () => onResume(s) : undefined}
      onArchive={() => setArchived(s, !s.archived)}
      onDelete={() => deleteSession(s)}
    />
  ) : (
    <SessionRow
      key={s.id} s={s} onOpen={() => onOpen(s)}
      selecting={selecting} marked={marked.has(s.id)} onToggle={() => toggle(s.id)}
      onRename={(t) => setTitle(s, t)}
      onArchive={() => setArchived(s, !s.archived)}
      onDelete={() => deleteSession(s)}
    />
  );

  return (
    <>
      <div className="bar">
        {!wide && <button className="iconbtn back" onClick={onBack}>‹</button>}
        <div className="titles">
          <h1>{env.name}</h1>
          <span className="sub">
            {env.online
              ? (direct
                ? (route?.local === 'host' && route?.remote === 'host'
                  ? 'direct, same network'
                  : route ? `direct, out and back (${route.local}/${route.remote})` : 'direct connection')
                : 'via your Helm home')
              : 'offline'}
            {env.online && ping != null && (
              // The number matters because the two routes differ by two
              // orders of magnitude, and a relayed phone that feels broken
              // is usually just far away. Saying so is the difference
              // between "helm is slow" and "this connection is slow".
              <span className={ping > 250 ? 'quiet slow' : 'quiet'}> · {Math.round(ping)}ms</span>
            )}
            {env.info.host && env.info.host !== env.name ? ` \u00b7 ${env.info.host}` : ''}
          </span>
        </div>
        <button
          className="iconbtn mono"
          // A machine with no pty falls back to sampling a herdr pane's
          // screen, which is slow enough to be worth saying before you open
          // one and wonder what is wrong with it.
          title={env.info.terminals === 'panes' ? 'terminal (slow: no pty on this machine)' : 'terminal'}
          disabled={!env.online || opening}
          onClick={openTerminal}
        >{env.info.terminals === 'panes' ? '❯!' : '❯_'}</button>
        <button className="iconbtn" title={`what ${env.name} has cost`} onClick={onUsage}><Meter /></button>
        <button className="iconbtn" title={`${env.name} settings`} onClick={onSettings}><Sliders /></button>
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
        {!env.online && <div className="banner warn">this machine is offline</div>}

        <button className="action" disabled={!env.online} onClick={onNewSession}>
          <span className="plus">+</span>New session
        </button>

        {env.online && (
          <div className="note" style={{ textAlign: 'center', marginTop: -6 }}>
            <button className="linkish" onClick={onAddProject}>Add a project shortcut</button>
          </div>
        )}

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
            <div className="rows">{blocked.map(row)}</div>
          </div>
        )}
        {working.length > 0 && (
          <div>
            <div className="section">working</div>
            <div className="rows">{working.map(row)}</div>
          </div>
        )}
        {recent.length > 0 && (
          <div>
            <div className="section">recent</div>
            <div className="rows">{recent.map(row)}</div>
          </div>
        )}
        {projectFolds.map(({ project: p, list }) => (
          <Fold
            key={p.path}
            title={p.title}
            count={list.length}
            note={projectNote(p.path)}
            openWhen={!!q}
            remember={`${env.id}:${p.path}`}
            showEmpty
            actions={(
              <ProjectActions
                title={p.title}
                onStart={() => onStart(p.path)}
                onRename={() => setRenaming(p)}
                onRemove={() => setRemoving(p)}
              />
            )}
          >
            {list.length ? (
              <div className="rows">{list.map(row)}</div>
            ) : (
              <div className="empty quiet">
                no threads here yet
                <div className="note" style={{ marginTop: 6 }}>
                  <button className="linkish" disabled={!env.online} onClick={() => onStart(p.path)}>
                    + New thread
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
          title="elsewhere on this machine" count={elsewhere.length}
          note={strays.length > elsewhere.length ? `${elsewhere.length} of ${strays.length}` : undefined}
          openWhen={!!q}
          remember={`${env.id}:~elsewhere`}
        >
          <div className="rows">{elsewhere.map(row)}</div>
        </Fold>
        <Fold title="older" count={older.length} note="before this week" openWhen={!!q} remember={`${env.id}:~older`}>
          <div className="rows">{older.map(row)}</div>
        </Fold>
        <Fold title="archived" count={filed.length} openWhen={!!q} remember={`${env.id}:~archived`}>
          <div className="rows">{filed.map(row)}</div>
        </Fold>

        {/* An offline machine keeps its last word, not a blank page: the
            threads it said were running, dimmed and dated, with the actions
            held back because nothing can reach it to carry them out. */}
        {!env.online && (remembered?.length ?? 0) > 0 && (
          <>
            <div className="section">
              last known{rememberedAt ? ` · seen ${waitingSince(rememberedAt, now)} ago` : ''}
            </div>
            <div className="rows stale">
              {remembered!.map((s) => (
                <div key={s.id} className="row tall">
                  <div className="rowmain">
                    <EngineMark engine={engineOf(s.engine).cls} />
                    <span className="grow">
                      <span className="rt"><span className="rt-text">{s.title}</span></span>
                      <span className="rm">
                        {[engineOf(s.engine).label, s.model, shortPath(s.cwd)].filter(Boolean).join(' · ')}
                        {s.updatedAt ? ` · ${waitingSince(s.updatedAt, now)}` : ''}
                      </span>
                    </span>
                    <StatusChip status={s.status} at={s.updatedAt} />
                  </div>
                </div>
              ))}
            </div>
            <p className="note">as it was when this machine last answered - it may be different now.</p>
          </>
        )}
        {/* Nothing to say when a fold above is holding the answer: a search
            that found an archived thread and only an archived thread is a
            search that worked, and "nothing matches" underneath the thing
            that matched is just wrong. */}
        {!blocked.length && !working.length && !projectFolds.length &&
          !(q && (filed.length || older.length || elsewhere.length)) && (
          <div className="empty quiet">
            {q ? 'nothing matches' : older.length || filed.length || strays.length ? 'nothing from this week' : `nothing running on ${env.name}`}
            <div className="note" style={{ marginTop: 6 }}>
              {q
                ? 'titles, folders and engines, on this machine'
                : older.length || filed.length || strays.length
                  ? 'older threads are folded below'
                  : 'pick a folder, then an agent'}
            </div>
          </div>
        )}

        {error && <div className="error">{error}</div>}
      </div></div>

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
function Fold({ title, count, note, openWhen = false, defaultOpen = false, attention = false, remember, showEmpty = false, actions, children }: {
  title: string; count: number; openWhen?: boolean; children: ReactNode;
  /** A word beside the count - a machine name, the newest thread's age. */
  note?: string;
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
    <div>
      <div className={`section fold${open ? ' open' : ''}${attention ? ' attention' : ''}`}>
        <button
          className="fold-toggle" aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="caret">›</span>{title}<span className="count">{count}</span>
          {note && <span className="note-inline">{note}</span>}
        </button>
        {actions && <span className="fold-actions">{actions}</span>}
      </div>
      {open && children}
    </div>
  );
}

function ProjectActions({ title, onStart, onRename, onRemove }: {
  title: string; onStart: () => void; onRename: () => void; onRemove: () => void;
}) {
  const [menu, setMenu] = useState(false);
  return (
    <>
      <button
        type="button" className="foldbtn"
        title={`new thread in ${title}`} aria-label={`new thread in ${title}`}
        onClick={onStart}
      >+</button>
      <button
        type="button" className="foldbtn"
        title={`actions for ${title}`} aria-label={`actions for ${title}`}
        onClick={() => setMenu((v) => !v)}
      >⋯</button>
      {menu && (
        <div className="menu">
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
function SessionRow({ s, onOpen, onRename, onArchive, onDelete, busy, selecting = false, marked = false, onToggle }: {
  s: Session; onOpen?: () => void; onRename?: (title: string) => void;
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
  const [menu, setMenu] = useState(false);
  const [naming, setNaming] = useState(false);
  const [ending, setEnding] = useState(false);
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
              {adopted && <span className="tag">external</span>}
              {s.archived && <span className="tag">archived</span>}
            </span>
            <span className="rm">
              {[eng.label, s.model, shortPath(s.cwd), money(s.costUsd)].filter(Boolean).join(' · ')}
            </span>
          </span>
          {(s.pending ?? 0) > 1 && <span className="badge">{s.pending}</span>}
          {busy ? <span className="chip working"><i />opening</span> : <StatusChip status={s.status} at={s.updatedAt} />}
        </Main>
        {!selecting && managed && (
          <>
            <button
              className="rowend" title="thread actions" aria-label={`actions for ${s.title}`}
              onClick={(e) => { e.stopPropagation(); setMenu((open) => !open); }}
            >⋯</button>
            {menu && (
              <div className="menu row-menu" onClick={(e) => e.stopPropagation()}>
                {onRename && !adopted && (
                  <button onClick={() => { setMenu(false); setNaming(true); }}>Rename thread</button>
                )}
                {onArchive && (
                  <button onClick={() => { setMenu(false); onArchive(); }}>
                    {s.archived ? 'Unarchive thread' : 'Archive thread'}
                  </button>
                )}
                {onDelete && (
                  <button className="destructive" onClick={() => { setMenu(false); setEnding(true); }}>
                    {found ? 'Remove from helm' : adopted ? 'Close this pane' : 'Delete thread'}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
      {naming && onRename && (
        <TextPrompt
          title="Name this thread" value={s.title}
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
            ? `${eng.label} keeps the conversation - helm just stops listing it.`
            : adopted
              ? 'This ends the program running in that pane, which helm did not start.'
              : 'This ends the agent and permanently removes the thread from helm.'}
          confirmLabel={found ? 'remove' : adopted ? 'close' : 'delete'} danger
          onCancel={() => setEnding(false)}
          onConfirm={() => { setEnding(false); onDelete(); }}
        />
      )}
    </>
  );
}

function StatusChip({ status, at }: { status: string; at?: number }) {
  // `at` is when the thread entered this status: "working" gains "14m",
  // which is the difference between a turn that just started and one that
  // has been chewing for a while. Under a minute it says nothing - the
  // word alone is already the whole story.
  const now = useNow();
  const ago = at ? waitingSince(at, now) : '';
  const age = ago && ago !== 'just now' ? ` ${ago}` : '';
  if (status === 'blocked') return <span className="chip blocked"><i />waiting{age}</span>;
  if (status === 'working') return <span className="chip working"><i />working{age}</span>;
  if (status === 'done') return <span className="chip done"><i />done</span>;
  if (status === 'exited') return <span className="chip exited">ended</span>;
  return null;
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

  const title = picking ? 'Brain' : 'The brain';
  const sub = picking ? `on ${env.name}` : `${engineOf(brain!.engine).label} on ${env.name}`;

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" onClick={onBack}>‹</button>
        <div className="titles"><h1>{title}</h1><span className="sub">{sub}</span></div>
      </div>
      <div className="scroll"><div className="pad column">
        {picking ? (
          <>
            <p className="note">
              A brain sees every machine and every running session, and acts
              on them through the <code>helm</code> command - so it can answer
              "what is waiting on me", read a thread on another machine, or
              start one. This one runs on {env.name}; anything it does
              elsewhere it does by talking to that machine. Each machine can
              have one, and the one on the machine that is always up is the
              one that is there when your laptop is not.
            </p>
            {replacing && (
              <div className="banner warn">
                Starting a different brain on {env.name} ends the current one
                and everything it has learned about your network.
              </div>
            )}
            <div className="section">its brain</div>
            {!accounts && !error && env.online && <div className="empty quiet">asking {env.name}…</div>}
            <div className="rows">
              {(accounts ?? []).map((a) => (
                <button key={a.key} className="row tall" disabled={!!busy} onClick={() => start(a)}>
                  <EngineMark engine={engineOf(a.engine).cls} />
                  <span className="grow">
                    <span className="rt">{engineOf(a.engine).label}</span>
                    <span className="rm">{[a.account, a.prefs?.default].filter(Boolean).join(' · ')}</span>
                  </span>
                  {busy === a.key ? <span className="chip working"><i />starting</span> : <span className="chev">›</span>}
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
                      <span className="rt">{models?.labels?.[m] ?? m}</span>
                      {current && <span className="rm">what it thinks with now</span>}
                    </span>
                    {busy === m ? <span className="chip working"><i />changing</span> : current ? <span className="tag key">current</span> : <span className="chev">›</span>}
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
                  <span className="rm">ends this one and everything it has learned</span>
                </span>
                <span className="chev">›</span>
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

const startSummary = (a: Account) => {
  const values = [
    a.prefs?.default?.replace(/^[^/]+\//, ''),
    a.defaults?.effort,
    a.defaults?.mode,
    a.defaults?.speed,
  ].filter(Boolean);
  return values.length ? `starts ${values.join(' · ')}` : "starts with the CLI's defaults";
};

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
        <button className="iconbtn back" onClick={onBack}>‹</button>
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
                    <span className="chev">›</span>
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
        <button className="iconbtn back" onClick={onBack}>‹</button>
        <div className="titles"><h1>Settings</h1><span className="sub">{env.name}</span></div>
      </div>
      <div className="scroll"><div className="pad column">
        <div className="section">name</div>
        <MachineName client={client} env={env} onRenamed={onRenamed} />

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
                <span className="chev">›</span>
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
function ModelPrefsView({ client, env, account, onBack }: {
  client: Client; env: Environment; account: Account; onBack: () => void;
}) {
  const [list, setList] = useState<ModelList | null>(null);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [def, setDef] = useState('');
  const [effort, setEffort] = useState(account.defaults?.effort ?? '');
  const [mode, setMode] = useState(account.defaults?.mode ?? '');
  const [speed, setSpeed] = useState(account.defaults?.speed ?? '');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const eng = engineOf(account.engine);

  useEffect(() => {
    let stale = false;
    const take = (r: ModelList, remembered?: boolean) => {
      if (stale) return;
      setList(r);
      setApproved(new Set(r.prefs?.approved ?? []));
      setDef(r.prefs?.default ?? '');
      if (!remembered) saveModels(env.id, account.profile.id, r, true);
    };
    // Paint the catalogue this device already knows - the whole list, which is
    // the slowest thing the app asks for - and let the real answer replace it.
    loadModels(env.id, account.profile.id, true).then((c) => { if (c && !list) take(c, true); });
    client.rpc(env.id, 'model.list', { profileId: account.profile.id, all: true }, 45_000)
      .then((r: ModelList) => take(r))
      .catch((e) => { if (!stale && !list) setError(e.message); });
    return () => { stale = true; };
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
        }, 20_000),
        client.rpc(env.id, 'profile.defaults', {
          profileId: account.profile.id,
          effort: effort || null,
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
  const efforts = [...new Set([
    ...(list?.effortsByModel?.[selectedModel] ?? list?.efforts ?? []),
    ...(effort ? [effort] : []),
  ])];
  const speeds = [...new Set([
    ...(list?.speedByModel?.[selectedModel] ?? list?.speeds ?? []),
    ...(speed ? [speed] : []),
  ])];
  const modes = [...(list?.modes ?? [])];
  if (mode && !modes.some((m) => m.id === mode)) modes.push({ id: mode, label: mode });

  const row = (m: string, checked: boolean) => (
    <button key={m} className={`row tall${checked ? ' active' : ''}`} onClick={() => toggle(m)}>
      <span className="grow">
        <span className="rt">{list?.labels?.[m] ?? m}</span>
        {(list?.labels?.[m] && list.labels[m] !== m) && <span className="rm">{m}</span>}
        {!all.includes(m) && <span className="rm">not offered by the CLI anymore</span>}
      </span>
      {checked && <span className="check">✓</span>}
    </button>
  );

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" onClick={onBack}>‹</button>
        <div className="titles"><h1>CLI defaults</h1><span className="sub">{eng.label} · {account.account} · {env.name}</span></div>
      </div>
      <div className="scroll"><div className="pad column">
        {list === null && !error && <div className="empty quiet">asking the CLI for its models…</div>}

        {list !== null && (
          <>
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
                  <option value="">the CLI's default</option>
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

function Browse({ client, env, path, title = 'Where?', action = 'Start here', onBack, onInto, onPick }: {
  client: Client; env: Environment; path?: string; title?: string; action?: string;
  onBack: () => void; onInto: (p: string) => void; onPick: (p: string) => void | Promise<void>;
}) {
  const [entries, setEntries] = useState<DirEntry[]>([]);
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
  const RECENT = `helm-folders:${env.id}`;
  const [recent] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(RECENT) || '[]'); } catch { return []; }
  });
  const pick = async (p: string) => {
    try {
      const next = [p, ...recent.filter((r) => r !== p)].slice(0, 6);
      localStorage.setItem(RECENT, JSON.stringify(next));
    } catch { /* full */ }
    setError(''); setPicking(true);
    try { await onPick(p); }
    catch (e: any) { setError(e.message); }
    finally { setPicking(false); }
  };

  const load = useCallback(() => {
    setError('');
    client.rpc(env.id, 'fs.list', { path: path ?? '~' })
      .then((r: any) => { setEntries(r.entries); setHere(r.path); })
      .catch((e) => setError(e.message));
  }, [client, env.id, path]);

  useEffect(() => { load(); }, [load]);

  // The machine indexes its folders once, so a query answered from memory
  // costs a debounce and a round trip rather than a disk walk per letter.
  const q = query.trim();
  useEffect(() => {
    if (!q) { setHits(null); return; }
    const t = setTimeout(() => {
      client.rpc(env.id, 'fs.search', { query: q }, 20_000)
        .then((r: any) => { setHits(r.results ?? []); setIndexed(r.indexed ?? 0); })
        .catch((e) => { setHits([]); setError(e.message); });
    }, 250);
    return () => clearTimeout(t);
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
        <button className="iconbtn back" onClick={onBack}>‹</button>
        <div className="titles"><h1>{title}</h1><span className="sub">{here}</span></div>
      </div>
      <div className="scroll"><div className="pad column">
        <button className="primary big" disabled={picking} onClick={() => pick(here)}>
          {picking ? 'working…' : action}
        </button>

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
                <span className={`glyph${h.repo ? ' repo' : ''}`}>{h.repo ? '◆' : '▸'}</span>
                <span className="grow">
                  <span className="rt">{h.name}</span>
                  <span className="rm">{h.path}</span>
                </span>
                <span className="chev">›</span>
              </button>
            ))}
            {hits === null
              ? <div className="empty quiet">{indexed ? 'searching…' : 'indexing folders…'}</div>
              : !hits.length && <div className="empty quiet">nothing matches{indexed ? ` · ${indexed} folders indexed` : ''}</div>}
          </div>
        ) : (
          <>
            {/* Only on the way in: once you are browsing, the list on screen
                already says where you are. */}
            {!path && recent.length > 0 && (
              <>
                <div className="section">recent</div>
                <div className="rows">
                  {recent.slice(0, 3).map((p) => (
                    <button key={p} className="row" onClick={() => pick(p)}>
                      <span className="glyph repo">◆</span>
                      <span className="grow">
                        <span className="rt">{shortPath(p)}</span>
                        <span className="rm">{p}</span>
                      </span>
                      <span className="chev">›</span>
                    </button>
                  ))}
                </div>
              </>
            )}

            <div className="section">
              folders<span className="spacer" />
              <button className="linkish" onClick={() => setCreating((v) => !v)}>
                {creating ? 'cancel' : '+ new folder'}
              </button>
            </div>

            {creating && (
              <div className="inline-form">
                <input
                  autoFocus value={folder} placeholder="folder name"
                  onChange={(e) => setFolder(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') makeFolder(); }}
                />
                <button className="send" onClick={makeFolder} disabled={!folder.trim()}>↑</button>
              </div>
            )}

            <div className="rows">
              {entries.map((e) => (
                <button key={e.path} className="row" onClick={() => onInto(e.path)}>
                  <span className={`glyph${e.isRepo ? ' repo' : ''}`}>{e.isRepo ? '◆' : '▸'}</span>
                  <span className="grow"><span className="rt">{e.name}</span></span>
                  <span className="chev">›</span>
                </button>
              ))}
              {!entries.length && !error && <div className="empty quiet">no subfolders</div>}
            </div>
          </>
        )}
        {error && <div className="error">{error}</div>}
      </div></div>
    </>
  );
}

// -------------------------------------------------------------------- start

const PREFS = 'helm.prefs';
type Prefs = Record<string, { account?: string }>;
const loadPrefs = (): Prefs => { try { return JSON.parse(localStorage.getItem(PREFS) || '{}'); } catch { return {}; } };
const savePrefs = (p: Prefs) => { try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch { /* full */ } };

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
function Start({ client, env, cwd, onBack, onStarted }: {
  client: Client; env: Environment; cwd: string;
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

  useEffect(() => {
    client.rpc(env.id, 'profile.list')
      .then((r: any) => {
        const list = accountsFrom(r.profiles);
        setAccounts(list);
        const remembered = prefs.current[env.id]?.account;
        setKey(list.find((a) => a.key === remembered)?.key ?? list[0]?.key ?? '');
      })
      .catch((e) => setError(e.message));
  }, [client, env.id]);

  const account = accounts?.find((a) => a.key === key) ?? null;

  // The defaults belong to the machine/account, not this browser, so opening
  // the same picker from a phone or laptop starts the same CLI configuration.
  useEffect(() => {
    if (!account) return;
    setModel(account.prefs?.default ?? '');
    setEffort(account.defaults?.effort ?? '');
    setMode(account.defaults?.mode ?? '');
    setSpeed(account.defaults?.speed ?? '');
  }, [account?.key]);

  const start = async () => {
    if (!account) return;
    setBusy(true); setError('');
    prefs.current = {
      ...prefs.current,
      [env.id]: { account: account.key },
    };
    savePrefs(prefs.current);
    try {
      const r = await client.rpc<{ session: Session }>(env.id, 'session.start', {
        cwd, profileId: account.profile.id,
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
        <button className="iconbtn back" onClick={onBack}>‹</button>
        <div className="titles"><h1>New session</h1><span className="sub">{cwd}</span></div>
      </div>
      <div className="scroll"><div className="pad column">
        <div className="section">agent</div>
        {accounts === null && <div className="empty quiet">looking for agents…</div>}
        <div className="rows">
          {accounts?.map((a) => {
            const e = engineOf(a.engine);
            return (
              <button key={a.key} className={`row tall${a.key === key ? ' active' : ''}`} onClick={() => setKey(a.key)}>
                <EngineMark engine={e.cls} />
                <span className="grow">
                  <span className="rt">{e.label} <span className="dim">· {a.account}</span>{a.token && <span className="tag key">token</span>}</span>
                  <span className="rm">{a.aliases.join(', ')}</span>
                </span>
                {a.key === key && <span className="check">✓</span>}
              </button>
            );
          })}
        </div>
        {accounts?.length === 0 && (
          <div className="empty quiet">
            no agents on {env.name}
            <div className="note" style={{ marginTop: 6 }}>install claude, codex, opencode or devin there and run <code>helm profiles --refresh</code></div>
          </div>
        )}

        {account && (
          <>
            <div className="note start-note">
              Model, thinking, permissions and speed are all changeable inside
              the session.
            </div>

            <button className="primary big" disabled={busy} onClick={start} style={{ marginTop: 22 }}>
              {busy ? 'starting…' : `Start ${eng?.label}`}
            </button>
          </>
        )}
        {error && <div className="error">{error}</div>}
      </div></div>
    </>
  );
}

// ------------------------------------------------------------------ session

function SessionView({ client, env, session, onBack, onClosed, onArchived, onSession, onTranscribe }: {
  client: Client; env: Environment; session: Session;
  onBack: () => void; onClosed: () => void; onArchived: () => void; onSession: (s: Session) => void;
  /** Absent when no machine in the network holds a Groq key. */
  onTranscribe?: (audio: string, mime: string) => Promise<string>;
}) {
  const isShell = session.engine === 'shell';
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [raw, setRaw] = useState(isShell);
  const [status, setStatus] = useState(session.status);
  // When it entered the status it is in, for "working 14m" beside the word.
  const [statusAt, setStatusAt] = useState(session.updatedAt);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [menu, setMenu] = useState(false);
  const eng = engineOf(session.engine);

  // Read back from the CLI's own transcript, so this chat costs a round trip
  // to say anything at all. Paint the copy on the device first: what you read
  // last time is a better opening than a blank screen, and the refresh behind
  // it is usually a second or two.
  const refresh = useCallback(async () => {
    if (isShell) return;
    try {
      const r = await client.rpc<{ messages: Message[] }>(env.id, 'session.messages', { id: session.id }, 15_000);
      setMessages(r.messages);
      saveMessages(env.id, session.id, r.messages);
    } catch (e: any) { setError(e.message); }
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
      if (e !== env.id) return;
      if (kind === 'session.transcript' && payload?.id === session.id) refresh();
      if (kind === 'session.update' && payload.session?.id === session.id) {
        setStatus(payload.session.status);
        setStatusAt(payload.session.updatedAt ?? Date.now());
        refresh();
      }
    });
    return off;
  }, [client, env.id, session.id, refresh]);

  // The transcript events above are the live stream; the poll is only the
  // reconciliation for a frame that got lost, so it can be slow - and a
  // transcript whose process is gone cannot change at all.
  useLiveInterval(status === 'exited' ? null : 15_000, refresh, [status, refresh]);

  const send = async () => {
    const body = draft;
    if (!body.trim()) return;
    setDraft('');
    setMessages((m) => m ? [...m, { role: 'user', text: body, tools: [], at: Date.now() }] : m);
    try { await client.rpc(env.id, 'session.input', { id: session.id, data: body + '\n' }); }
    catch (e: any) { setError(e.message); setDraft(body); }
    setTimeout(refresh, 600);
  };

  const key = async (k: string) => {
    try { await client.rpc(env.id, 'session.keys', { id: session.id, keys: [k] }); }
    catch (e: any) { setError(e.message); }
  };

  const [killing, setKilling] = useState(false);
  const [naming, setNaming] = useState(false);

  const kill = async () => {
    try { await client.rpc(env.id, 'session.kill', { id: session.id }); onClosed(); }
    catch (e: any) { setError(e.message); }
  };

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

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" onClick={onBack}>‹</button>
        <div className="titles">
          <h1>{session.title}</h1>
          <span className="sub">{eng.label}{(session as any).model ? ` · ${(session as any).model}` : ''} · {env.name}</span>
        </div>
        <StatusChip status={status} at={statusAt} />
        {!isShell && (
          <button className="iconbtn mono" title={raw ? 'conversation' : 'terminal'} onClick={() => setRaw((v) => !v)}>
            {raw ? '¶' : '❯_'}
          </button>
        )}
        <button className="iconbtn" title="more" onClick={() => setMenu((v) => !v)}>⋯</button>
        {menu && (
          <div className="menu" onClick={() => setMenu(false)}>
            <button onClick={() => setNaming(true)}>Rename thread</button>
            <button onClick={archive}>{session.archived ? 'Unarchive thread' : 'Archive thread'}</button>
            <button className="destructive" onClick={() => setKilling(true)}>Delete thread</button>
          </div>
        )}
      </div>

      {naming && (
        <TextPrompt
          title="Name this thread" value={session.title}
          onCancel={() => setNaming(false)} onSubmit={renameThread}
        />
      )}
      {killing && (
        <Confirm
          title={`Delete "${session.title}"?`}
          body="The agent process is closed and the thread is removed from helm."
          confirmLabel="Delete" danger
          onCancel={() => setKilling(false)}
          onConfirm={() => { setKilling(false); kill(); }}
        />
      )}

      {raw
        ? <Suspense fallback={<div className="xterm-host" />}>
            <Terminal client={client} env={env.id} sessionId={session.id} />
          </Suspense>
        : <Chat messages={messages} status={status} />}

      {!raw && (
        <Composer
          onTranscribe={onTranscribe}
          draft={draft} setDraft={setDraft} onSend={send} onKey={key}
          waiting={status === 'blocked'} engine={eng.label}
          history={(messages ?? []).filter((message) => message.role === 'user').map((message) => message.text)}
        />
      )}
      {error && <div className="error floating">{error}</div>}
    </>
  );
}

// --------------------------------------------------------------------- chat

const TOOL_GLYPH: Record<string, string> = {
  Read: '◎', Write: '✎', Edit: '✎', MultiEdit: '✎', Bash: '❯', Grep: '⌕', Glob: '⌕',
  WebFetch: '⇣', WebSearch: '⌕', Task: '⚙', Agent: '⚙', shell: '❯', apply_patch: '✎',
};
const toolGlyph = (name: string) =>
  TOOL_GLYPH[name] ?? (/read|cat|view/i.test(name) ? '◎'
    : /search|grep|glob|list|find/i.test(name) ? '⌕'
    : /write|edit|patch|create/i.test(name) ? '✎'
    : /bash|shell|exec|run|command/i.test(name) ? '❯' : '⚙');

function ago(ts: number | null | undefined) {
  if (!ts || !Number.isFinite(ts)) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 0 || s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function Chat({ messages, status }: { messages: Message[] | null; status: string }) {
  const box = useRef<HTMLDivElement>(null);
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
          {messages?.map((m, i) => <Turn key={i} m={m} />)}
          {status === 'working' && <div className="working"><span className="shine">Working…</span></div>}
        </div>
      </div>
      {unread && <button className="jump" onClick={jump}>↓ new</button>}
    </div>
  );
}

function Turn({ m }: { m: Message }) {
  if (m.role === 'user') {
    return (
      <div className="turn user">
        <div className="bubble">{m.text}</div>
      </div>
    );
  }
  const many = m.tools.length > 3;
  const rows = m.tools.map((t, j) => (
    <div key={j} className="act">
      <span className="aicon">{toolGlyph(t.name)}</span>
      <span className="alabel"><b>{t.name}</b>{t.input && <> {t.input}</>}</span>
    </div>
  ));
  return (
    <div className="turn assistant">
      {m.tools.length > 0 && (many
        ? <details className="actgroup"><summary><span className="aicon">⚙</span><span className="alabel">{m.tools.length} steps</span><span className="achev">›</span></summary>{rows}</details>
        : rows)}
      {m.text && <Markdown text={m.text} className="prose" />}
      {!m.text && !m.tools.length && m.thinking && <div className="act"><span className="aicon">◌</span><span className="alabel">Thinking</span></div>}
    </div>
  );
}
