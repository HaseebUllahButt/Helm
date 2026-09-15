import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from './Terminal';
import { Markdown } from './Markdown';
import { Composer } from './session/Composer';
import { DrivenSession } from './session/DrivenSession';
import { EngineMark } from './EngineMark';
import { loadAuthSync, loadAuthDurable, saveAuth, clearAuth, type StoredAuth } from './store';
import {
  Client, login,
  type Environment, type Profile, type Session, type DirEntry, type Message, type ModelList,
} from './client';

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
const engineOf = (id?: string) => ENGINE[id ?? ''] ?? { label: id ?? 'agent', cls: 'other' };

/**
 * An account is a CLI plus the home directory (or credential) it runs with.
 * A shell full of aliases yields the same account many times over, each with
 * different flags - `d`, `codexp`, `codexpx` are all "Codex, personal". The
 * flags are choices to make when starting, not separate things to pick from,
 * so collapse the aliases to accounts and keep the plainest alias of each as
 * the one to launch.
 */
/**
 * What the usage panel knows. `off` is "there is nothing to ask" (the
 * machine is not online); `absent` is "asked, and this machine runs no
 * usage dashboard". Both used to render as nothing, which is how a panel
 * that was working looked exactly like one that was not.
 */
type UsageState =
  | { kind: 'off' }
  | { kind: 'absent' }
  | { kind: 'loading' }
  | { kind: 'ready'; accounts: any[]; fetchedAt?: number | string }
  | { kind: 'failed'; error: string };

interface Account {
  key: string;
  engine: string;
  account: string;
  token: boolean;
  profile: Profile;
  aliases: string[];
}

function accountsFrom(profiles: Profile[]): Account[] {
  const by = new Map<string, Account>();
  for (const p of profiles) {
    if (p.engine === 'shell' || (p as any).disabled) continue;
    const home = Object.values(p.env ?? {}).find((v) => /^[~/]/.test(v));
    // Engine + home + credential is what makes an account; an alias that
    // also unsets a variable is the same account with a different mood.
    const key = [p.engine, home ?? '', [...(p.envFrom ?? [])].sort().join(',')].join('|');
    const leaf = home?.split('/').pop() ?? '';
    const suffix = leaf.replace(/^\.?(claude|codex|opencode|devin|config)-?/, '');
    const existing = by.get(key);
    if (existing) {
      existing.aliases.push(p.id);
      // Fewest arguments = the plainest way to launch this account.
      if ((p.args ?? []).length < (existing.profile.args ?? []).length) existing.profile = p;
      continue;
    }
    by.set(key, {
      key, engine: p.engine,
      account: suffix || 'default',
      token: (p.envFrom ?? []).some((k) => /TOKEN|KEY/i.test(k)),
      profile: p, aliases: [p.id],
    });
  }
  const order = ['claude', 'codex', 'opencode', 'devin'];
  return [...by.values()].sort((a, b) =>
    (order.indexOf(a.engine) - order.indexOf(b.engine)) || a.account.localeCompare(b.account));
}

const shortPath = (p: string) => {
  const parts = p.replace(/\/$/, '').split('/');
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : p;
};

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
  | { kind: 'browse'; path?: string }
  | { kind: 'start'; cwd: string }
  | { kind: 'session'; session: Session };

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

  useEffect(() => {
    history.replaceState({ helm: 1, ...nav.current }, '');
    const onPop = (e: PopStateEvent) => {
      const s = e.state;
      if (!s?.helm) return;
      nav.current = { stack: s.stack, selected: s.selected, depth: s.depth };
      setStack(s.stack);
      setSelected(s.selected);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /** A real move: new view, new history entry, phone-back returns from it. */
  const navigate = (next: MainView[], sel = nav.current.selected) => {
    const depth = nav.current.depth + 1;
    nav.current = { stack: next, selected: sel, depth };
    setStack(next);
    setSelected(sel);
    history.pushState({ helm: 1, depth, stack: next, selected: sel }, '');
  };

  /** Same place, fresher snapshot: session records change under a view. */
  const restate = (next: MainView[]) => {
    nav.current = { ...nav.current, stack: next };
    setStack(next);
    history.replaceState({ helm: 1, depth: nav.current.depth, stack: next, selected: nav.current.selected }, '');
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
          setEnvs((list) => list.map((m) => (m.id === e ? { ...m, online: !!payload.online } : m)));
        } else loadEnvs();
      }
      if (kind === 'connection' && payload.online) loadEnvs();
      if (kind === 'session.update' && e) loadSessions(e);
    });
  }, [loadEnvs, loadSessions, client]);

  const liveIds = envs.filter((e) => e.online).map((e) => e.id).join(',');
  useEffect(() => {
    const live = liveIds ? liveIds.split(',') : [];
    for (const id of live) { client.subscribe(id); loadSessions(id); }
    const timer = setInterval(() => { for (const id of live) loadSessions(id); }, 15_000);
    return () => clearInterval(timer);
  }, [liveIds, client, loadSessions]);

  useEffect(() => {
    if (wide && !selected && envs.length) setSelected(envs[0].id);
  }, [wide, selected, envs]);

  const env = envs.find((e) => e.id === selected) ?? null;
  const view = stack[stack.length - 1];

  // Stable per machine. Handed to EnvView, which lists it as an effect
  // dependency: a fresh arrow on every render re-ran that effect, which
  // re-subscribed, re-listed the sessions and blanked the usage panel, and
  // the listing then re-rendered us - so the panel appeared and vanished
  // several times a second.
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
  const push = (v: MainView) => navigate([...nav.current.stack, v]);
  const back = () => {
    // One history entry per push, so any stack deeper than its root has
    // somewhere to pop to. At the root there is no such entry; there the ‹
    // means "back to the machine list" on a phone and nothing on desktop.
    if (nav.current.depth > 0) history.back();
    else if (!wide) setSelected(null);
  };

  const agentsOf = (id: string) => (sessions[id] ?? []).filter((s) => s.engine !== 'shell' && !s.archived);
  const blocked = envs.flatMap((e) => agentsOf(e.id).filter((s) => s.status === 'blocked').map((s) => ({ env: e, s })));
  const showMain = wide || !!selected;

  // Honest connection words. A dropped socket with a hub that still answers
  // HTTP is "reconnecting", quietly; only a long silence from everything
  // deserves red.
  const downFor = downSince ? Date.now() - downSince : 0;
  const status = conn.online ? 'live' : conn.reachable ? 'reconnecting' : downFor > 12_000 ? 'offline' : 'connecting';
  const hubHost = (() => { try { return new URL(client.relay).host; } catch { return client.relay; } })();

  return (
    <div className="shell">
      <aside className={`sidebar${!showMain ? ' showing' : ''}`}>
        <div className="bar side">
          <div className="brand">
            <img src="/icon.svg" alt="" />
            <b>helm</b>
          </div>
          <span className={`conn ${status}`} title={conn.error || status}>
            <i />{status === 'live' ? `${envs.filter((e) => e.online).length}/${envs.length} online` : status}
          </span>
        </div>

        <div className="scroll">
          <div className="side-pad">
            {status === 'offline' && (
              <div className="banner error">
                No machine answered for a while. Check the VM, or that this phone has internet.
              </div>
            )}

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

            <div className="section">machines</div>
            <div className="rows">
              {envs.map((e) => {
                const list = agentsOf(e.id);
                const working = list.filter((s) => s.status === 'working').length;
                const waiting = list.filter((s) => s.status === 'blocked').length;
                return (
                  <button
                    key={e.id}
                    className={`row${e.id === selected && wide ? ' active' : ''}`}
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
                  </button>
                );
              })}
              {!envs.length && !error && <div className="empty quiet">no machines yet</div>}
            </div>

            <AddMachine client={client} />
            <Notifications client={client} />
            <InstallPwa />
            <button className="linkish quiet-link" onClick={() => {
              if (confirm('Unpair this device? You will need a fresh link from `helm link` to sign back in.')) onSignOut();
            }}>unpair this device</button>
            {error && <div className="error">{error}</div>}
          </div>
          <div className="diag">
            <span>{hubHost || 'no hub'}</span>
            <span>{conn.online ? 'socket live' : conn.error || 'socket down'}</span>
          </div>
        </div>
      </aside>

      <section className={`main${showMain ? ' showing' : ''}`}>
        {!env ? (
          <div className="scroll"><div className="pad">
            <div className="empty quiet">select a machine</div>
          </div></div>
        ) : view.kind === 'env' ? (
          <EnvView
            key={env.id}
            client={client} env={env} wide={wide} onBack={back}
            sessions={sessions[env.id] ?? []} reload={reloadEnv}
            onBrowse={() => push({ kind: 'browse' })}
            onOpen={(s) => push({ kind: 'session', session: s })}
          />
        ) : view.kind === 'browse' ? (
          <Browse
            client={client} env={env} path={view.path} onBack={back}
            onInto={(path) => push({ kind: 'browse', path })}
            onPick={(cwd) => push({ kind: 'start', cwd })}
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
            client={client} env={env}
            session={(sessions[env.id] ?? []).find((s) => s.id === view.session.id) ?? view.session}
            onBack={back}
            onClosed={() => { loadSessions(env.id); back(); }}
            onArchived={() => { loadSessions(env.id); back(); }}
            onSession={(s) => {
              loadSessions(env.id);
              restate(nav.current.stack.map((v) => (v.kind === 'session' && v.session.id === s.id ? { kind: 'session', session: { ...v.session, ...s } } : v)));
            }}
          />
        ) : (
          <SessionView
            key={view.session.id}
            client={client} env={env} session={view.session} onBack={back}
            onClosed={() => { loadSessions(env.id); back(); }}
            onArchived={() => { loadSessions(env.id); back(); }}
          />
        )}
      </section>
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

  // The other direction: the app was installed from the VM's public address
  // but a daemon is also running on this computer - it signs in on its own,
  // so point there rather than asking for a code.
  const [localHelm, setLocalHelm] = useState<string | null>(null);
  useEffect(() => {
    if (isLocal) return;
    fetch('http://127.0.0.1:8787/api/health', { cache: 'no-store' })
      .then((r) => { if (r.ok) setLocalHelm('http://127.0.0.1:8787'); })
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
          {localHelm && (
            <p className="note" style={{ marginTop: 14, textAlign: 'center' }}>
              A helm is running on this computer - it signs in on its own:{' '}
              <a href={localHelm}>open its own address</a>
            </p>
          )}
          <p className="note" style={{ marginTop: 14, textAlign: 'center' }}>
            Run <code>helm link</code> on your VM for a fresh link.
            Pair once; this device stays paired until you remove it.
          </p>
        </form>
      </div>
    </div>
  );
}

function AddMachine({ client }: { client: Client }) {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState('');

  return (
    <>
      <div className="section">add a computer</div>
      {code ? (
        <>
          <div className="code">{code}</div>
          <pre className="snippet">helm join {code} {client.relay}</pre>
          <p className="note" style={{ marginTop: 8 }}>
            Run that on the machine you are adding. Expires in 10 minutes and
            carries the network key: treat it like a password.
          </p>
        </>
      ) : (
        <button
          className="ghost"
          onClick={() => client.invite().then((r) => setCode(r.code)).catch((e) => setError(e.message))}
        >
          create join code
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
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setState(sub ? 'on' : 'off'))
      .catch(() => setState('off'));
  }, []);

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
      <div className="section">when a session is blocked</div>
      {state === 'blocked' ? (
        <p className="note">
          Notifications are blocked for this site. Turn them back on in the
          browser&rsquo;s settings for this address, then reload.
        </p>
      ) : (
        <button className="ghost" disabled={busy} onClick={state === 'on' ? disable : enable}>
          {busy ? 'one moment\u2026' : state === 'on' ? 'stop notifying this device' : 'notify this device'}
        </button>
      )}
      {error && <p className="note">{error}</p>}
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
      <div className="section">this device</div>
      {offer ? (
        <button className="ghost" onClick={async () => {
          await offer.prompt();
          await offer.userChoice;
          setOffer(null);
        }}>install Helm app</button>
      ) : (
        <p className="note install-note">On iPhone or iPad: tap Share, then Add to Home Screen.</p>
      )}
    </>
  );
}

// --------------------------------------------------------------- one machine

function EnvView({ client, env, wide, sessions, reload, onBack, onBrowse, onOpen }: {
  client: Client; env: Environment; wide: boolean; sessions: Session[];
  reload: () => void; onBack: () => void; onBrowse: () => void; onOpen: (s: Session) => void;
}) {
  const [usage, setUsage] = useState<UsageState>({ kind: 'off' });
  const [direct, setDirect] = useState(false);
  const [ping, setPing] = useState<number | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');

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

  useEffect(() => {
    if (env.online) client.openDirect(env.id).catch(() => {});
  }, [client, env.id, env.online]);

  // Kept fresh while you are looking at the machine. The numbers come from a
  // dashboard on that machine, which can be absent or slow, so every one of
  // those outcomes gets said out loud rather than rendering an empty gap.
  useEffect(() => {
    if (!env.online) { setUsage({ kind: 'off' }); return; }
    let live = true;
    // `env.info.usage` is a snapshot: the daemon probes for the dashboard
    // once, when it attaches to its hub. A dashboard started after that -
    // which is the normal order, since it is a separate service - would
    // never appear, so a "no" is re-asked of the machine itself rather than
    // believed from the roster, and asked again on every refresh.
    let has = env.info.usage;
    const tick = async (first: boolean) => {
      if (first) setUsage((u) => (u.kind === 'ready' ? u : { kind: 'loading' }));
      if (!has) {
        try { has = !!((await client.rpc(env.id, 'env.info')) as any)?.usage; }
        catch { has = false; }
        if (!live) return;
        if (!has) { setUsage({ kind: 'absent' }); return; }
      }
      try {
        const u: any = await client.rpc(env.id, 'usage.get');
        if (live) setUsage({ kind: 'ready', accounts: u.accounts ?? [], fetchedAt: u.fetchedAt });
      } catch (e: any) {
        if (!live) return;
        // Re-probe next time round: a dashboard that has gone away should
        // settle into "none here", not repeat an error nobody can act on.
        has = false;
        setUsage((was) => (was.kind === 'ready' ? was : { kind: 'failed', error: e.message }));
      }
    };
    tick(true);
    const timer = setInterval(() => tick(false), 60_000);
    return () => { live = false; clearInterval(timer); };
  }, [client, env.id, env.online, env.info.usage]);

  const openTerminal = async () => {
    setOpening(true); setError('');
    try {
      // Always a fresh shell: an earlier terminal is something to go back to,
      // not something to be dropped into - it lists under "terminals" below,
      // where it can be reopened or closed.
      const count = sessions.filter((s) => s.pty).length;
      const r = await client.rpc<{ session: Session }>(env.id, 'session.start',
        { cwd: '~', profileId: 'shell', title: `Terminal ${count + 1}` }, 45_000);
      reload();
      onOpen(r.session);
    } catch (e: any) { setError(e.message); }
    finally { setOpening(false); }
  };

  const agents = sessions.filter((s) => s.engine !== 'shell' && !s.archived);
  const archived = sessions.filter((s) => s.engine !== 'shell' && s.archived);
  const groups: [string, Session[]][] = [
    ['needs you', agents.filter((s) => s.status === 'blocked')],
    ['working', agents.filter((s) => s.status === 'working')],
    ['idle', agents.filter((s) => !['blocked', 'working', 'exited'].includes(s.status))],
    ['finished', agents.filter((s) => s.status === 'exited')],
    ['terminals', sessions.filter((s) => s.pty && s.alive !== false)],
  ];

  const setArchived = async (s: Session, archived: boolean) => {
    setError('');
    try { await client.rpc(env.id, 'session.archive', { id: s.id, archived }, 20_000); reload(); }
    catch (e: any) { setError(e.message); }
  };

  const deleteSession = async (s: Session) => {
    setError('');
    try { await client.rpc(env.id, 'session.kill', { id: s.id }, 20_000); reload(); }
    catch (e: any) { setError(e.message); }
  };

  return (
    <>
      <div className="bar">
        {!wide && <button className="iconbtn back" onClick={onBack}>‹</button>}
        <div className="titles">
          <h1>{env.name}</h1>
          <span className="sub">
            {env.online ? (direct ? 'direct connection' : 'via your Helm home') : 'offline'}
            {env.online && ping != null && (
              // The number matters because the two routes differ by two
              // orders of magnitude, and a relayed phone that feels broken
              // is usually just far away. Saying so is the difference
              // between "helm is slow" and "this connection is slow".
              <span className={ping > 250 ? 'quiet slow' : 'quiet'}> · {Math.round(ping)}ms</span>
            )}
            {env.info.host ? ` · ${env.info.host}` : ''}
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
      </div>

      <div className="scroll"><div className="pad column">
        {!env.online && <div className="banner warn">this machine is offline</div>}

        <button className="primary big" disabled={!env.online} onClick={onBrowse}>
          New session
        </button>

        {groups.map(([title, list]) => list.length > 0 && (
          <div key={title}>
            <div className={`section${title === 'needs you' ? ' attention' : ''}`}>{title}</div>
            <div className="rows">
              {list.map((s) => (
                <SessionRow
                  key={s.id} s={s} onOpen={() => onOpen(s)}
                  onArchive={() => setArchived(s, true)}
                  onDelete={() => deleteSession(s)}
                />
              ))}
            </div>
          </div>
        ))}
        {archived.length > 0 && (
          <div>
            <div className="section">archived</div>
            <div className="rows">
              {archived.map((s) => (
                <SessionRow
                  key={s.id} s={s} onOpen={() => onOpen(s)}
                  onArchive={() => setArchived(s, false)}
                  onDelete={() => deleteSession(s)}
                />
              ))}
            </div>
          </div>
        )}
        {!agents.length && (
          <div className="empty quiet">
            {archived.length ? 'no active sessions' : `nothing running on ${env.name}`}
            <div className="note" style={{ marginTop: 6 }}>pick a folder, then an agent</div>
          </div>
        )}

        {usage.kind !== 'off' && (
          <>
            <div className="section">
              usage today
              {usage.kind === 'ready' && !!ago(usage.fetchedAt) && (
                <span className="quiet"> · {ago(usage.fetchedAt)}</span>
              )}
            </div>
            {usage.kind === 'loading' && <div className="empty quiet">reading usage…</div>}
            {usage.kind === 'absent' && (
              <div className="empty quiet">
                no usage dashboard on {env.name}
                <div className="note" style={{ marginTop: 6 }}>numbers come from cc-usage-dashboard on that machine</div>
              </div>
            )}
            {usage.kind === 'failed' && <div className="empty quiet">usage unavailable — {usage.error}</div>}
            {usage.kind === 'ready' && (
              usage.accounts.length
                ? <div className="usage">{usage.accounts.map((a) => <UsageRow key={a.id} account={a} />)}</div>
                : <div className="empty quiet">no accounts reported</div>
            )}
          </>
        )}
        {error && <div className="error">{error}</div>}
      </div></div>
    </>
  );
}

/**
 * A session in the list with actions to archive or permanently remove it.
 *
 * The row is a div rather than a button because it holds a second button:
 * a conversation you are done with should be manageable from the list, not
 * only from inside it. An agent helm did not start is left alone - helm
 * does not own that process and has no business ending it.
 */
function SessionRow({ s, onOpen, onArchive, onDelete }: {
  s: Session; onOpen: () => void; onArchive?: () => void; onDelete?: () => void;
}) {
  const eng = engineOf(s.engine);
  const adopted = (s as any).adopted;
  const [menu, setMenu] = useState(false);
  const managed = !adopted && (!!onArchive || !!onDelete);
  return (
    <div className="row tall rowx">
      <button className="rowmain" onClick={onOpen}>
        <EngineMark engine={eng.cls} />
        <span className="grow">
          <span className="rt">
            {s.title}
            {adopted && <span className="tag">external</span>}
          </span>
          <span className="rm">{eng.label}{s.model ? ` · ${s.model}` : ''} · {shortPath(s.cwd)}</span>
        </span>
        {(s.pending ?? 0) > 1 && <span className="badge">{s.pending}</span>}
        <StatusChip status={s.status} />
      </button>
      {managed && (
        <>
          <button
            className="rowend" title="thread actions" aria-label={`actions for ${s.title}`}
            onClick={(e) => { e.stopPropagation(); setMenu((open) => !open); }}
          >⋯</button>
          {menu && (
            <div className="menu row-menu" onClick={(e) => e.stopPropagation()}>
              {onArchive && (
                <button onClick={() => { setMenu(false); onArchive(); }}>
                  {s.archived ? 'Unarchive thread' : 'Archive thread'}
                </button>
              )}
              {onDelete && (
                <button className="destructive" onClick={() => {
                  setMenu(false);
                  if (confirm(`Delete "${s.title}"? This ends the agent and permanently removes the thread from helm.`)) onDelete();
                }}>Delete thread</button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  if (status === 'blocked') return <span className="chip blocked"><i />waiting</span>;
  if (status === 'working') return <span className="chip working"><i />working</span>;
  if (status === 'done') return <span className="chip done"><i />done</span>;
  if (status === 'exited') return <span className="chip exited">ended</span>;
  return null;
}

function UsageRow({ account }: { account: any }) {
  const w = account.rateLimits?.session ?? account.rateLimits?.windows?.[0];
  const pct = Math.round(w?.percent ?? w?.pct ?? 0);
  const cls = pct >= 90 ? 'full' : pct >= 70 ? 'high' : '';
  // The dashboard calls most accounts "default", so a panel that showed the
  // label alone was six rows reading "default" and one reading "2". The
  // provider is the part that tells them apart; the label only earns its
  // place when it says something the provider does not.
  const name = [
    account.provider ?? account.id,
    account.label && account.label !== 'default' ? account.label : null,
  ].filter(Boolean).join(' · ');
  return (
    <div className="usage-row" title={account.planLabel ? `${name} · ${account.planLabel}` : name}>
      <span className="label">{name}</span>
      <span className="cost">${(account.today?.cost ?? 0).toFixed(2)}</span>
      {w && (
        <>
          <span className="meter"><i className={cls} style={{ width: `${Math.min(pct, 100)}%` }} /></span>
          <span className="cost" style={{ width: 32, textAlign: 'right' }}>{pct}%</span>
        </>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- browsing

function Browse({ client, env, path, onBack, onInto, onPick }: {
  client: Client; env: Environment; path?: string;
  onBack: () => void; onInto: (p: string) => void; onPick: (p: string) => void;
}) {
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [here, setHere] = useState(path ?? '~');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [folder, setFolder] = useState('');

  const load = useCallback(() => {
    setError('');
    client.rpc(env.id, 'fs.list', { path: path ?? '~' })
      .then((r: any) => { setEntries(r.entries); setHere(r.path); })
      .catch((e) => setError(e.message));
  }, [client, env.id, path]);

  useEffect(() => { load(); }, [load]);

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
        <div className="titles"><h1>Where?</h1><span className="sub">{here}</span></div>
      </div>
      <div className="scroll"><div className="pad column">
        <button className="primary big" onClick={() => onPick(here)}>
          Start here
        </button>

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
        {error && <div className="error">{error}</div>}
      </div></div>
    </>
  );
}

// -------------------------------------------------------------------- start

const PREFS = 'helm.prefs';
type Prefs = Record<string, { model?: string; auto?: boolean; effort?: string; account?: string; mode?: string }>;
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
  const [auto, setAuto] = useState(false);
  const [mode, setMode] = useState('');
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

  // What this account ran with last time. The session can change all of it,
  // so these are a starting point, not a question.
  useEffect(() => {
    if (!account) return;
    const p = prefs.current[account.key] ?? {};
    setModel(p.model ?? '');
    setEffort(p.effort ?? '');
    setAuto(p.auto ?? false);
    setMode(p.mode ?? '');
  }, [account?.key]);

  const start = async () => {
    if (!account) return;
    setBusy(true); setError('');
    prefs.current = {
      ...prefs.current,
      [env.id]: { account: account.key },
      [account.key]: { model, effort, auto, mode },
    };
    savePrefs(prefs.current);
    try {
      const r = await client.rpc<{ session: Session }>(env.id, 'session.start', {
        cwd, profileId: account.profile.id,
        model: model || undefined, effort: effort || undefined, auto, mode: mode || undefined,
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

function SessionView({ client, env, session, onBack, onClosed, onArchived }: {
  client: Client; env: Environment; session: Session;
  onBack: () => void; onClosed: () => void; onArchived: () => void;
}) {
  const isShell = session.engine === 'shell';
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [raw, setRaw] = useState(isShell);
  const [status, setStatus] = useState(session.status);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [menu, setMenu] = useState(false);
  const eng = engineOf(session.engine);

  const refresh = useCallback(async () => {
    if (isShell) return;
    try {
      const r = await client.rpc<{ messages: Message[] }>(env.id, 'session.messages', { id: session.id }, 15_000);
      setMessages(r.messages);
    } catch (e: any) { setError(e.message); }
  }, [client, env.id, session.id, isShell]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5_000);
    const off = client.on((e, kind, payload) => {
      if (e !== env.id) return;
      if (kind === 'session.transcript' && payload?.id === session.id) refresh();
      if (kind === 'session.update' && payload.session?.id === session.id) {
        setStatus(payload.session.status);
        refresh();
      }
    });
    return () => { clearInterval(timer); off(); };
  }, [client, env.id, session.id, refresh]);

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

  const kill = async () => {
    if (!confirm(`Delete "${session.title}"? The agent process is closed and the thread is removed from helm.`)) return;
    try { await client.rpc(env.id, 'session.kill', { id: session.id }); onClosed(); }
    catch (e: any) { setError(e.message); }
  };

  const archive = async () => {
    setMenu(false);
    try { await client.rpc(env.id, 'session.archive', { id: session.id, archived: !session.archived }); onArchived(); }
    catch (e: any) { setError(e.message); }
  };

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" onClick={onBack}>‹</button>
        <div className="titles">
          <h1>{session.title}</h1>
          <span className="sub">{eng.label}{(session as any).model ? ` · ${(session as any).model}` : ''} · {env.name}</span>
        </div>
        <StatusChip status={status} />
        {!isShell && (
          <button className="iconbtn mono" title={raw ? 'conversation' : 'terminal'} onClick={() => setRaw((v) => !v)}>
            {raw ? '¶' : '❯_'}
          </button>
        )}
        <button className="iconbtn" title="more" onClick={() => setMenu((v) => !v)}>⋯</button>
        {menu && (
          <div className="menu" onClick={() => setMenu(false)}>
            <button onClick={archive}>{session.archived ? 'Unarchive thread' : 'Archive thread'}</button>
            <button className="destructive" onClick={kill}>Delete thread</button>
          </div>
        )}
      </div>

      {raw
        ? <Terminal client={client} env={env.id} sessionId={session.id} />
        : <Chat messages={messages} status={status} />}

      {!raw && (
        <Composer
          draft={draft} setDraft={setDraft} onSend={send} onKey={key}
          waiting={status === 'blocked'} engine={eng.label}
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

// -------------------------------------------------------------------- utils

/**
 * How long ago, in words. Takes epoch milliseconds or an ISO timestamp:
 * helm's own events carry a number, but the usage dashboard reports
 * `fetchedAt` as an ISO string, and subtracting that from `Date.now()`
 * rendered the panel's one piece of provenance as "NaNd ago".
 */
function ago(ts: number | string | undefined | null) {
  const at = typeof ts === 'string' ? Date.parse(ts) : ts;
  if (!at || !Number.isFinite(at)) return '';
  const s = Math.floor((Date.now() - at) / 1000);
  if (s < 0) return 'just now';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
