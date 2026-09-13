import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from './Terminal';
import { Markdown } from './Markdown';
import { loadAuthSync, loadAuthDurable, saveAuth, clearAuth, type StoredAuth } from './store';
import {
  Client, login,
  type Environment, type Profile, type Session, type DirEntry, type Message,
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

const ENGINE: Record<string, { label: string; mark: string; cls: string }> = {
  claude:   { label: 'Claude Code', mark: 'C', cls: 'claude' },
  codex:    { label: 'Codex',       mark: 'X', cls: 'codex' },
  opencode: { label: 'opencode',    mark: 'O', cls: 'opencode' },
  shell:    { label: 'Terminal',    mark: '❯', cls: 'shell' },
};
const engineOf = (id?: string) => ENGINE[id ?? ''] ?? { label: id ?? 'agent', mark: '·', cls: 'other' };

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
    const suffix = leaf.replace(/^\.?(claude|codex|opencode|config)-?/, '');
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
  const order = ['claude', 'codex', 'opencode'];
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
  const openEnv = (id: string) => { setSelected(id); setStack([{ kind: 'env' }]); };
  const openSession = (envId: string, s: Session) => {
    setSelected(envId);
    setStack([{ kind: 'env' }, { kind: 'session', session: s }]);
  };
  const push = (v: MainView) => setStack((s) => [...s, v]);
  const back = () => {
    if (stack.length > 1) setStack((s) => s.slice(0, -1));
    else setSelected(null);
  };

  const agentsOf = (id: string) => (sessions[id] ?? []).filter((s) => s.engine !== 'shell');
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
          <button className="iconbtn" onClick={onSignOut} title="unpair this device">⏻</button>
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
            <InstallPwa />
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
            client={client} env={env} wide={wide} onBack={back}
            sessions={sessions[env.id] ?? []} reload={() => loadSessions(env.id)}
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
            onStarted={(s) => { loadSessions(env.id); setStack([{ kind: 'env' }, { kind: 'session', session: s }]); }}
          />
        ) : (
          <SessionView
            key={view.session.id}
            client={client} env={env} session={view.session} onBack={back}
            onClosed={() => { loadSessions(env.id); back(); }}
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

  const connect = async (endpoint: string, secret: string) => {
    setBusy(true); setError('');
    try {
      finish(await login(endpoint, secret));
    } catch (err: any) {
      setError(err.message);
      setLinkSecretFailed(true);
      setPassword((p) => (p === secret ? '' : p));
    } finally { setBusy(false); }
  };

  useEffect(() => {
    let cancelled = false;
    fetch(`${location.origin}/api/health`)
      .then((r) => r.ok)
      .then((ok) => { if (!cancelled) setSelfHosted(ok); })
      .catch(() => { if (!cancelled) setSelfHosted(false); });
    return () => { cancelled = true; };
  }, []);

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
  const [usage, setUsage] = useState<any[] | null>(null);
  const [direct, setDirect] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setUsage(null); setError('');
    client.subscribe(env.id);
    reload();
    return client.on((e, kind, payload) => {
      if (e === env.id && kind === 'transport') setDirect(payload.direct);
    });
  }, [client, env.id, reload]);

  useEffect(() => {
    if (env.online) client.openDirect(env.id).catch(() => {});
  }, [client, env.id, env.online]);

  useEffect(() => {
    if (!env.online || !env.info.usage) return;
    client.rpc(env.id, 'usage.get').then((u: any) => setUsage(u.accounts)).catch(() => {});
  }, [client, env.id, env.online, env.info.usage]);

  const openTerminal = async () => {
    setOpening(true); setError('');
    try {
      const existing = sessions.find((s) => s.engine === 'shell' && s.alive !== false);
      if (existing) { onOpen(existing); return; }
      const r = await client.rpc<{ session: Session }>(env.id, 'session.start',
        { cwd: '~', profileId: 'shell', title: 'Terminal' }, 45_000);
      reload();
      onOpen(r.session);
    } catch (e: any) { setError(e.message); }
    finally { setOpening(false); }
  };

  const agents = sessions.filter((s) => s.engine !== 'shell');
  const groups: [string, Session[]][] = [
    ['needs you', agents.filter((s) => s.status === 'blocked')],
    ['working', agents.filter((s) => s.status === 'working')],
    ['idle', agents.filter((s) => !['blocked', 'working', 'exited'].includes(s.status))],
    ['finished', agents.filter((s) => s.status === 'exited')],
  ];

  return (
    <>
      <div className="bar">
        {!wide && <button className="iconbtn back" onClick={onBack}>‹</button>}
        <div className="titles">
          <h1>{env.name}</h1>
          <span className="sub">
            {env.online ? (direct ? 'direct connection' : 'via your Helm home') : 'offline'}
            {env.info.host ? ` · ${env.info.host}` : ''}
          </span>
        </div>
        <button className="iconbtn mono" title="terminal" disabled={!env.online || opening} onClick={openTerminal}>❯_</button>
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
              {list.map((s) => <SessionRow key={s.id} s={s} onOpen={() => onOpen(s)} />)}
            </div>
          </div>
        ))}
        {!agents.length && (
          <div className="empty quiet">
            nothing running on {env.name}
            <div className="note" style={{ marginTop: 6 }}>pick a folder, then an agent</div>
          </div>
        )}

        {usage && usage.length > 0 && (
          <>
            <div className="section">usage today</div>
            <div className="usage">{usage.map((a) => <UsageRow key={a.id} account={a} />)}</div>
          </>
        )}
        {error && <div className="error">{error}</div>}
      </div></div>
    </>
  );
}

function SessionRow({ s, onOpen }: { s: Session; onOpen: () => void }) {
  const eng = engineOf(s.engine);
  return (
    <button className="row tall" onClick={onOpen}>
      <span className={`mark ${eng.cls}`}>{eng.mark}</span>
      <span className="grow">
        <span className="rt">
          {s.title}
          {(s as any).adopted && <span className="tag">external</span>}
        </span>
        <span className="rm">{eng.label}{(s as any).model ? ` · ${(s as any).model}` : ''} · {shortPath(s.cwd)}</span>
      </span>
      <StatusChip status={s.status} />
    </button>
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
  return (
    <div className="usage-row">
      <span className="label">{account.label ?? account.id}</span>
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
type Prefs = Record<string, { model?: string; auto?: boolean; effort?: string; account?: string }>;
const loadPrefs = (): Prefs => { try { return JSON.parse(localStorage.getItem(PREFS) || '{}'); } catch { return {}; } };
const savePrefs = (p: Prefs) => { try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch { /* full */ } };

/**
 * One screen to start a session: the account, the model, and whether the
 * agent may act without asking. Everything else the CLI would have wanted on
 * its command line is remembered from last time.
 */
function Start({ client, env, cwd, onBack, onStarted }: {
  client: Client; env: Environment; cwd: string;
  onBack: () => void; onStarted: (s: Session) => void;
}) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [key, setKey] = useState<string>('');
  const [models, setModels] = useState<{ default: string | null; models: string[]; effort?: string | null; efforts?: string[] } | null>(null);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [auto, setAuto] = useState(false);
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

  useEffect(() => {
    if (!account) return;
    setModels(null);
    const p = prefs.current[account.key] ?? {};
    setModel(p.model ?? '');
    setEffort(p.effort ?? '');
    setAuto(p.auto ?? false);
    client.rpc(env.id, 'model.list', { profileId: account.profile.id }, 30_000)
      .then((r: any) => setModels(r))
      .catch(() => setModels({ default: null, models: [] }));
  }, [client, env.id, account?.key]);

  const start = async () => {
    if (!account) return;
    setBusy(true); setError('');
    prefs.current = {
      ...prefs.current,
      [env.id]: { account: account.key },
      [account.key]: { model, effort, auto },
    };
    savePrefs(prefs.current);
    try {
      const r = await client.rpc<{ session: Session }>(env.id, 'session.start', {
        cwd, profileId: account.profile.id,
        model: model || undefined, effort: effort || undefined, auto,
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
                <span className={`mark ${e.cls}`}>{e.mark}</span>
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
            <div className="note" style={{ marginTop: 6 }}>install claude, codex or opencode there and run <code>helm profiles --refresh</code></div>
          </div>
        )}

        {account && (
          <>
            <div className="section">model</div>
            <div className="field">
              <select value={model} onChange={(e) => setModel(e.target.value)} disabled={!models}>
                <option value="">{models ? `default${models.default ? ` (${models.default})` : ''}` : 'loading…'}</option>
                {models?.models.filter((m) => m !== models.default).map((m) => <option key={m} value={m}>{m}</option>)}
                {model && !models?.models.includes(model) && <option value={model}>{model}</option>}
              </select>
            </div>
            <input
              className="custom" value={model} placeholder="or type a model id"
              onChange={(e) => setModel(e.target.value)} autoCapitalize="off" autoCorrect="off"
            />

            {models?.efforts && (
              <>
                <div className="section">reasoning</div>
                <div className="segmented">
                  <button className={effort === '' ? 'on' : ''} onClick={() => setEffort('')}>default{models.effort ? ` (${models.effort})` : ''}</button>
                  {models.efforts.map((x) => (
                    <button key={x} className={effort === x ? 'on' : ''} onClick={() => setEffort(x)}>{x}</button>
                  ))}
                </div>
              </>
            )}

            <div className="section">permissions</div>
            <button className={`row tall toggle${auto ? ' active' : ''}`} onClick={() => setAuto((v) => !v)}>
              <span className="grow">
                <span className="rt">Act without asking</span>
                <span className="rm">
                  {account.engine === 'claude' ? '--permission-mode auto'
                    : account.engine === 'codex' ? '--yolo'
                    : '--auto'}
                  {' · '}fewer interruptions, less oversight
                </span>
              </span>
              <span className={`switch${auto ? ' on' : ''}`}><i /></span>
            </button>

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

const QUICK: { label: string; key: string }[] = [
  { label: 'yes', key: 'y' }, { label: 'no', key: 'n' },
  { label: 'enter', key: 'Enter' }, { label: 'esc', key: 'Escape' },
  { label: '↑', key: 'Up' }, { label: '↓', key: 'Down' },
  { label: 'tab', key: 'Tab' }, { label: '^C', key: 'C-c' },
];

function SessionView({ client, env, session, onBack, onClosed }: {
  client: Client; env: Environment; session: Session;
  onBack: () => void; onClosed: () => void;
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
    if (!confirm(`End "${session.title}"? The agent process is closed.`)) return;
    try { await client.rpc(env.id, 'session.kill', { id: session.id }); onClosed(); }
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
            <button onClick={kill}>End session</button>
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

function Composer({ draft, setDraft, onSend, onKey, waiting, engine }: {
  draft: string; setDraft: (v: string) => void; onSend: () => void;
  onKey: (k: string) => void; waiting: boolean; engine: string;
}) {
  const [keys, setKeys] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  }, [draft]);

  return (
    <div className="composer-wrap">
      <div className="composer-col">
        {waiting && (
          <div className="docked warn">
            <span className="docked-text"><i className="sdot blocked" />Waiting on you</span>
            <span className="docked-actions">
              {QUICK.slice(0, 4).map((q) => <button key={q.key} onClick={() => onKey(q.key)}>{q.label}</button>)}
            </span>
          </div>
        )}
        <div className="slab">
          <textarea
            ref={ref} rows={1} value={draft}
            placeholder={waiting ? 'Reply to the agent…' : `Message ${engine}…`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } }}
          />
          <div className="slab-foot">
            <button className={`ctl${keys ? ' on' : ''}`} onClick={() => setKeys((v) => !v)}>⌨ keys</button>
            <span className="spacer" />
            <button className="send" onClick={onSend} disabled={!draft.trim()} title="send">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </div>
          {keys && (
            <div className="keys">
              {QUICK.map((q) => <button key={q.key} onClick={() => onKey(q.key)}>{q.label}</button>)}
            </div>
          )}
        </div>
      </div>
    </div>
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

function ago(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
