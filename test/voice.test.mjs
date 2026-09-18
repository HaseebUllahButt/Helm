import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { levelOfWav, SILENCE_RMS, extensionFor, MAX_AUDIO_BYTES, transcribe } =
  await import('../packages/connect/src/voice.js');

/**
 * A 16-bit mono WAV, optionally with the LIST chunk pw-record writes before
 * the data - which is the shape that broke the first version of the reader.
 */
function wav(samples, { list = false } = {}) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32768))), i * 2));
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii'); fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(16000, 12); fmt.writeUInt32LE(32000, 16);
  fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(16, 22);
  const extra = list ? (() => {
    const b = Buffer.alloc(8 + 16);
    b.write('LIST', 0, 'ascii'); b.writeUInt32LE(16, 4);
    // Loud bytes: read as samples these would look like a shout.
    b.fill(0xff, 8);
    return b;
  })() : Buffer.alloc(0);
  const head = Buffer.alloc(8);
  head.write('data', 0, 'ascii'); head.writeUInt32LE(data.length, 4);
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), fmt, extra, head, data]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii'); riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

const tone = (n, amp) => Array.from({ length: n }, (_, i) => amp * Math.sin((i / 16000) * 2 * Math.PI * 220));

// Whisper answers silence with "Thank you." rather than with nothing, so the
// only way not to put that in the owner's prompt is not to send the silence.
test('an empty room is silence, speech is not', () => {
  // Measured on this laptop: room 0.0086 rms, speech 0.209.
  const room = levelOfWav(wav(tone(16000, 0.012)));
  const speech = levelOfWav(wav(tone(16000, 0.3)));
  assert.ok(room.rms < SILENCE_RMS, `room ${room.rms} should read as silence`);
  assert.ok(speech.rms > SILENCE_RMS, `speech ${speech.rms} should not`);
});

// The first version used the loudest instant, and a single chair creak in an
// empty room cleared any sensible threshold. Loudness over the whole
// recording separates room from speech by twenty times; the peak does not
// separate them at all.
test('one loud instant in a quiet recording is still silence', () => {
  const samples = tone(16000, 0.008);
  samples[500] = 0.95;
  const level = levelOfWav(wav(samples));
  assert.ok(level.peak > 0.9, 'the creak is there');
  assert.ok(level.rms < SILENCE_RMS, 'but the recording is still silent');
});

// pw-record writes a LIST chunk between `fmt ` and `data`. Assuming the
// 44-byte header everyone quotes reads that metadata as audio, and then every
// recording looks loud enough to send.
test('the chunks are walked, not assumed', () => {
  const quiet = tone(16000, 0.008);
  const plain = levelOfWav(wav(quiet));
  const withList = levelOfWav(wav(quiet, { list: true }));
  assert.ok(Math.abs(plain.rms - withList.rms) < 1e-9, 'a LIST chunk must not change the measurement');
  assert.ok(withList.rms < SILENCE_RMS);
});

// "No opinion" and "silent" are different answers: refusing to transcribe
// real speech is worse than paying for one request.
test('a format it cannot read returns null, not silence', () => {
  assert.equal(levelOfWav(Buffer.from('OggS not a wav at all, padded out to be long enough xxxxxxxxxxxx')), null);
  assert.equal(levelOfWav(Buffer.alloc(10)), null);
  assert.equal(levelOfWav('not a buffer'), null);
});

// Groq picks its decoder from the filename, so a browser's
// `audio/webm;codecs=opus` arriving as `blob` is refused as unknown.
test('the recorder mime type becomes a filename Groq understands', () => {
  assert.equal(extensionFor('audio/webm;codecs=opus'), 'webm');
  assert.equal(extensionFor('audio/mp4'), 'mp4', 'what Safari records, so every iPhone PWA');
  assert.equal(extensionFor('audio/ogg; codecs=opus'), 'ogg');
  assert.equal(extensionFor('audio/wav'), 'wav', 'what pw-record writes');
  assert.equal(extensionFor(''), 'webm', 'a browser that names no type still gets a real extension');
});

test('audio is refused before it is uploaded when it cannot be right', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'con-voice-'));
  try {
    // A key has to exist, or the size check is never reached.
    process.env.CON_GROQ_KEY = 'gsk_test_not_a_real_key';
    await assert.rejects(() => transcribe({ audio: '' }), /no audio/);
    const huge = Buffer.alloc(MAX_AUDIO_BYTES + 1);
    await assert.rejects(() => transcribe({ audio: huge }), /the limit is 8MB/);
  } finally {
    delete process.env.CON_GROQ_KEY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a machine with no key says so instead of calling out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'con-voice-nokey-'));
  const home = join(dir, 'home');
  mkdirSync(join(home, '.config'), { recursive: true });
  const saved = { HOME: process.env.HOME, k1: process.env.GROQ_API_KEY, k2: process.env.CON_GROQ_KEY };
  try {
    delete process.env.GROQ_API_KEY;
    delete process.env.CON_GROQ_KEY;
    // paths.js reads HOME once at import, so this runs in a child.
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { canTranscribe, transcribe } = await import('${new URL('../packages/connect/src/voice.js', import.meta.url).pathname}');
      console.log('can:', canTranscribe());
      try { await transcribe({ audio: Buffer.from('x') }); } catch (e) { console.log('err:', e.code, e.message); }
    `], { env: { ...process.env, HOME: home, CON_DIR: join(home, '.con') }, encoding: 'utf8' });
    assert.match(out, /can: false/);
    assert.match(out, /err: no_key/);
  } finally {
    process.env.HOME = saved.HOME;
    if (saved.k1) process.env.GROQ_API_KEY = saved.k1;
    if (saved.k2) process.env.CON_GROQ_KEY = saved.k2;
    rmSync(dir, { recursive: true, force: true });
  }
});
