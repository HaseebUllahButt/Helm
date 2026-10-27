import { errorMessage } from '../errors';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Confirm } from '../Modal';
import { useNow, waitingSince } from '../useNow';
import { BackIcon, Icon } from '../Icon';
// The QR drawing code is only needed here: it loads with the first invite, not with the app.
const QrCode = lazy(() => import('../QrCode').then((m) => ({ default: m.QrCode })));
import { Client, isCleartext, CLEARTEXT_NOTE, type Device } from '../client';
import { AddMachine } from './Login';

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
export function DevicesView({ client, onBack }: { client: Client; onBack: () => void }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<Device | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<{ link: string; expiresAt: number } | null>(null);
  const [copied, setCopied] = useState(false);
  /** Someone used the link: said once. `closed` is whether the hub confirmed it. */
  const [arrived, setArrived] = useState<{ label: string; closed: boolean } | null>(null);
  // Who was already paired when the link was made, so anyone else who shows
  // up while it is open is known to have come through it.
  const knownAtInvite = useRef<Set<string>>(new Set());
  const pairingBase = useRef(client.relay);
  const now = useNow();

  const load = useCallback(() => {
    client.devices()
      .then((r) => setDevices(r.devices))
      .catch((e) => setError(errorMessage(e)));
  }, [client]);
  useEffect(load, [load]);

  // Resolves to whether the hub really closed it. The screen leaves the link
  // either way - it also dies on its own, and a failure must not strand the
  // person on a link they have finished with - but what it *says* follows the
  // answer: a hub that has not been upgraded has no such route, and claiming
  // a link is dead while it still works would be the one lie this screen
  // cannot afford.
  const closeLink = useCallback(async () => {
    setInvite(null); setCopied(false);
    return client.closePairing(pairingBase.current).then(() => true, () => false);
  }, [client]);

  // While a link is out, watch for it being used. The password is not spent by
  // a login, so a link that has done its job is still a way in until it times
  // out - closing it the moment someone arrives makes "my phone paired" and
  // "nobody else can" the same fact instead of ten minutes apart.
  useEffect(() => {
    if (!invite) return;
    let asking = false;
    const timer = setInterval(async () => {
      if (asking) return;
      asking = true;
      try {
        const r = await client.devices(pairingBase.current);
        setDevices(r.devices);
        const fresh = r.devices.find((d) => !knownAtInvite.current.has(d.id));
        if (fresh) {
          setInvite(null);
          setArrived({ label: fresh.label, closed: await closeLink() });
        }
      } catch { /* the next tick tries again */ }
      finally { asking = false; }
    }, 4_000);
    return () => clearInterval(timer);
  }, [client, invite, closeLink]);

  const pair = async () => {
    setBusy(true); setError(''); setArrived(null);
    try {
      // Never from a list that has not arrived: an empty snapshot would make
      // every device already paired look like it had just used the link.
      // Asked fresh, not read from what the screen last drew: a device that
      // paired since would look like it had just used this link, and close it.
      const current = (await client.devices()).devices;
      knownAtInvite.current = new Set(current.map((d) => d.id));
      const r = await client.newPassword(10 * 60_000);
      pairingBase.current = r.base;
      knownAtInvite.current = new Set(r.knownDeviceIds);
      setInvite({ link: `${r.base}/#pair=${encodeURIComponent(r.password)}`, expiresAt: r.expiresAt });
    } catch (e: any) { setError(errorMessage(e)); }
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
    } catch (e: any) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };

  // Everything except the device in hand. The lost-phone answer: one tap
  // instead of finding each old entry, and it cannot lock you out because it
  // cannot include the device doing the asking.
  const others = (devices ?? []).filter((d) => !d.self);
  const signOutOthers = async () => {
    setBusy(true); setError('');
    const results = await Promise.allSettled(others.map((d) => client.removeDevice(d.id)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    setBusy(false); setSigningOut(false);
    if (failed) setError(`Helm did not remove ${failed} of ${others.length} devices. Try again.`);
    load();
  };

  // This device first, then whoever is connected, then the most recently seen:
  // the top of the list is who is using the network, the bottom is what might
  // be safe to remove.
  const ordered = [...(devices ?? [])].sort((a, b) =>
    Number(!!b.self) - Number(!!a.self)
    || Number(!!b.online) - Number(!!a.online)
    || (b.lastSeen ?? b.addedAt) - (a.lastSeen ?? a.addedAt));
  const ago = (ts: number) => (waitingSince(ts, now) === 'just now' ? 'just now' : `${waitingSince(ts, now)} ago`);
  const STALE_MS = 30 * 24 * 3600_000;

  // The clock is read here, not taken from the shared ticker: that one can be
  // fifteen seconds old, which turned a ten-minute link into "about 11 min".
  const msLeft = invite ? invite.expiresAt - Date.now() : 0;
  const minutesLeft = Math.max(1, Math.round(msLeft / 60_000));
  const expired = !!invite && msLeft <= 0;

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <div className="titles"><h1>Devices</h1></div>
      </div>
      <div className="scroll"><div className="pad column">
        {isCleartext(client.relay) && <div className="banner warn">{CLEARTEXT_NOTE}</div>}
        {arrived && (
          <div className={`banner${arrived.closed ? '' : ' warn'}`}>
            <b>{arrived.label}</b> paired with your link.{' '}
            {arrived.closed
              ? 'The link is closed.'
              : 'The link still works until it expires. Did you add this device?'}
          </div>
        )}
        {invite ? (
          <div className="setup-open">
            {expired ? (
              <p className="note">This link expired.</p>
            ) : (<>
              <Suspense fallback={<div className="qr-wait" aria-hidden="true" />}>
                <QrCode value={invite.link} label="Scan this code with the new phone." />
              </Suspense>
              <p className="note">
                Scan the code with your phone camera or open the link on the new device.
                Keep the link secret. It expires in about {minutesLeft} minutes or after one use.
              </p>
            </>)}
            {!expired && <pre className="snippet">{invite.link}</pre>}
            <div className="rows">
              {!expired && (
                <button className="row" onClick={async () => {
                  try { await navigator.clipboard.writeText(invite.link); setCopied(true); }
                  catch { setError('Helm cannot copy the link. Press and hold the link to copy it.'); }
                }}>
                  <span className="grow"><span className="rt"><span className="rt-text">{copied ? 'copied' : 'Copy link'}</span></span></span>
                </button>
              )}
              <button className="row" onClick={() => { void closeLink(); }}>
                <span className="grow"><span className="rt">{expired ? 'Done' : 'Close link'}</span></span>
              </button>
            </div>
          </div>
        ) : (
          <button className="action" disabled={busy} onClick={pair}>
            <span className="plus"><Icon name="plus" size={15} /></span>{busy ? 'making a link…' : 'Pair another device'}
          </button>
        )}

        <div className="rows"><AddMachine client={client} /></div>

        <div className="section">Paired devices</div>
        <div className="rows">
          {devices === null && !error && <div className="empty quiet">Loading devices…</div>}
          {ordered.map((d) => (
            <div key={d.id} className="row tall rowx">
              <div className="rowmain">
                <span className={`mdot ${d.online || d.self ? 'on' : 'off'}`} />
                <span className="grow">
                  <span className="rt">
                    {d.label}{d.self && <span className="tag">this device</span>}
                    {!d.online && !d.self && d.lastSeen != null && now - d.lastSeen > STALE_MS
                      && <span className="tag">Last seen over 30 days ago</span>}
                  </span>
                  <span className="rm" title={`paired ${ago(d.addedAt)}`}>
                    {d.online || d.self ? 'online' : d.lastSeen != null ? `last seen ${ago(d.lastSeen)}` : 'not seen lately'}
                  </span>
                </span>
              </div>
              <button className="rowend" title={`remove ${d.label}`} aria-label={`remove ${d.label}`}
                onClick={() => setRemoving(d)}><Icon name="close" size={15} /></button>
            </div>
          ))}
          {devices?.length === 0 && <div className="empty quiet">No devices are paired.</div>}
        </div>
        {others.length > 0 && (
          <button className="action danger" disabled={busy} onClick={() => setSigningOut(true)}>
            Sign out {others.length === 1 ? 'the other device' : `all ${others.length} other devices`}
          </button>
        )}
        {error && <div className="error">{error}</div>}
      </div></div>

      {removing && (
        <Confirm
          title={removing.self ? 'Remove this device?' : `Remove ${removing.label}?`}
          body={removing.self
            ? 'This device will sign out. Run `helm link` to get a new link and sign in again.'
            : 'This device loses access to every machine at once.'}
          confirmLabel="Remove" danger busy={busy}
          onCancel={() => setRemoving(null)}
          onConfirm={remove}
        />
      )}
      {signingOut && (
        <Confirm
          title={others.length === 1 ? 'Sign out the other device?' : `Sign out ${others.length} other devices?`}
          body="These devices lose access to every machine at once. This device stays signed in."
          confirmLabel="Sign out" danger busy={busy}
          onCancel={() => setSigningOut(false)}
          onConfirm={signOutOthers}
        />
      )}
    </>
  );
}
