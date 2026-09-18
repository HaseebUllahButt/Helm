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
 * is waiting on you, is the exact friction con was built to remove.
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
function toBase64(buf: ArrayBuffer): string {
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
 * `getUserMedia` exists only in a secure context, which for con means the
 * VM's https address or `con open` on loopback - both of which qualify. A
 * machine reached over plain http on a LAN address does not, and there the
 * microphone is simply absent rather than broken.
 */
export const canRecord = () =>
  typeof window !== 'undefined'
  && !!navigator.mediaDevices?.getUserMedia
  && typeof (window as any).MediaRecorder === 'function';

export function useDictation({ transcribe, onText }: {
  transcribe: (audio: string, mime: string) => Promise<string>;
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
  const [level, setLevel] = useState(0);

  /**
   * Letting go of the microphone matters: while a track is live the browser
   * shows a recording indicator and, on a phone, some other apps cannot use
   * the microphone at all. Every exit path comes through here.
   */
  const release = useCallback(() => {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
    rec.current?.stream.getTracks().forEach((t) => t.stop());
    rec.current = null;
    audioCtx.current?.close().catch(() => {});
    audioCtx.current = null;
    setSeconds(0);
    setLevel(0);
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
        ? 'microphone blocked for this site'
        : e?.name === 'NotFoundError' ? 'no microphone here' : e?.message || 'could not open the microphone');
      return;
    }
    const mime = pickFormat();
    let r: MediaRecorder;
    try { r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
    catch { stream.getTracks().forEach((t) => t.stop()); setError('this browser cannot record audio'); return; }

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
        if (!audioCtx.current) return;
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        if (rms > loudest.current) loudest.current = rms;
        setLevel(rms);
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
      release();
      if (!blob.size) { setState('idle'); setError('nothing was recorded'); return; }
      if (measured && heard < SILENCE_RMS) {
        setState('idle');
        setError('nothing was said — is the microphone muted?');
        return;
      }
      if (blob.size > MAX_AUDIO_BYTES) { setState('idle'); setError('that recording is too long'); return; }
      setState('working');
      try {
        const text = (await transcribe(toBase64(await blob.arrayBuffer()), type)).trim();
        if (text) onText(text); else setError('nothing was said');
      } catch (e: any) {
        setError(e?.message || 'could not transcribe that');
      } finally { setState('idle'); }
    };
    r.start();
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

  return { state, error, seconds, level, start, stop, toggle, clearError: () => setError('') };
}
