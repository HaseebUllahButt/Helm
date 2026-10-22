import { useEffect, useRef, useState } from 'react';
import { useNow } from '../useNow';
import type { StoredAuth } from '../store';
import { Client, login, LOOPBACK_HOST, isCleartext, CLEARTEXT_NOTE } from '../client';
import { shareHopTarget, shareHopHash } from './ShareHop';
import { InstallPwa } from './Notifications';

export type Auth = StoredAuth;

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

export function Login({ notice, onDone }: { notice?: string; onDone: (a: Auth) => void }) {
  const openedWith = useRef(pairingTarget(location.href));
  const autoStarted = useRef(false);
  const [link, setLink] = useState('');
  const [password, setPassword] = useState(() => openedWith.current?.password || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selfHosted, setSelfHosted] = useState<boolean | null>(null);
  const [network, setNetwork] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [linkSecretFailed, setLinkSecretFailed] = useState(false);
  const spin = shareHopTarget();

  const finish = (auth: Auth) => {
    // Shell consumes navigation links after sign-in; discard only auth hashes.
    if (location.hash && !/^#open=[^/]+\/.+$/.test(location.hash) && location.hash !== '#devices' && !shareHopTarget()) {
      history.replaceState(null, '', location.pathname + location.search);
    }
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
    } finally { setBusy(false); setChecking(false); }
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

  // Whole-host match, as the hub does it: a prefix let `localhost.evil.com` count.
  const isLocal = LOOPBACK_HOST.test(location.hostname);

  useEffect(() => {
    let cancelled = false;
    fetch(`${location.origin}/api/health`, { signal: AbortSignal.timeout(5000) })
      .then((r) => r.ok ? r.json() : null)
      .then((health) => {
        if (!cancelled) { setSelfHosted(!!health?.ok); setNetwork(health?.network ?? null); }
      })
      .catch(() => { if (!cancelled) setSelfHosted(false); });
    return () => { cancelled = true; };
  }, []);

  // The page is being served by a daemon on this very computer, which is the
  // whole claim a local sign-in makes - ask it for the local key directly
  // rather than waiting for a link. Nothing answers that but this machine.
  useEffect(() => {
    if (!isLocal || selfHosted !== true || openedWith.current?.password || autoStarted.current) return;
    autoStarted.current = true;
    fetch('/api/auth/local', { method: 'POST' })
      .then((r) => (r.ok ? r.json() : null))
      .then(async (v) => { if (v?.local) await connect(location.origin, '', v.local); })
      .catch(() => {})
      .finally(() => setChecking(false));
  }, [selfHosted]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the public app's origin and installed-app scope. The local daemon
  // shares a device token only with an exact origin already in its network,
  // and only if both sides name the same network. It never exposes local.key.
  useEffect(() => {
    if (selfHosted === null) return;
    if (selfHosted === false) { setChecking(false); return; }
    if (isLocal || openedWith.current?.password || autoStarted.current) {
      if (openedWith.current?.password) setChecking(false);
      return;
    }
    if (!network || /Android|iPhone|iPad|iPod/.test(navigator.userAgent)) {
      setChecking(false); return;
    }
    let cancelled = false;
    const base = 'http://127.0.0.1:8787';
    fetch(`${base}/api/auth/desktop`, {
      method: 'POST', cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ network, label: 'this computer' }),
      signal: AbortSignal.timeout(5000),
    })
      .then((r) => r.ok ? r.json() : null)
      .then((v) => {
        if (cancelled || autoStarted.current || !v?.token || v.network !== network) return;
        autoStarted.current = true;
        finish({ token: v.token, deviceId: v.deviceId,
          endpoints: [...new Set<string>([location.origin, base, ...(v.endpoints ?? [])])] });
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [selfHosted, network]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const target = openedWith.current;
    if (selfHosted !== true || !target?.password || autoStarted.current) return;
    autoStarted.current = true;
    connect(location.origin, target.password);
  }, [selfHosted]);

  useEffect(() => {
    if (selfHosted !== true) return;
    const pair = () => {
      const target = pairingTarget(location.href);
      if (!target?.password) return;
      openedWith.current = target;
      autoStarted.current = true;
      void connect(location.origin, target.password);
    };
    window.addEventListener('hashchange', pair);
    return () => window.removeEventListener('hashchange', pair);
  }, [selfHosted]); // eslint-disable-line react-hooks/exhaustive-deps

  const pasted = pairingTarget(link);
  const secretFromLink = selfHosted ? openedWith.current?.password : pasted?.password;
  const secretInLink = linkSecretFailed ? '' : secretFromLink;
  const endpoint = selfHosted ? location.origin : pasted?.endpoint || '';
  const secret = password || secretInLink || '';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!endpoint) { setError('Paste the link from `helm link`.'); return; }
    if (!secret) { setError('Enter the pairing code.'); return; }
    await connect(endpoint, secret);
  };

  if (checking || busy) {
    return (
      <div className="auth">
        <div className="auth-card">
          <div className="auth-brand">
            <img src="/icon.svg" alt="" />
            <h1>helm</h1>
            <p>{busy ? 'joining your network…' : 'checking this device…'}</p>
          </div>
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
          <p>{spin ? `Sign in to open ${spin.name}${spin.source ? `, shared from ${spin.source}` : ''}.` : 'All coding agents in one place'}</p>
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

          {isCleartext(endpoint) && <div className="banner warn">{CLEARTEXT_NOTE}</div>}
          <button className="primary" disabled={busy || !endpoint || !secret}>
            {busy ? 'pairing…' : 'Pair this device'}
          </button>
          {error && <div className="error">{error}</div>}
          <p className="note" style={{ marginTop: 14, textAlign: 'center' }}>
            Open Devices on a paired device to get a link. Or run <code>helm link</code> on a joined computer.
          </p>
          {!isLocal && !/Android|iPhone|iPad|iPod/.test(navigator.userAgent) && (
            <p className="note" style={{ textAlign: 'center' }}>
              Did you run <code>helm join</code> here?{' '}
              <a href={`http://127.0.0.1:8787/${spin ? `#${shareHopHash(spin)}` : ''}`} target="_self">Open this computer's Helm</a>.
            </p>
          )}
        </form>
        {/* The one place "install it" cannot wait for the sidebar: a phone
            that has not paired yet is exactly the phone this is for. */}
        <InstallPwa />
      </div>
    </div>
  );
}

export function AddMachine({ client }: { client: Client }) {
  const [role, setRole] = useState<'pc' | 'vm' | 'nas'>('pc');
  const [invite, setInvite] = useState<{ link: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const now = useNow();
  const makeInvite = async () => {
    setBusy(true); setError(''); setCopied(false);
    try {
      const r = await client.invite(role);
      setInvite({ link: `${r.base || client.relay}/#join=${encodeURIComponent(r.code)}`, expiresAt: r.expiresAt });
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  const command = invite ? `helm join '${invite.link}'` : '';
  return (
    <>
      <div className="row">
        <span className="grow">
          <span className="rt">Add a computer</span>
          <span className="rm">Install Helm there. Run the join command.</span>
        </span>
      </div>
      <select aria-label="Computer kind" value={role} onChange={(e) => { setRole(e.target.value as typeof role); setInvite(null); }}>
        <option value="pc">Laptop or desktop</option>
        <option value="vm">Server (virtual machine)</option>
        <option value="nas">File storage</option>
      </select>
      <button className="row" disabled={busy} onClick={makeInvite}>
        <span className="grow"><span className="rt">{busy ? 'making a command…' : 'Create join command'}</span></span>
      </button>
      {invite && (now >= invite.expiresAt ? <p className="note">This invite expired. Create a new command.</p> : <>
        <pre className="snippet">{command}</pre>
        <button className="row" onClick={async () => {
          try { await navigator.clipboard.writeText(command); setCopied(true); }
          catch { setError('Helm cannot copy the command. Select the command to copy it.'); }
        }}><span className="grow"><span className="rt">{copied ? 'copied' : 'Copy join command'}</span></span></button>
        <p className="note">Use this command once. It expires in 10 minutes.</p>
      </>)}
      {error && <div className="error">{error}</div>}
    </>
  );
}
