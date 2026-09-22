import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveMedia, MediaError } from './resolve.js';

/**
 * What a file is served as, from its name alone.
 *
 * The browser is the player, so this map only needs to cover what a browser
 * can plausibly decode plus the types it tolerates anyway. An unknown name
 * answers null rather than a guess: serving a made-up type is how a file the
 * player cannot read gets labelled as one it can.
 */
const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm',
  mkv: 'video/x-matroska', mov: 'video/quicktime', avi: 'video/x-msvideo',
  ts: 'video/mp2t', m2ts: 'video/mp2t', '3gp': 'video/3gpp', '3g2': 'video/3gpp2',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus', wav: 'audio/wav',
  wma: 'audio/x-ms-wma',
  vtt: 'text/vtt', srt: 'application/x-subrip',
};

export const mediaMime = (name) =>
  MIME[/\.([a-z0-9]+)$/.exec(String(name).toLowerCase())?.[1]] ?? null;

/** Playable in the media view: video and audio, nothing else. */
export const isMedia = (mime) => /^(video|audio)\//.test(mime ?? '');

/**
 * One directory beneath a shared root, listed for browsing.
 *
 * Reads are on demand and cheaply cached: a media folder changes rarely,
 * so the listing is kept keyed by the directory's own mtime and redone only
 * when the directory itself changed. That is the whole index - there is no
 * media database here, because the NAS does not own the library.
 *
 * Hidden names are skipped rather than listed, matching resolveMedia: a
 * private file is not merely unservable, it is absent. A symlinked entry is
 * listed under its own name - following it happens at resolve time, which is
 * where the escape check lives.
 */
const cache = new Map();

export async function listMedia(rootPath, rel = '') {
  const { path, stat: info } = await resolveMedia(rootPath, rel);
  if (!info.isDirectory()) {
    throw new MediaError('not-dir', 'that is a file, not a folder');
  }

  const cached = cache.get(path);
  if (cached && cached.mtimeMs === info.mtimeMs) return cached.listing;

  const base = rel.split(/[\\/]+/).filter(Boolean).join('/');
  const entries = [];
  for (const d of await readdir(path, { withFileTypes: true })) {
    if (d.name.startsWith('.')) continue;
    const s = await stat(join(path, d.name)).catch(() => null);
    // A dangling link cannot be served, so it cannot be browsed either.
    if (!s) continue;
    const dir = s.isDirectory();
    const mime = dir ? null : mediaMime(d.name);
    entries.push({
      name: d.name,
      path: base ? `${base}/${d.name}` : d.name,
      dir,
      size: dir ? null : s.size,
      mtime: s.mtimeMs,
      mime,
      media: isMedia(mime),
    });
  }
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));

  const listing = { path: base, entries };
  cache.set(path, { mtimeMs: info.mtimeMs, listing });
  return listing;
}
