import { errorMessage } from '../errors';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Speaking a prompt instead of typing it.
 *
 * The recording happens here, in the browser, and the words come back from a
 * machine: a device never holds a Groq key. See `packages/connect/src/voice.js`
 * for the other half.
 *
 * Nothing about this is specific to the phone, but the phone is why it exists.
 * Typing a paragraph of instructions on a screen keyboard, in a session that
 * is waiting on you, is the exact friction helm was built to remove.
 */

/**
 * What to record in, in the order we would like it.
 *
 * Chrome and Firefox give Opus in WebM; Safari - which is every installed PWA
 * on an iPhone - gives AAC in MP4 and supports none of the others. Asking for
 * a format the browser does not have makes `MediaRecorder` throw at
 * construction, so the list is probed rather than assumed, and an empty string
 * (the browser's own default) is the last resort.
 */
const FORMATS = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg', ''];

function pickFormat(): string {
  const can = (window as any).MediaRecorder?.isTypeSupported;
  if (typeof can !== 'function') return '';
  for (const type of FORMATS) if (!type || can.call((window as any).MediaRecorder, type)) return type;
  return '';
}

/** Bytes to base64 without blowing the stack on a minute of audio. */
export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)) as unknown as number[]);
  }
  return btoa(out);
}

/**
 * Below this loudness, nothing was said.
 *
 * Whisper answers silence with a confident fragment from its training set -
 * `.` and `Thank you.` both turned up here recording an empty room - and that
 * lands in the composer as though it had been spoken. The fix is not to send
 * silence. Matches SILENCE_RMS in `packages/connect/src/voice.js`, measured
 * the same way: an empty room is about 0.009, speech about 0.2.
 *
 * The browser cannot check the recording afterwards - MediaRecorder hands back
 * Opus, not samples - so loudness is measured live, off the same stream, while
 * it records.
 */
export const SILENCE_RMS = 0.02;

/** Matches MAX_AUDIO_BYTES in voice.js. The machine enforces it; this is manners. */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
/** Long enough for a real instruction, short enough that a pocket cannot bankrupt you. */
export const MAX_SECONDS = 180;

export type DictationState = 'idle' | 'recording' | 'working' | 'unsupported';

/**
 * `getUserMedia` exists only in a secure context, which for helm means the
 * VM's https address or `helm open` on loopback - both of which qualify. A
 * machine reached over plain http on a LAN address does not, and there the
 * microphone is simply absent rather than broken.
 */
export const canRecord = () =>
  typeof window !== 'undefined'
  && !!navigator.mediaDevices?.getUserMedia
  && typeof (window as any).MediaRecorder === 'function';

/**
 * Words from a recording. `warm` is called as recording starts and its return
 * when it ends: the app uses it to time the machines that could do the work,
 * so the recording goes to the quickest one.
 */
export type Transcribe = ((audio: Blob, mime: string) => Promise<string>) & { warm?: () => () => void };

/**
 * Groq, called from this device. A machine hands over its key once
 * (`voice.direct`); after that a recording goes straight from here to Groq,
 * with no machine in the way - on a phone that trip was most of the wait.
 */
export interface DirectVoice { key: string; model: string; prompt: string; endpoint: string }
const KEPT = 'helm.voice.direct';

export function keptVoice(): DirectVoice | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEPT) || 'null');
    return v && typeof v.key === 'string' && typeof v.endpoint === 'string' ? v : null;
  } catch { return null; }
}

export function keepVoice(v: DirectVoice | null) {
  try { if (v) localStorage.setItem(KEPT, JSON.stringify(v)); else localStorage.removeItem(KEPT); } catch { /* the machine route still works */ }
}

/** Groq picks the decoder from the file name, as in voice.js. */
const EXT: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/aac': 'aac', 'audio/x-m4a': 'm4a', 'audio/m4a': 'm4a' };

/** A refused key says so (`status`), so the caller can fetch a fresh one. */
export async function groqDirect(v: DirectVoice, audio: Blob, mime: string): Promise<string> {
  const form = new FormData();
  form.append('file', audio, `speech.${EXT[mime.split(';')[0].trim().toLowerCase()] ?? 'webm'}`);
  form.append('model', v.model);
  form.append('response_format', 'json');
  form.append('prompt', v.prompt);
  const res = await fetch(v.endpoint, { method: 'POST', headers: { authorization: `Bearer ${v.key}` }, body: form, signal: AbortSignal.timeout(45_000) });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(body?.error?.message || `Groq returned error ${res.status}.`), { status: res.status });
  // Whisper answers silence with a stray "." - not something a person said.
  const text = String(body?.text ?? '').trim();
  return /[\p{L}\p{N}]/u.test(text) ? text : '';
}

export function useDictation({ transcribe, onText }: {
  transcribe: Transcribe;
  onText: (text: string) => void;
}) {
  const [state, setState] = useState<DictationState>(() => (canRecord() ? 'idle' : 'unsupported'));
  const [error, setError] = useState('');
  const [seconds, setSeconds] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  /** Loudest window seen while recording, as RMS - see SILENCE_RMS. */
  const loudest = useRef(0);
  /**
   * The mic button, which breathes with the voice (`--lvl`). Written here
   * each frame, not kept as state: state redrew the whole composer sixty
   * times a second for as long as the recording ran.
   */
  const meter = useRef<HTMLButtonElement | null>(null);

  /**
   * Letting go of the microphone matters: while a track is live the browser
   * shows a recording indicator and, on a phone, some other apps cannot use
   * the microphone at all. Every exit path comes through here.
   */
  const cool = useRef<(() => void) | null>(null);
  const release = useCallback(() => {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    cool.current?.(); cool.current = null;
    rec.current?.stream.getTracks().forEach((t) => t.stop());
    rec.current = null;
    audioCtx.current?.close().catch(() => {});
    audioCtx.current = null;
    setSeconds(0);
    meter.current?.style.removeProperty('--lvl');
  }, []);

  const stop = useCallback(() => {
    if (rec.current?.state === 'recording') rec.current.stop();
  }, []);

  const start = useCallback(async () => {
    setError('');
    if (!canRecord()) { setState('unsupported'); return; }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e: any) {
      // A refused microphone is a decision, not a fault, and it cannot be
      // re-asked from inside the page - so say which of the two it was.
      setError(e?.name === 'NotAllowedError'
        ? 'The browser blocks the microphone for this site.'
        : e?.name === 'NotFoundError' ? 'This device has no microphone.' : errorMessage(e, { fallback: 'Helm cannot use the microphone.' }));
      return;
    }
    const mime = pickFormat();
    let r: MediaRecorder;
    // Speech, not music: the browser's default is about 128 kbps, which made
    // a short note hundreds of kilobytes to push up a phone link before Groq
    // even saw it. Whisper hears 16 kHz; 32 kbps loses nothing it uses.
    try { r = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 32_000 }); }
    catch { stream.getTracks().forEach((t) => t.stop()); setError('This browser cannot record sound.'); return; }

    // Watch the loudness of the stream as it records. An AudioContext that
    // cannot be created (an old browser, an autoplay policy) simply leaves
    // `loudest` at zero, and the check below treats "no measurement" as
    // "no opinion" rather than as silence.
    loudest.current = 0;
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioCtx.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const sample = () => {
        // A newer recording has its own loop; this one ends with its context.
        if (audioCtx.current !== ctx) return;
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        if (rms > loudest.current) loudest.current = rms;
        meter.current?.style.setProperty('--lvl', String(Math.min(1, rms * 6)));
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    } catch { audioCtx.current = null; }

    chunks.current = [];
    rec.current = r;
    r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
    r.onstop = async () => {
      const type = r.mimeType || mime || 'audio/webm';
      const blob = new Blob(chunks.current, { type });
      const heard = loudest.current;
      const measured = !!audioCtx.current;
      // The timings are read by `transcribe`, so they stop after it, not here.
      const stopTiming = cool.current;
      cool.current = null;
      release();
      try {
        if (!blob.size) { setState('idle'); setError('Helm recorded no sound.'); return; }
        if (measured && heard < SILENCE_RMS) {
          setState('idle');
          setError('Helm heard no speech. Check that the microphone is on.');
          return;
        }
        if (blob.size > MAX_AUDIO_BYTES) { setState('idle'); setError('The recording is too long.'); return; }
        setState('working');
        try {
          const text = (await transcribe(blob, type)).trim();
          if (text) onText(text); else setError('Helm heard no speech.');
        } catch (e: any) {
          setError(errorMessage(e, { fallback: 'Helm cannot convert the speech to text.' }));
        } finally { setState('idle'); }
      } finally { stopTiming?.(); }
    };
    r.start();
    cool.current?.(); cool.current = transcribe.warm?.() ?? null;
    setState('recording');
    setSeconds(0);
    timer.current = setInterval(() => {
      setSeconds((s) => {
        // A recording left running in a pocket is paid for twice, in upload
        // and at Groq. It stops itself.
        if (s + 1 >= MAX_SECONDS) stop();
        return s + 1;
      });
    }, 1000);
  }, [transcribe, onText, release, stop]);

  const toggle = useCallback(() => { if (state === 'recording') stop(); else if (state === 'idle') start(); }, [state, start, stop]);

  // A view that goes away mid-recording must not leave the microphone on.
  useEffect(() => () => { try { rec.current?.stop(); } catch { /* already stopped */ } release(); }, [release]);

  return { state, error, seconds, meter, start, stop, toggle, clearError: () => setError('') };
}
