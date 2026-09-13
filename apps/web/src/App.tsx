import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from './Terminal';
import { Markdown } from './Markdown';
import {
  Client, login,
  type Environment, type Profile, type Session, type DirEntry, type Message,
} from './client';

const STORE = 'helm.auth';

type Auth = { endpoints: string[]; token: string; deviceId?: string };
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

function loadAuth(): Auth | null {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (!raw?.token) return null;
    if (Array.isArray(raw.endpoints)) return raw;
    return raw.relay ? { endpoints: [raw.relay], token: raw.token } : null;
  } catch {
    return null;
  }
}

const saveAuth = (a: Auth) => localStorage.setItem(STORE, JSON.stringify(a));

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
 * What a profile *is*, for a human: which CLI, on which account, with which
 * flags. The alias name it came from is kept as a footnote - `claudeaa` means
 * something to the person who typed it, and nothing to anyone else.
 */
function describeProfile(p: Profile) {
  const engine = engineOf(p.engine);
  const homes = Object.values(p.env ?? {}).filter((v) => /^[~/]/.test(v));
  const home = homes[0];
  let account = 'default account';
  if (home) {
    const leaf = home.split('/').pop() ?? '';
    const suffix = leaf.replace(/^\.?(claude|codex|opencode|config)-?/, '');
    account = suffix ? `${suffix} account` : 'default account';
  }
  const tokenVars = (p.envFrom ?? []).filter((k) => /TOKEN|KEY/i.test(k));
  const flags = (p.args ?? []).join(' ');
  return { engine, account, token: tokenVars.length > 0, flags, alias: p.id };
}

const shortPath = (p: string) => {
  const parts = p.replace(/\/$/, '').split('/');
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : p;
};

// ---------------------------------------------------------------------- app

export function App() {
  const [auth, setAuth] = useState<Auth | null>(loadAuth);
  const [client, setClient] = useState<Client | null>(null);
  const [online, setOnline] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!auth) return;
    const c = new Client(auth.endpoints, auth.token);
    const off = c.on((_e, kind, payload) => {
      if (kind === 'connection') setOnline(payload.online);
      if (kind === 'endpoints') saveAuth({ ...auth, endpoints: payload.endpoints });
      if (kind === 'unauthorized') {
        localStorage.removeItem(STORE);
        setNotice('This device is no longer in the network. Pair it again with a fresh link.');
        setAuth(null); setClient(null);
      }
    });
    c.connect().catch(() => {});
    setClient(c);
    return () => { off(); c.close?.(); };
  }, [auth]);

  const signOut = () => { localStorage.removeItem(STORE); setAuth(null); setClient(null); };

  if (!auth) {
    return <Login notice={notice} onDone={(a) => { setNotice(''); saveAuth(a); setAuth(a); }} />;
  }
  if (!client) return <div className="empty">connecting…</div>;
  return <Shell client={client} online={online} onSignOut={signOut} />;
}

// ------------------------------------------------------------------- shell

type MainView =
  | { kind: 'env' }
  | { kind: 'browse'; path?: string }
  | { kind: 'profiles'; cwd: string }
  | { kind: 'session'; session: Session };

function Shell({ client, online, onSignOut }: {
  client: Client; online: boolean; onSignOut: () => void;
}) {
  const wide = useWide();
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [sessions, setSessions] = useState<Record<string, Session[]>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [stack, setStack] = useState<MainView[]>([{ kind: 'env' }]);
  const [error, setError] = useState('');

  const loadEnvs = useCallback(() => {
    client.environments()
      .then((r) => setEnvs(r.environments))
      .catch((e) => setError(e.message));
  }, [client]);

  const loadSessions = useCallback((envId: string) => {
    client.rpc<{ sessions: Session[] }>(envId, 'session.list', {}, 15_000)
      .then((r) => setSessions((s) => ({ ...s, [envId]: r.sessions })))
      .catch(() => {});
  }, [client]);

  useEffect(() => {
    loadEnvs();
    return client.on((e, kind) => {
      if (kind === 'presence') loadEnvs();
      if (kind === 'session.update' && e) loadSessions(e);
    });
  }, [loadEnvs, loadSessions, client]);

  // Every machine's sessions, so "needs you" can be answered from the
  // sidebar without visiting each machine. The push keeps it current; the
  // timer is the safety net for a lost event.
  useEffect(() => {
    const live = envs.filter((e) => e.online);
    for (const e of live) { client.subscribe(e.id); loadSessions(e.id); }
    const timer = setInterval(() => { for (const e of live) loadSessions(e.id); }, 15_000);
    return () => clearInterval(timer);
  }, [envs, client, loadSessions]);

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

  const blocked = envs.flatMap((e) =>
    (sessions[e.id] ?? []).filter((s) => s.status === 'blocked').map((s) => ({ env: e, s })));
  const showMain = wide || !!selected;

  return (
    <div className="shell">
      <aside className={`sidebar${!showMain ? ' showing' : ''}`}>
        <div className="bar">
          <div className="brand">
            <img src="/icon.svg" alt="" />
            <div>
              <b>helm</b>
              <div className="count">
                {online ? `${envs.filter((e) => e.online).length} of ${envs.length} online` : 'reconnecting…'}
              </div>
            </div>
          </div>
          <button className="iconbtn" onClick={onSignOut} title="sign out">⏻</button>
        </div>

        <div className="scroll">
          <div className="pad">
            {!online && <div className="banner offline">no machine reachable — retrying</div>}

            {blocked.length > 0 && (
              <>
                <div className="section attention">needs you</div>
                <div className="list">
                  {blocked.map(({ env: e, s }) => (
                    <button key={s.id} className="card blocked-card" onClick={() => openSession(e.id, s)}>
                      <span className={`mark ${engineOf(s.engine).cls}`}>{engineOf(s.engine).mark}</span>
                      <span className="grow">
                        <div className="name">{s.title}</div>
                        <div className="meta">{e.name} · {shortPath(s.cwd)}</div>
                      </span>
                      <span className="pill blocked">waiting</span>
                    </button>
                  ))}
                </div>
              </>
            )}

            <div className="section">machines</div>
            <div className="list">
              {envs.map((e) => {
                const list = (sessions[e.id] ?? []).filter((s) => s.engine !== 'shell');
                const working = list.filter((s) => s.status === 'working').length;
                const waiting = list.filter((s) => s.status === 'blocked').length;
                return (
                  <button
                    key={e.id}
                    className={`card${e.id === selected && wide ? ' selected' : ''}`}
                    onClick={() => openEnv(e.id)}
                  >
                    <span className={`dot ${e.online ? 'on' : 'off'}`} />
                    <span className="grow">
                      <div className="name">{e.name}</div>
                      <div className="meta">
                        {e.online
                          ? (list.length
                            ? `${list.length} session${list.length === 1 ? '' : 's'}${working ? ` · ${working} working` : ''}`
                            : [e.info.platform, e.info.arch].filter(Boolean).join('/') || 'online')
                          : e.lastSeen ? `last seen ${ago(e.lastSeen)}` : 'never connected'}
                      </div>
                    </span>
                    {waiting > 0 && <span className="badge">{waiting}</span>}
                    <span className="chev">›</span>
                  </button>
                );
              })}
              {!envs.length && !error && <div className="empty">no machines yet</div>}
            </div>

            <AddMachine client={client} />
            <InstallPwa />
            {error && <div className="error">{error}</div>}
          </div>
        </div>
      </aside>

      <section className={`main${showMain ? ' showing' : ''}`}>
        {!env ? (
          <div className="scroll"><div className="pad">
            <div className="empty">select a machine</div>
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
            onPick={(cwd) => push({ kind: 'profiles', cwd })}
          />
        ) : view.kind === 'profiles' ? (
          <Profiles
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
          {notice && <div className="banner">{notice}</div>}
          {selfHosted ? (
            <div className="pair-ticket">
              <span className="dot on" />
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
            Run <code>helm link</code> on your VM to get a fresh link.
            Pair once; this device stays connected until you remove it.
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
            Run that on the machine you are adding. Expires in 10 minutes, and
            carries the network key — treat it like a password.
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
            {env.info.host ?? ''}
            {env.online ? (direct ? ' · direct' : ' · via home') : ' · offline'}
          </span>
        </div>
        <button className="iconbtn" title="terminal" disabled={!env.online || opening} onClick={openTerminal}>❯_</button>
      </div>

      <div className="scroll"><div className="pad">
        {!env.online && <div className="banner offline">this machine is offline</div>}

        <button className="primary big" style={{ marginTop: 0, marginBottom: 6 }} disabled={!env.online} onClick={onBrowse}>
          + new session
        </button>

        {groups.map(([title, list]) => list.length > 0 && (
          <div key={title}>
            <div className={`section${title === 'needs you' ? ' attention' : ''}`}>{title}</div>
            <div className="list">
              {list.map((s) => <SessionCard key={s.id} s={s} onOpen={() => onOpen(s)} />)}
            </div>
          </div>
        ))}
        {!agents.length && (
          <div className="empty">
            nothing running on {env.name}
            <div className="note" style={{ marginTop: 6 }}>start a session: pick a directory, then an agent</div>
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

function SessionCard({ s, onOpen }: { s: Session; onOpen: () => void }) {
  const eng = engineOf(s.engine);
  return (
    <button className={`card${s.status === 'blocked' ? ' blocked-card' : ''}`} onClick={onOpen}>
      <span className={`mark ${eng.cls}`}>{eng.mark}</span>
      <span className="grow">
        <div className="name">
          {s.title}
          {(s as any).adopted && <span className="tag">external</span>}
        </div>
        <div className="meta">{eng.label} · {shortPath(s.cwd)}{s.updatedAt ? ` · ${ago(s.updatedAt)}` : ''}</div>
      </span>
      <span className={`pill ${s.status}`}>{s.status === 'blocked' ? 'waiting' : s.status}</span>
    </button>
  );
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
        <div className="titles"><h1>where?</h1><span className="sub">{here}</span></div>
      </div>
      <div className="scroll"><div className="pad">
        <button className="primary big" style={{ marginTop: 0 }} onClick={() => onPick(here)}>
          use {shortPath(here)}
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
            <button className="send" onClick={makeFolder} disabled={!folder.trim()}>+</button>
          </div>
        )}

        <div className="list tight">
          {entries.map((e) => (
            <button key={e.path} className="card" onClick={() => onInto(e.path)}>
              <span className={`glyph${e.isRepo ? ' repo' : ''}`}>{e.isRepo ? '◆' : '▸'}</span>
              <span className="grow"><div className="name">{e.name}</div></span>
              <span className="chev">›</span>
            </button>
          ))}
          {!entries.length && !error && <div className="empty">no subfolders</div>}
        </div>
        {error && <div className="error">{error}</div>}
      </div></div>
    </>
  );
}

function Profiles({ client, env, cwd, onBack, onStarted }: {
  client: Client; env: Environment; cwd: string;
  onBack: () => void; onStarted: (s: Session) => void;
}) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    client.rpc(env.id, 'profile.list')
      // A shell is not an agent; the terminal has its own button.
      .then((r: any) => setProfiles(r.profiles.filter((p: any) => !p.disabled && p.engine !== 'shell')))
      .catch((e) => setError(e.message));
  }, [client, env.id]);

  const start = async (p: Profile) => {
    setBusy(p.id); setError('');
    try {
      const r = await client.rpc<{ session: Session }>(env.id, 'session.start',
        { cwd, profileId: p.id }, 70_000);
      onStarted(r.session);
    } catch (e: any) { setError(e.message); setBusy(''); }
  };

  const grouped = useMemo(() => {
    const by = new Map<string, Profile[]>();
    for (const p of profiles) by.set(p.engine, [...(by.get(p.engine) ?? []), p]);
    return [...by.entries()];
  }, [profiles]);

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" onClick={onBack}>‹</button>
        <div className="titles"><h1>which agent?</h1><span className="sub">{cwd}</span></div>
      </div>
      <div className="scroll"><div className="pad">
        {grouped.map(([engine, list]) => (
          <div key={engine}>
            <div className="section">{engineOf(engine).label}</div>
            <div className="list">
              {list.map((p) => {
                const d = describeProfile(p);
                return (
                  <button key={p.id} className="card" disabled={!!busy} onClick={() => start(p)}>
                    <span className={`mark ${d.engine.cls}`}>{d.engine.mark}</span>
                    <span className="grow">
                      <div className="name">
                        {d.account}
                        {d.token && <span className="tag key">token</span>}
                        {busy === p.id && <span className="tag">starting…</span>}
                      </div>
                      <div className="meta">
                        <code>{d.alias}</code>{d.flags && <> · {d.flags}</>}
                      </div>
                    </span>
                    <span className="chev">›</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {!profiles.length && !error && (
          <div className="empty">
            no agents found on {env.name}
            <div className="note" style={{ marginTop: 6 }}>install claude, codex or opencode there, then run <code>helm profiles --refresh</code></div>
          </div>
        )}
        {error && <div className="error">{error}</div>}
      </div></div>
    </>
  );
}

// ------------------------------------------------------------------ session

const QUICK: { label: string; key: string; hint?: string }[] = [
  { label: 'yes', key: 'y' }, { label: 'no', key: 'n' },
  { label: '↵ enter', key: 'Enter' }, { label: 'esc', key: 'Escape' },
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
    // The daemon pushes `session.transcript` as the agent writes; this poll
    // is only the safety net, and what keeps the daemon's watch alive.
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
        <span className={`mark ${eng.cls}`}>{eng.mark}</span>
        <div className="titles">
          <h1>{session.title}</h1>
          <span className="sub">{env.name} · {shortPath(session.cwd)}</span>
        </div>
        <span className={`pill ${status}`}>{status === 'blocked' ? 'waiting' : status}</span>
        {!isShell && (
          <button className="iconbtn" title={raw ? 'conversation' : 'terminal'} onClick={() => setRaw((v) => !v)}>
            {raw ? '💬' : '❯_'}
          </button>
        )}
        <button className="iconbtn" title="more" onClick={() => setMenu((v) => !v)}>⋯</button>
        {menu && (
          <div className="menu" onClick={() => setMenu(false)}>
            <button onClick={kill}>end session</button>
          </div>
        )}
      </div>

      {raw
        ? <Terminal client={client} env={env.id} sessionId={session.id} />
        : <Chat messages={messages} status={status} engine={eng} />}

      {status === 'blocked' && (
        <div className="attention-bar">
          <span className="attention-text">{eng.label} is waiting on you</span>
          <div className="quick">
            {QUICK.slice(0, 4).map((q) => (
              <button key={q.key} onClick={() => key(q.key)}>{q.label}</button>
            ))}
          </div>
        </div>
      )}

      {!raw && (
        <Composer
          draft={draft} setDraft={setDraft} onSend={send} onKey={key}
          placeholder={status === 'blocked' ? 'reply to the agent…' : `message ${eng.label}…`}
        />
      )}
      {error && <div className="error floating">{error}</div>}
    </>
  );
}

function Composer({ draft, setDraft, onSend, onKey, placeholder }: {
  draft: string; setDraft: (v: string) => void; onSend: () => void;
  onKey: (k: string) => void; placeholder: string;
}) {
  const [keys, setKeys] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with the text, up to a few lines, then scroll.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, [draft]);

  return (
    <div className="composer-wrap">
      {keys && (
        <div className="keys">
          {QUICK.map((q) => <button key={q.key} onClick={() => onKey(q.key)}>{q.label}</button>)}
        </div>
      )}
      <div className="composer">
        <button className={`iconbtn keys-toggle${keys ? ' on' : ''}`} title="keys" onClick={() => setKeys((v) => !v)}>⌨</button>
        <textarea
          ref={ref} rows={1} value={draft} placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } }}
        />
        <button className="send" onClick={onSend} disabled={!draft.trim()} title="send">↑</button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------- chat

const TOOL_GLYPH: Record<string, string> = {
  Read: '⌕', Write: '✎', Edit: '✎', MultiEdit: '✎', Bash: '❯', Grep: '⌕', Glob: '⌕',
  WebFetch: '⇣', WebSearch: '⌕', Task: '⚙', Agent: '⚙', shell: '❯', apply_patch: '✎',
};
const toolGlyph = (name: string) =>
  TOOL_GLYPH[name] ?? (/read|search|grep|glob|list|find/i.test(name) ? '⌕'
    : /write|edit|patch|create/i.test(name) ? '✎'
    : /bash|shell|exec|run|command/i.test(name) ? '❯' : '⚙');

function Chat({ messages, status, engine }: {
  messages: Message[] | null; status: string; engine: { label: string; mark: string; cls: string };
}) {
  const box = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [unread, setUnread] = useState(false);

  // Follow the conversation unless the reader scrolled up to look at
  // something, in which case offer a way back down rather than yanking them.
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
        {messages === null && <div className="empty quiet">loading conversation…</div>}
        {messages?.length === 0 && (
          <div className="empty quiet">
            nothing yet
            <div className="note" style={{ marginTop: 6 }}>the conversation appears here as the agent works</div>
          </div>
        )}
        {messages?.map((m, i) => <Turn key={i} m={m} engine={engine} />)}
        {status === 'working' && (
          <div className="turn assistant">
            <span className={`mark ${engine.cls}`}>{engine.mark}</span>
            <div className="body"><div className="working"><i /><i /><i /></div></div>
          </div>
        )}
        <div style={{ height: 8 }} />
      </div>
      {unread && <button className="jump" onClick={jump}>↓ new</button>}
    </div>
  );
}

function Turn({ m, engine }: { m: Message; engine: { label: string; mark: string; cls: string } }) {
  if (m.role === 'user') {
    return (
      <div className="turn user">
        <div className="bubble">{m.text}</div>
      </div>
    );
  }
  const many = m.tools.length > 4;
  const tools = (
    <div className="tools">
      {m.tools.map((t, j) => (
        <div key={j} className="tool">
          <span className="tglyph">{toolGlyph(t.name)}</span>
          <b>{t.name}</b>
          {t.input && <span className="tin">{t.input}</span>}
        </div>
      ))}
    </div>
  );
  return (
    <div className="turn assistant">
      <span className={`mark ${engine.cls}`}>{engine.mark}</span>
      <div className="body">
        {m.tools.length > 0 && (many
          ? <details className="toolgroup"><summary>{m.tools.length} steps</summary>{tools}</details>
          : tools)}
        {m.text && <Markdown text={m.text} />}
        {!m.text && !m.tools.length && m.thinking && <div className="faint">thinking…</div>}
      </div>
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
