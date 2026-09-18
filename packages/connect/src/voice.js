import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME, CON_DIR } from './paths.js';
import { loadSettings } from './settings.js';

/**
 * Speaking to an agent instead of typing at it.
 *
 * Typing a prompt on a phone is the friction con exists to remove, so the
 * composer has a microphone. The recording is made on the device and the
 * words come back as text; what happens in between is here.
 *
 * **The key never leaves the machine.** A device sends audio to a machine in
 * the network and gets a transcript back - the same bargain as every other
 * credential in con, where a profile references a secret that stays where
 * the work runs. Nothing about the phone ever holds a Groq key, so a paired
 * device that is lost cannot spend anyone's credit.
 *
 * Transcription is Groq's hosted Whisper, because that is what the owner
 * already uses: `~/.config/groq-api-key` is what their Super+D dictation
 * binding reads, and con reads the same file rather than asking for the key
 * a second time in a different place.
 */

/** Where a key might be, in the order a machine should prefer them. */
const KEY_FILES = [
  join(CON_DIR, 'groq-api-key'),
  join(HOME, '.config', 'groq-api-key'),
];

const MODEL = process.env.CON_VOICE_MODEL || 'whisper-large-v3-turbo';
const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';

/**
 * A minute of speech is a long prompt; ten is a mistake, and it would be paid
 * for twice - once in upload over a phone connection and once at Groq. The
 * browser stops at the same number, but that cap is a courtesy: this endpoint
 * is reachable by anything holding a device token.
 */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 45_000;

const read = (file) => {
  try { return readFileSync(file, 'utf8').trim() || null; } catch { return null; }
};

/**
 * This machine's Groq key, or null.
 *
 * A path in config.json wins, so a machine that keeps its credentials
 * somewhere of its own - the owner's VM keeps this one under `~/sangi/creds` -
 * can say so once instead of having the file copied to a second place. Copying
 * a credential to make a tool happy is how you end up with two of them and no
 * idea which is live.
 */
export function groqKey() {
  const configured = loadSettings()?.voice?.keyFile;
  const files = configured ? [configured, ...KEY_FILES] : KEY_FILES;
  for (const file of files) if (existsSync(file)) { const k = read(file); if (k) return k; }
  return process.env.CON_GROQ_KEY || process.env.GROQ_API_KEY || null;
}

/** Whether this machine can turn speech into text, for `env.info`. */
export const canTranscribe = () => !!groqKey();

/**
 * Audio in, words out.
 *
 * The filename matters: Groq picks the decoder from the extension, and a
 * browser's `audio/webm;codecs=opus` arriving as `blob` is rejected as an
 * unknown format. So the mime type the recorder actually used is mapped to a
 * name rather than guessed at.
 */
const EXT = {
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3',
  'audio/mpga': 'mp3', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/wav': 'wav',
  'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/flac': 'flac', 'audio/aac': 'aac',
};

export function extensionFor(mime) {
  const base = String(mime || '').split(';')[0].trim().toLowerCase();
  return EXT[base] ?? 'webm';
}

export async function transcribe({ audio, mime = 'audio/webm', prompt, signal } = {}) {
  const key = groqKey();
  if (!key) {
    throw Object.assign(new Error('no Groq key on this machine - put one in ~/.con/groq-api-key'), { code: 'no_key' });
  }
  const bytes = Buffer.isBuffer(audio) ? audio : Buffer.from(String(audio ?? ''), 'base64');
  if (!bytes.length) throw new Error('no audio');
  if (bytes.length > MAX_AUDIO_BYTES) {
    const mb = (n) => (n / 1024 / 1024).toFixed(1).replace(/\.0$/, '');
    throw new Error(`that recording is ${mb(bytes.length)}MB; the limit is ${mb(MAX_AUDIO_BYTES)}MB`);
  }

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mime }), `speech.${extensionFor(mime)}`);
  form.append('model', MODEL);
  form.append('response_format', 'json');
  // What the speaker is likely to say. Names that Whisper has never heard -
  // con, herdr, Codex, sslip - come back mangled without it.
  form.append('prompt', prompt || 'con, herdr, Codex, Claude Code, opencode, Devin, sslip.io, PWA, repo, daemon.');

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  signal?.addEventListener?.('abort', () => abort.abort(), { once: true });
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
      signal: abort.signal,
    });
  } catch (err) {
    throw new Error(abort.signal.aborted ? 'transcription timed out' : `could not reach Groq: ${err.message}`);
  } finally { clearTimeout(timer); }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // Groq says exactly what is wrong - an expired key, a format it will not
    // take - and passing that through beats "transcription failed".
    throw new Error(body?.error?.message || `Groq answered ${res.status}`);
  }
  // Whisper does not return nothing for nothing. Handed silence - a muted
  // microphone, a recording that caught no speech - it answers with a
  // plausible fragment of punctuation, and `.` arriving in the composer as
  // your spoken prompt is worse than an empty answer. Anything with no letter
  // or digit in it did not come from a person talking.
  const text = String(body?.text ?? '').trim();
  return { text: /[\p{L}\p{N}]/u.test(text) ? text : '', model: MODEL };
}

/**
 * Did anything actually reach the microphone?
 *
 * Whisper does not answer "nothing" when handed nothing. Given silence it
 * returns a confident fragment from its training set - `.`, `Thank you.`,
 * `Thanks for watching!` - and that arrives in the composer as though the
 * owner had said it. Both of those were seen here, on this laptop, recording
 * an empty room.
 *
 * Filtering those phrases out afterwards is the wrong fix: the list is endless
 * and a real "thank you" would be eaten. The right one is not to send silence,
 * which also means not paying for it.
 *
 * **RMS, not peak.** A quiet room measured here peaks at 0.045 - one chair
 * creak clears any sensible peak threshold - while its RMS is 0.0086 against
 * 0.209 for speech at arm's length. Loudness over the whole recording
 * separates the two by twenty times; the loudest instant does not separate
 * them at all. That mistake is why the first version of this let "Thank you."
 * through twice.
 *
 * Reads the 16-bit PCM that `pw-record` and `arecord` write, walking the
 * chunks rather than assuming a 44-byte header - pw-record puts a LIST chunk
 * before the data, and a fixed offset reads that metadata as samples and makes
 * every recording look loud. A container it does not understand returns null,
 * meaning "no opinion", never "silent": refusing to transcribe real speech is
 * the worse failure.
 */
export function levelOfWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 48) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;

  let at = 12;
  let bits = 16, format = 1, dataAt = -1, dataLen = 0;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 24 <= buf.length) {
      format = buf.readUInt16LE(at + 8);
      bits = buf.readUInt16LE(at + 22);
    }
    if (id === 'data') { dataAt = at + 8; dataLen = Math.min(size, buf.length - dataAt); break; }
    at += 8 + size + (size % 2);
  }
  if (dataAt < 0 || dataLen <= 0 || bits !== 16 || format !== 1) return null;

  let sum = 0, peak = 0, n = 0;
  for (let i = dataAt; i + 1 < dataAt + dataLen; i += 2) {
    const v = buf.readInt16LE(i) / 32768;
    sum += v * v;
    n += 1;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  if (!n) return null;
  return { rms: Math.sqrt(sum / n), peak };
}

/**
 * Below this loudness, nothing was said. Measured on this laptop: an empty
 * room is 0.0086, speech is 0.209. This sits about twice the room floor and
 * ten times under speech, which leaves room for a noisier room without
 * swallowing someone talking quietly.
 */
export const SILENCE_RMS = 0.02;
