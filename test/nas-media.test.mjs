import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The NAS division: an allowlist of folders, and a byte-stream server that
 * cannot see outside it.
 *
 * What is being proved here is the boundary, not the plumbing - that a path
 * a caller sends is served only when it lands beneath a shared root, that
 * the ways out (traversal, dotfiles, symlinks) all stay shut, and that a
 * player gets real HTTP bytes: lengths, ranges, and a type it can decode.
 */

const base = mkdtempSync(join(tmpdir(), 'helm-nas-'));
process.env.HELM_DIR = join(base, 'helm');

const { mediaRoots, addMediaRoot, removeMediaRoot } =
  await import('../packages/nas/src/roots.js');
const { resolveMedia } = await import('../packages/nas/src/resolve.js');
const { listMedia } = await import('../packages/nas/src/catalog.js');
const { startMediaServer } = await import('../packages/nas/src/server.js');

test.after(() => rmSync(base, { recursive: true, force: true }));

// A small library: one folder, one loose file, private things, and two
// links that point out of it entirely - at a directory and at a file.
const media = join(base, 'media');
const outside = join(base, 'outside');
mkdirSync(join(media, 'Movies'), { recursive: true });
mkdirSync(join(media, '.hidden'), { recursive: true });
mkdirSync(outside, { recursive: true });
const FILM = Buffer.from(Array.from({ length: 10_000 }, (_, i) => i % 251));
writeFileSync(join(media, 'Movies', 'film.mp4'), FILM);
writeFileSync(join(media, 'Movies', 'empty.mp4'), '');
writeFileSync(join(media, 'song.mp3'), 'audio-bytes');
writeFileSync(join(media, '.secret'), 'hidden');
writeFileSync(join(outside, 'passwords.txt'), 'nope');
symlinkSync(outside, join(media, 'escape'), 'dir');
symlinkSync(join(outside, 'passwords.txt'), join(media, 'leak.txt'));

test('roots: add, dedupe, refuse what is not a folder, remove', () => {
  const roots = addMediaRoot(media);
  assert.deepEqual(roots.map((r) => r.name), ['media']);
  assert.equal(roots[0].path, media);

  addMediaRoot(media);                     // twice is not two shares
  assert.equal(mediaRoots().length, 1);
  assert.throws(() => addMediaRoot(join(media, 'song.mp3')), /not a folder/);
  assert.throws(() => addMediaRoot(join(base, 'gone')), /no such folder/);

  removeMediaRoot(media);
  assert.equal(mediaRoots().length, 0);
  addMediaRoot(media);                     // the rest of the file shares it
  assert.equal(mediaRoots().length, 1);
});

test('a request resolves inside the root and nowhere else', async () => {
  const [root] = mediaRoots();
  const hit = await resolveMedia(root.path, 'Movies/film.mp4');
  assert.equal(hit.path, join(media, 'Movies', 'film.mp4'));
  assert.equal(hit.stat.size, FILM.length);

  const denied = async (rel, code) =>
    assert.rejects(() => resolveMedia(root.path, rel), (e) => e.code === code);
  await denied('..', 'outside');
  await denied('../outside/passwords.txt', 'outside');
  await denied('Movies/../../outside/passwords.txt', 'outside');
  await denied('..\\outside\\passwords.txt', 'outside');
  await denied('.secret', 'hidden');
  await denied('.hidden/anything', 'hidden');
  // The links are real entries in the share, but where they lead is not.
  await denied('escape/passwords.txt', 'outside');
  await denied('leak.txt', 'outside');
  await denied('Movies/absent.mp4', 'missing');
  await denied('/etc/passwd', 'invalid');
});

test('a listing shows folders first and keeps hidden things hidden', async () => {
  const [root] = mediaRoots();
  const { entries } = await listMedia(root.path, '');
  const names = entries.map((e) => e.name);
  assert.ok(!names.includes('.secret') && !names.includes('.hidden'));
  // The escaping links keep their names - hiding them would be a lie about
  // what is on the disk - but following them is refused below.
  assert.ok(names.includes('escape') && names.includes('leak.txt'));
  assert.equal(entries[0].dir, true);

  const song = entries.find((e) => e.name === 'song.mp3');
  assert.equal(song.mime, 'audio/mpeg');
  assert.equal(song.media, true);
  assert.equal(song.size, 11);

  // Browsing into the escaping link hits the same wall the stream does.
  await assert.rejects(
    () => listMedia(root.path, 'escape'),
    (e) => e.code === 'outside'
  );
  const films = await listMedia(root.path, 'Movies');
  assert.deepEqual(films.entries.map((e) => e.path), ['Movies/empty.mp4', 'Movies/film.mp4']);
});

test('the byte server: auth first, then real HTTP media', async (t) => {
  // A stand-in for the network's device-token check: 'open' is the token.
  const authorize = (req) =>
    new URL(req.url, 'http://x').searchParams.get('t') === 'open';
  const { server, port } =
    await startMediaServer({ port: 0, host: '127.0.0.1', authorize });
  t.after(() => server.close());
  const url = (p) => `http://127.0.0.1:${port}/media${p}`;

  // Nothing is answered before auth - not even "what is shared".
  assert.equal((await fetch(url('/roots'))).status, 401);

  const roots = await (await fetch(url('/roots?t=open'))).json();
  assert.equal(roots.roots[0].name, 'media');

  const listed = await (await fetch(url('/list?t=open&root=0&path=Movies'))).json();
  assert.deepEqual(listed.entries.map((e) => e.name), ['empty.mp4', 'film.mp4']);

  // An empty file is a 200 with no body, not a range request gone wrong.
  const empty = await fetch(url('/stream?t=open&root=0&path=Movies/empty.mp4'));
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get('content-length'), '0');
  assert.equal((await empty.arrayBuffer()).byteLength, 0);

  const full = await fetch(url('/stream?t=open&root=0&path=Movies/film.mp4'));
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('content-length'), String(FILM.length));
  const whole = Buffer.from(await full.arrayBuffer());
  assert.deepEqual(whole, FILM);

  // A seek is a range, and the answer is exactly the slice asked for.
  const part = await fetch(url('/stream?t=open&root=0&path=Movies/film.mp4'),
    { headers: { range: 'bytes=100-199' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 100-199/${FILM.length}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), FILM.subarray(100, 200));

  const tail = await fetch(url('/stream?t=open&root=0&path=Movies/film.mp4'),
    { headers: { range: 'bytes=-50' } });
  assert.equal(tail.status, 206);
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), FILM.subarray(FILM.length - 50));

  const past = await fetch(url('/stream?t=open&root=0&path=Movies/film.mp4'),
    { headers: { range: 'bytes=20000-' } });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('content-range'), `bytes */${FILM.length}`);

  const head = await fetch(url('/stream?t=open&root=0&path=Movies/film.mp4'),
    { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(FILM.length));

  // The boundary holds over HTTP exactly as it does in resolveMedia.
  assert.equal((await fetch(url('/stream?t=open&root=0&path=../outside/passwords.txt'))).status, 403);
  assert.equal((await fetch(url('/stream?t=open&root=0&path=leak.txt'))).status, 403);
  assert.equal((await fetch(url('/stream?t=open&root=0&path=escape/passwords.txt'))).status, 403);
  assert.equal((await fetch(url('/stream?t=open&root=0&path=.secret'))).status, 404);
  assert.equal((await fetch(url('/stream?t=open&root=0&path=Movies'))).status, 400);
  assert.equal((await fetch(url('/stream?t=open&root=9&path=Movies/film.mp4'))).status, 404);

  // A changed client cache revalidates by etag instead of downloading again.
  const etag = head.headers.get('etag');
  const again = await fetch(url('/stream?t=open&root=0&path=Movies/film.mp4'),
    { headers: { 'if-none-match': etag } });
  assert.equal(again.status, 304);
});
