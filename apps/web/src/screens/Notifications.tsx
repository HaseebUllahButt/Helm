import { errorMessage } from '../errors';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { Client } from '../client';

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Turning on "tell me when a session is waiting".
 *
 * The browser only asks for permission from a real click, and only in a
 * secure context, so this is a button and it stays hidden on a plain LAN
 * address where the whole thing is impossible anyway. Every way it can fail
 * says why: a permission the person already denied cannot be re-asked from
 * inside the page, and silently doing nothing is the worst answer to give
 * there.
 */
export function Notifications({ client }: { client: Client }) {
  const [state, setState] = useState<'unknown' | 'off' | 'on' | 'blocked' | 'unsupported'>('unknown');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Switched off by hand: a reconnect must not quietly turn it back on. */
  const declined = useRef(false);
  const syncing = useRef(false);

  useEffect(() => {
    const able = 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
    // The real requirement is a secure context, not https in particular:
    // `helm open` serves the app on http://127.0.0.1, which a browser still
    // counts as secure, while a bare LAN address can never subscribe at all.
    if (!able || !window.isSecureContext) { setState('unsupported'); return; }
    if (Notification.permission === 'denied') { setState('blocked'); return; }

    const sync = async () => {
      if (declined.current || syncing.current) return;
      syncing.current = true;
      try {
        const reg = await navigator.serviceWorker.ready;
        const { key } = await client.pushKey();
        // Browsers only let the permission prompt happen on a click. Once a
        // person has granted it, however, a missing subscription can be
        // restored silently, so notifications stay on after a browser reset
        // or a service-worker replacement.
        const sub = (await boundSub(client, reg, key))
          ?? (Notification.permission === 'granted' ? await subscribe(client, reg, key) : null);
        // `declined` is checked again at the end, not only on the way in:
        // the person saying "off" while this was mid-flight wins, including
        // taking down a subscription that was just created underneath them.
        if (declined.current && sub) {
          await client.pushUnsubscribe(sub.endpoint).catch(() => {});
          await sub.unsubscribe().catch(() => {});
        }
        setState(declined.current ? 'off' : sub ? 'on' : 'off');
      } catch {
        setState((s) => (s === 'unknown' ? 'off' : s));
      } finally { syncing.current = false; }
    };

    void sync();
    // Which hub answers can change on any reconnect, and a subscription is
    // only good for the key of the one it was taken out against.
    return client.on((_env, kind, payload) => {
      if (kind === 'connection' && payload?.online) void sync();
    });
  }, [client]);

  const enable = async () => {
    setBusy(true); setError('');
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') { setState(permission === 'denied' ? 'blocked' : 'off'); return; }
      declined.current = false;
      const { key } = await client.pushKey();
      const reg = await navigator.serviceWorker.ready;
      const sub = await boundSub(client, reg, key) ?? await subscribe(client, reg, key);
      setState(sub ? 'on' : 'off');
    } catch (e: any) {
      setError(errorMessage(e, { fallback: 'Helm cannot turn notifications on.' }));
    } finally { setBusy(false); }
  };

  const disable = async () => {
    setBusy(true); setError('');
    declined.current = true;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await client.pushUnsubscribe(sub.endpoint);
        await sub.unsubscribe();
      }
      setState('off');
    } catch (e: any) {
      setError(errorMessage(e, { fallback: 'Helm cannot turn notifications off.' }));
    } finally { setBusy(false); }
  };

  if (state === 'unknown' || state === 'unsupported') return null;
  return (
    <>
      {state === 'blocked' ? (
        <p className="note setup-open">
          The browser blocks notifications. Allow them in the browser settings, then reload the page.
        </p>
      ) : (
        <button className="row" disabled={busy} onClick={state === 'on' ? disable : enable}>
          <span className="grow">
            <span className="rt">Notify this device</span>
            <span className="rm">Receive alerts when a chat needs you or finishes.</span>
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
 * The browser's push subscription if - and only if - it belongs to the hub
 * answering now.
 *
 * A subscription verifies pushes against one VAPID key, and every hub has
 * its own. When a different hub is answering - a second home, a rebuilt VM,
 * `helm open` having settled on the real home rather than the loopback it
 * started with - the old subscription is a doorbell wired to a house that
 * no longer exists: nothing arrives, ever, and nothing says why. A stale
 * one is dropped so a fresh one can be taken; the dead endpoint's next 410
 * cleans the row on whichever hub still remembers it.
 */
async function boundSub(client: Client, reg: ServiceWorkerRegistration, key: string) {
  const sub = await reg.pushManager.getSubscription();
  // `options.applicationServerKey` says which key this subscription verifies
  // against. A browser that will not say is one helm did not subscribe this
  // way, so it is treated the same as a mismatch: dropped and taken again.
  const bound = sub?.options?.applicationServerKey;
  if (!sub || !bound) return null;
  const have = new Uint8Array(bound);
  const wanted = new Uint8Array(base64urlToBytes(key));
  if (have.length !== wanted.length || have.some((b, i) => b !== wanted[i])) {
    await client.pushUnsubscribe(sub.endpoint).catch(() => {});
    await sub.unsubscribe().catch(() => {});
    return null;
  }
  // Registering is idempotent - the endpoint is the row's key - so a hub
  // that lost its database since we subscribed is put right for free.
  await client.pushSubscribe({
    endpoint: sub.endpoint,
    keys: (sub.toJSON() as any).keys,
    label: navigator.platform || 'this device',
  });
  return sub;
}

/** Take out a fresh subscription against this hub's key and register it there. */
async function subscribe(client: Client, reg: ServiceWorkerRegistration, key: string) {
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

export function InstallPwa() {
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
            <span className="rm">Open Helm as an app.</span>
          </span>
          <span className="chev"><Icon name="forward" size={15} /></span>
        </button>
      ) : (
        <p className="note install-note setup-open">Tap Share on your iPhone or iPad. Select Add to Home Screen.</p>
      )}
    </>
  );
}
