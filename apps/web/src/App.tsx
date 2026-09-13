import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from './Terminal';
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

/**
 * Read the stored sign-in.
 *
 * Earlier versions stored a single `relay` address, which tied a device to
 * one machine. Migrate those forward rather than signing people out: being
 * signed out by an upgrade is exactly the thing this release is fixing.
 */
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

type MainView =
  | { kind: 'env' }
  | { kind: 'browse'; path?: string }
  | { kind: 'profiles'; cwd: string }
  | { kind: 'session'; session: Session };

export function App() {
  const [auth, setAuth] = useState<Auth | null>(loadAuth);
  const [client, setClient] = useState<Client | null>(null);
  const [online, setOnline] = useState(false);

  useEffect(() => {
    if (!auth) return;
    const c = new Client(auth.endpoints, auth.token);
    const off = c.on((_e, kind, payload) => {
      if (kind === 'connection') setOnline(payload.online);
      // Addresses the network taught us about are worth keeping: they are
      // what this device will try next time, after the machine it signed in
      // through has gone away.
      if (kind === 'endpoints') saveAuth({ ...auth, endpoints: payload.endpoints });
    });
    c.connect().catch(() => {});
    setClient(c);
    return () => { off(); c.close?.(); };
  }, [auth]);

  const signOut = () => { localStorage.removeItem(STORE); setAuth(null); setClient(null); };

  if (!auth) {
    return <Login onDone={(a) => { saveAuth(a); setAuth(a); }} />;
  }
  if (!client) return <div className="empty">connecting…</div>;
  return <Shell client={client} online={online} onSignOut={signOut} />;
}

// ------------------------------------------------------------------- shell

function Shell({ client, online, onSignOut }: {
  client: Client; online: boolean; onSignOut: () => void;
}) {
  const wide = useWide();
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [stack, setStack] = useState<MainView[]>([{ kind: 'env' }]);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    client.environments()
      .then((r) => setEnvs(r.environments))
      .catch((e) => setError(e.message));
  }, [client]);

  useEffect(() => {
    load();
    return client.on((_e, kind) => { if (kind === 'presence') load(); });
  }, [load, client]);

  // On a wide screen there is always a pane to fill, so pick something.
  useEffect(() => {
    if (wide && !selected && envs.length) setSelected(envs[0].id);
  }, [wide, selected, envs]);

  const env = envs.find((e) => e.id === selected) ?? null;
  const view = stack[stack.length - 1];
  const open = (id: string) => { setSelected(id); setStack([{ kind: 'env' }]); };
  const push = (v: MainView) => setStack((s) => [...s, v]);
  const pop = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));

  const back = () => {
    if (stack.length > 1) pop();
    else setSelected(null); // back out to the machine list on a phone
  };

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
                {envs.filter((e) => e.online).length} of {envs.length} online
              </div>
            </div>
          </div>
          <button className="iconbtn" onClick={onSignOut} title="sign out">⏻</button>
        </div>

        <div className="scroll">
          <div className="pad">
            {!online && <div className="banner offline">no machine reachable — retrying</div>}

            <div className="list">
              {envs.map((e) => (
                <button
                  key={e.id}
                  className={`card${e.id === selected && wide ? ' selected' : ''}`}
                  onClick={() => open(e.id)}
                >
                  <span className={`dot ${e.online ? 'on' : 'off'}`} />
                  <span className="grow">
                    <div className="name">{e.name}</div>
                    <div className="meta">
                      {e.online
                        ? [e.info.platform, e.info.arch].filter(Boolean).join('/') || 'online'
                        : e.lastSeen ? `last seen ${ago(e.lastSeen)}` : 'never connected'}
                    </div>
                  </span>
                  <span className="chev">›</span>
                </button>
              ))}
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
            onStarted={(s) => setStack([{ kind: 'env' }, { kind: 'session', session: s }])}
          />
        ) : (
          <SessionView client={client} env={env} session={view.session} onBack={back} />
        )}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------- login

function Login({ onDone }: { onDone: (a: Auth) => void }) {
  const openedWith = useRef(pairingTarget(location.href));
  const autoStarted = useRef(false);
  const [link, setLink] = useState('');
  const [password, setPassword] = useState(() => openedWith.current?.password || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selfHosted, setSelfHosted] = useState<boolean | null>(null);
  // Once the secret carried in the link is rejected - typically because it
  // expired - stop treating the link as a credential and let the person type
  // a fresh code instead of leaving them stuck behind a hidden field.
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
      // Reveal the code field and drop the spent secret, so a fresh code from
      // `helm link` can be typed without hunting for a new link to open.
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

  // A pairing link opened on the VM-hosted PWA should complete in one tap.
  // The ref prevents React StrictMode's development re-run from adding the
  // same browser twice.
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
  // A typed code wins over one carried in the link, which may have expired.
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
          <p>one place for every coding agent</p>
        </div>

        <form onSubmit={submit}>
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

function EnvView({ client, env, wide, onBack, onBrowse, onOpen }: {
  client: Client; env: Environment; wide: boolean;
  onBack: () => void; onBrowse: () => void; onOpen: (s: Session) => void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [usage, setUsage] = useState<any[] | null>(null);
  const [direct, setDirect] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    client.rpc<{ sessions: Session[] }>(env.id, 'session.list')
      .then((r) => setSessions(r.sessions))
      .catch((e) => setError(e.message));
  }, [client, env.id]);

  // Keyed on the machine's id, not the `env` object: the environment list is
  // rebuilt on every presence event, and keying on object identity made any
  // machine coming or going clear this machine's visible sessions and redo
  // the direct connection for no reason.
  useEffect(() => {
    setSessions([]); setUsage(null); setError('');
    client.subscribe(env.id);
    load();
    return client.on((e, kind, payload) => {
      if (e !== env.id) return;
      if (kind === 'session.update') load();
      if (kind === 'transport') setDirect(payload.direct);
    });
  }, [client, env.id, load]);

  useEffect(() => {
    if (env.online) client.openDirect(env.id).catch(() => {});
  }, [client, env.id, env.online]);

  useEffect(() => {
    if (!env.online || !env.info.usage) return;
    client.rpc(env.id, 'usage.get').then((u: any) => setUsage(u.accounts)).catch(() => {});
  }, [client, env.id, env.online, env.info.usage]);

  // A safety net under the event push: if a session.update is lost in
  // transit, the list still corrects itself in seconds rather than never.
  useEffect(() => {
    if (!env.online) return;
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [env.online, load]);

  const openTerminal = async () => {
    setOpening(true); setError('');
    try {
      const existing = sessions.find((s) => s.engine === 'shell' && s.alive !== false);
      if (existing) { onOpen(existing); return; }
      const r = await client.rpc<{ session: Session }>(env.id, 'session.start',
        { cwd: '~', profileId: 'shell', title: 'Terminal' }, 45_000);
      onOpen(r.session);
    } catch (e: any) { setError(e.message); }
    finally { setOpening(false); }
  };

  return (
    <>
      <div className="bar">
        {!wide && <button className="iconbtn back" onClick={onBack}>‹</button>}
        <div className="titles">
          <h1>{env.name}</h1>
          <span className="sub">
            {env.info.host ?? ''}
            {env.online ? (direct ? ' · direct' : ' · relayed') : ' · offline'}
          </span>
        </div>
      </div>

      <div className="scroll"><div className="pad">
        {!env.online && <div className="banner offline">this machine is offline</div>}

        <button className="card" disabled={!env.online || opening} onClick={openTerminal}>
          <span className="glyph">❯_</span>
          <span className="grow">
            <div className="name">{opening ? 'opening…' : 'Terminal'}</div>
            <div className="meta">a shell on {env.name}</div>
          </span>
          <span className="chev">›</span>
        </button>

        <div className="section">
          sessions<span className="spacer" />
          <button className="linkish" onClick={onBrowse} disabled={!env.online}>+ new</button>
        </div>

        <div className="list">
          {sessions.map((s) => (
            <button key={s.id} className="card" onClick={() => onOpen(s)}>
              <span className="grow">
                <div className="name">
                  {s.title}
                  {(s as any).adopted && <span className="tag">external</span>}
                </div>
                <div className="meta">{s.engine} · {s.cwd}</div>
              </span>
              <span className={`pill ${s.status}`}>{s.status}</span>
            </button>
          ))}
          {!sessions.length && <div className="empty">nothing running</div>}
        </div>

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
        <div className="titles"><h1>choose a directory</h1><span className="sub">{here}</span></div>
      </div>
      <div className="scroll"><div className="pad">
        <button className="primary" style={{ marginTop: 0 }} onClick={() => onPick(here)}>
          start here — {here}
        </button>

        <div className="section">
          subdirectories<span className="spacer" />
          <button className="linkish" onClick={() => setCreating((v) => !v)}>
            {creating ? 'cancel' : '+ new folder'}
          </button>
        </div>

        {creating && (
          <div className="composer" style={{ padding: 0, border: 0, background: 'none', marginBottom: 10 }}>
            <input
              autoFocus value={folder} placeholder="folder name"
              onChange={(e) => setFolder(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') makeFolder(); }}
            />
            <button className="send" onClick={makeFolder} disabled={!folder.trim()}>+</button>
          </div>
        )}

        <div className="list">
          {entries.map((e) => (
            <button key={e.path} className="card" onClick={() => onInto(e.path)}>
              <span className="glyph">{e.isRepo ? '◆' : '▸'}</span>
              <span className="grow"><div className="name">{e.name}</div></span>
              <span className="chev">›</span>
            </button>
          ))}
          {!entries.length && !error && <div className="empty">no subdirectories</div>}
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
      .then((r: any) => setProfiles(r.profiles.filter((p: any) => !p.disabled)))
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

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" onClick={onBack}>‹</button>
        <div className="titles"><h1>choose an agent</h1><span className="sub">{cwd}</span></div>
      </div>
      <div className="scroll"><div className="pad">
        <div className="list">
          {profiles.map((p) => (
            <button key={p.id} className="card" disabled={!!busy} onClick={() => start(p)}>
              <span className="grow">
                <div className="name">
                  {p.label}{busy === p.id && ' — starting…'}
                  {(p.envFrom ?? []).length > 0 && <span className="tag">key</span>}
                </div>
                <div className="meta">
                  {[p.cmd, ...(p.args ?? [])].join(' ')}
                  {Object.entries(p.env ?? {}).map(([k, v]) => ` · ${k}=${v}`)}
                </div>
              </span>
            </button>
          ))}
          {!profiles.length && !error && <div className="empty">no profiles found</div>}
        </div>
        {error && <div className="error">{error}</div>}
      </div></div>
    </>
  );
}

// ------------------------------------------------------------------ session

const KEYS: [string, string][] = [
  ['esc', 'Escape'], ['↵', 'Enter'], ['tab', 'Tab'],
  ['↑', 'Up'], ['↓', 'Down'], ['^C', 'C-c'], ['y', 'y'], ['n', 'n'],
];

function SessionView({ client, env, session, onBack }: {
  client: Client; env: Environment; session: Session; onBack: () => void;
}) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [raw, setRaw] = useState(session.engine === 'shell');
  const [status, setStatus] = useState(session.status);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (raw) return;
    try {
      const r = await client.rpc<{ messages: Message[] }>(env.id, 'session.messages', { id: session.id });
      setMessages(r.messages);
    } catch (e: any) { setError(e.message); }
  }, [client, env.id, session.id, raw]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, status === 'working' ? 1500 : 3000);
    const off = client.on((e, kind, payload) => {
      if (e !== env.id || kind !== 'session.update') return;
      if (payload.session?.id === session.id) { setStatus(payload.session.status); refresh(); }
    });
    return () => { clearInterval(timer); off(); };
  }, [client, env.id, session.id, refresh, status]);

  const send = async () => {
    const body = draft;
    if (!body.trim()) return;
    setDraft('');
    try { await client.rpc(env.id, 'session.input', { id: session.id, data: body + '\n' }); }
    catch (e: any) { setError(e.message); setDraft(body); }
    setTimeout(refresh, 500);
  };

  const key = async (k: string) => {
    try { await client.rpc(env.id, 'session.keys', { id: session.id, keys: [k] }); }
    catch (e: any) { setError(e.message); }
    setTimeout(refresh, 400);
  };

  const isShell = session.engine === 'shell';

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" onClick={onBack}>‹</button>
        <div className="titles"><h1>{session.title}</h1><span className="sub">{session.cwd}</span></div>
        {!isShell && (
          <button className="iconbtn" title={raw ? 'conversation' : 'terminal'} onClick={() => setRaw((v) => !v)}>
            {raw ? '💬' : '❯_'}
          </button>
        )}
        <span className={`pill ${status}`}>{status}</span>
      </div>

      {status === 'blocked' && (
        <div style={{ padding: '12px 18px 0' }}>
          <div className="banner">this agent is waiting on you</div>
        </div>
      )}

      {raw
        ? <Terminal client={client} env={env.id} sessionId={session.id} status={status} />
        : <Chat messages={messages} />}

      {!raw && (
        <>
          <div className="keys">
            {KEYS.map(([label, k]) => <button key={k} onClick={() => key(k)}>{label}</button>)}
          </div>
          <div className="composer">
            <textarea
              rows={1} value={draft} placeholder="message the agent…"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            />
            <button className="send" onClick={send} disabled={!draft.trim()}>↑</button>
          </div>
        </>
      )}
      {error && <div style={{ padding: '0 18px 12px' }}><div className="error">{error}</div></div>}
    </>
  );
}

function Chat({ messages }: { messages: Message[] | null }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [messages]);

  if (messages === null) return <div className="chat"><div className="empty">loading…</div></div>;
  if (!messages.length) {
    return (
      <div className="chat">
        <div className="empty">
          no messages yet
          <div className="note" style={{ marginTop: 8 }}>
            the agent writes its transcript as it works
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="chat">
      {messages.map((m, i) => (
        <div key={i} className={`msg ${m.role}`}>
          {m.tools.length > 0 && (
            <details className="tools">
              <summary>{m.tools.length} tool{m.tools.length > 1 ? 's' : ''}</summary>
              {m.tools.map((t, j) => (
                <div key={j} className="tool"><b>{t.name}</b>{t.input && <span> {t.input}</span>}</div>
              ))}
            </details>
          )}
          {m.text && <div className="bubble">{m.text}</div>}
          {!m.text && !m.tools.length && m.thinking && <div className="bubble faint">thinking…</div>}
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}

// -------------------------------------------------------------------- utils

function ago(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
