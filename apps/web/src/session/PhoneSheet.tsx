import { useEffect, useRef, useState } from 'react';
import { useNow, waitingSince } from '../useNow';
import { errorMessage } from '../errors';
import type { Permission } from './types';
import { IMAGE_ACCEPT, prepareImage } from './image';
import { findCode, forgetSharedText, phoneRpc, SHARE_EVENT, sharedText } from './phoneShare';

/** One photo piece: 512 KiB of base64, about 384 KiB of photo. */
const PIECE = 512 * 1024;
const MAX_PHOTO = 20 * 1024 * 1024;

export type PhoneVariant = 'sheet' | 'banner' | 'island';

const KIND_LABEL: Record<string, string> = { ask: 'Question', photo: 'Photo', location: 'Location', code: 'Sign-in code' };

/**
 * A helm phone card (phone.js): an agent wants an answer, a photo, the
 * location or a one-time sign-in code. It says which chat asks and why, and
 * the owner sends or refuses. It answers with its own calls, so a photo or
 * a code is never kept in browser storage.
 */
export function PhoneSheet({ permission: p, variant = 'sheet', envId, onSent }: {
  permission: Permission; variant?: PhoneVariant;
  /** The chat's machine. The card names it too; the waiting box knows it already. */
  envId?: string;
  /** The answer arrived. `said` is a short line for the waiting box. */
  onSent?: (said: string) => void;
}) {
  const phone = p.phone!;
  const env = envId ?? phone.envId ?? '';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [code, setCode] = useState('');
  const [fromShare, setFromShare] = useState(false);
  const [photo, setPhoto] = useState<{ file: File; url: string } | null>(null);
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);
  const now = useNow();
  const island = variant === 'island';

  // A text message shared to Helm fills the code box.
  useEffect(() => {
    if (phone.type !== 'code') return;
    const take = () => {
      const shared = sharedText();
      if (!shared) return;
      const found = findCode(shared);
      if (found) { setCode(found); setFromShare(true); }
    };
    take();
    window.addEventListener(SHARE_EVENT, take);
    return () => window.removeEventListener(SHARE_EVENT, take);
  }, [phone.type]);
  useEffect(() => () => { if (photo) URL.revokeObjectURL(photo.url); }, [photo]);

  const call = async (method: string, params: any, said: string, timeout = 30_000) => {
    if (!env) throw new Error('Helm does not know the machine of this chat. Open the chat and try again.');
    await phoneRpc()(env, method, { requestId: p.requestId, ...params }, timeout);
    onSent?.(said);
  };
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await work(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); setProgress(null); }
  };

  const refuse = () => run(() => call('phone.give', { refuse: true }, 'Refused'));
  const sendText = (answer: string) => answer.trim() && run(() => call('phone.give', { text: answer.trim() }, `Answered: ${answer.trim()}`));
  const sendCode = () => {
    const c = findCode(code);
    if (!c) return;
    void run(async () => { await call('phone.give', { code: c }, 'Code sent'); forgetSharedText(); });
  };
  const paste = () => run(async () => {
    let got = '';
    try { got = await navigator.clipboard.readText(); }
    catch { throw new Error('Helm cannot read the clipboard here. Press and hold the box, then paste.'); }
    if (!got.trim()) throw new Error('The clipboard is empty. Copy the code first.');
    setCode(findCode(got)); setFromShare(false);
  });
  const sendLocation = () => run(async () => {
    if (!navigator.geolocation) throw new Error('This browser cannot share a location. Open Helm on the phone.');
    const at = await new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, (e) => reject(new Error(
      e.code === 1 ? 'Location is blocked for Helm. Allow it in the browser or phone settings, or refuse.'
        : 'The phone could not find its location. Go outside or turn on location, then try again.')),
    { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 }));
    await call('phone.give', { latitude: at.coords.latitude, longitude: at.coords.longitude, accuracy: at.coords.accuracy }, 'Location sent');
  });
  const pick = (file: File | undefined) => {
    if (!file) return;
    setError('');
    if (photo) URL.revokeObjectURL(photo.url);
    setPhoto({ file, url: URL.createObjectURL(file) });
  };
  const sendPhoto = () => photo && run(async () => {
    // Made smaller like a photo in a message, so it goes fast. A photo this
    // browser cannot read (HEIC outside Safari) goes as it is.
    let data: string, mime: string;
    try { const ready = await prepareImage(photo.file); data = ready.data; mime = ready.mime; }
    catch {
      if (photo.file.size > MAX_PHOTO) throw new Error('The photo is larger than 20 MB.');
      data = await asBase64(photo.file); mime = photo.file.type || 'image/jpeg';
    }
    const pieces = Math.max(1, Math.ceil(data.length / PIECE));
    for (let i = 0; i < pieces; i++) {
      setProgress(Math.round((i / pieces) * 100));
      const last = i === pieces - 1;
      const params = { part: i, mime, last, data: data.slice(i * PIECE, (i + 1) * PIECE) };
      if (last) await call('phone.photo', params, 'Photo sent', 60_000);
      else await phoneRpc()(env, 'phone.photo', { requestId: p.requestId, ...params }, 60_000);
    }
  });

  const title = phone.type === 'ask' ? (phone.question ?? p.title) : p.title;
  const btn = (primary: boolean) => island ? (primary ? 'island-yes' : '') : primary ? 'primary' : 'ghost';
  const refuseButton = <button className={island ? '' : 'ghost deny'} disabled={busy} onClick={() => void refuse()}>Refuse</button>;

  let body: JSX.Element | null = null;
  let actions: JSX.Element;
  if (phone.type === 'ask') {
    const choices = phone.choices ?? [];
    body = <>
      {!!choices.length && <div className={island ? 'island-opts' : 'q-options'} role="group" aria-label={title}>
        {choices.map((c, i) => (
          <button key={c} className={island ? 'island-opt' : 'q-opt'} disabled={busy} onClick={() => void sendText(c)}>
            <span className={island ? 'island-n' : 'q-num'}>{i + 1}</span>
            <span className={island ? 'island-ot' : 'grow q-label'}>{c}</span>
          </button>
        ))}
      </div>}
      <form className="phone-row" onSubmit={(e) => { e.preventDefault(); void sendText(text); }}>
        <input value={text} disabled={busy} onChange={(e) => setText(e.target.value)} aria-label="Your answer"
          placeholder={choices.length ? 'Type another answer' : 'Type your answer'} enterKeyHint="send" />
      </form>
    </>;
    actions = <>{refuseButton}<button className={btn(true)} disabled={busy || !text.trim()} onClick={() => void sendText(text)}>{busy ? 'Sending' : 'Send'}</button></>;
  } else if (phone.type === 'code') {
    const found = findCode(code);
    body = <form className="phone-row" onSubmit={(e) => { e.preventDefault(); sendCode(); }}>
      <input value={code} disabled={busy} autoComplete="one-time-code" inputMode="text" autoCapitalize="off" spellCheck={false}
        aria-label="Sign-in code" placeholder="Paste or type the code" enterKeyHint="send"
        onChange={(e) => { setCode(e.target.value); setFromShare(false); }} className="phone-code" />
      {typeof navigator !== 'undefined' && !!navigator.clipboard?.readText && <button type="button" className={btn(false)} disabled={busy} onClick={() => void paste()}>Paste</button>}
    </form>;
    actions = <>{refuseButton}<button className={btn(true)} disabled={busy || !found} onClick={sendCode}>{busy ? 'Sending' : 'Send code'}</button></>;
    if (code && found && found !== code.trim()) body = <>{body}<p className="phone-note">Helm sends only the code: <b>{found}</b></p></>;
    else if (fromShare) body = <>{body}<p className="phone-note">From the message you shared to Helm.</p></>;
  } else if (phone.type === 'location') {
    body = <p className="phone-note">Helm sends your location once. The agent does not get it again.</p>;
    actions = <>{refuseButton}<button className={btn(true)} disabled={busy} onClick={() => void sendLocation()}>{busy ? 'Finding location' : 'Send my location'}</button></>;
  } else {
    body = <>
      <input ref={camera} type="file" accept={IMAGE_ACCEPT} capture="environment" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
      <input ref={library} type="file" accept={IMAGE_ACCEPT} hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
      {photo ? <img className="phone-photo" src={photo.url} alt="The photo to send" />
        : <div className="phone-row">
          <button className={btn(false)} disabled={busy} onClick={() => camera.current?.click()}>Take a photo</button>
          <button className={btn(false)} disabled={busy} onClick={() => library.current?.click()}>Choose a photo</button>
        </div>}
      {progress != null && <p className="phone-note">Sending {progress}%</p>}
    </>;
    actions = <>{refuseButton}
      {photo && <button className={btn(false)} disabled={busy} onClick={() => library.current?.click()}>Choose another</button>}
      <button className={btn(true)} disabled={busy || !photo} onClick={() => void sendPhoto()}>{busy ? 'Sending' : 'Send photo'}</button>
    </>;
  }

  const from = phone.chat ? `Asked by ${phone.chat}` : 'Asked by this chat';
  if (island) return (
    <div className="phone-island">
      <p className="island-q">{title}</p>
      {p.reason && <p className="island-where">{p.reason}</p>}
      {body}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="island-acts phone-acts">{actions}</div>
    </div>
  );
  return (
    <div className={`sheet phone${variant === 'banner' ? ' banner' : ''}`}>
      <div className="sheet-head">
        <i className="sdot blocked" />
        <span className="ask-kind">{KIND_LABEL[phone.type] ?? 'Phone'}</span>
        <span className="tag">{from}</span>
        {p.at && <span className="q-wait">{waitingSince(p.at, now)}</span>}
      </div>
      <div className="sheet-title">
        <b>{title}</b>
        {p.reason && <span className="sheet-reason">{p.reason}</span>}
      </div>
      <div className="sheet-body phone-body">{body}</div>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="sheet-actions">{actions}</div>
    </div>
  );
}

function asBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { const url = String(reader.result ?? ''); resolve(url.slice(url.indexOf(',') + 1)); };
    reader.onerror = () => reject(new Error('Helm cannot read the photo.'));
    reader.readAsDataURL(file);
  });
}
