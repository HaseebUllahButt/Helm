// Proof the owner can look at in a few seconds: a short clip of the app,
// or a before and after picture side by side. verify-helm records and
// pictures; this file turns them into one file that helm render can show.
import { execFile } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// helm render shows one picture up to this size.
export const RENDER_LIMIT = 2 * 1024 * 1024;
// A frame the screencast sent shows until the next one; a still page sends none.
const MIN_FRAME_S = 0.04;

/**
 * The ffmpeg concat list for screencast frames: each frame lasts until the
 * next one, and the last until the recording stopped.
 * @param {{ file: string, t: number }[]} frames  t in seconds
 */
export function concatList(frames, end) {
  const quote = (f) => `file '${f.replace(/'/g, "'\\''")}'`;
  const lines = frames.flatMap((f, i) => [quote(f.file), `duration ${Math.max((frames[i + 1]?.t ?? end) - f.t, MIN_FRAME_S).toFixed(3)}`]);
  return `${lines.join('\n')}\n`;
}

/** ffmpeg arguments for a clip: animated WebP plays in the chat, MP4 for anything longer. */
export function clipArgs(list, out, { fps = 10, width = 720 } = {}) {
  const scale = `fps=${fps},scale='min(${width},iw)':-2:flags=lanczos`;
  const input = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list];
  const ext = extname(out).toLowerCase();
  if (ext === '.mp4') return [...input, '-vf', `${scale},pad=ceil(iw/2)*2:ceil(ih/2)*2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out];
  if (ext === '.webp') return [...input, '-vf', scale, '-c:v', 'libwebp_anim', '-quality', '60', '-compression_level', '6', '-loop', '0', out];
  throw new Error('a clip is .webp (shows in the chat) or .mp4');
}

/** Turn recorded frames into a clip. Returns its length in seconds and size in bytes. */
export async function makeClip(frames, end, out, { dir, fps, width } = {}) {
  if (!frames.length) throw new Error('the recording has no frames');
  const list = join(dir, 'frames.txt');
  writeFileSync(list, concatList(frames, end));
  await run('ffmpeg', clipArgs(list, out, { fps, width })).catch((e) => {
    throw new Error(e.code === 'ENOENT' ? 'ffmpeg is not installed; install it to make clips' : `ffmpeg failed: ${String(e.stderr || e.message).trim()}`);
  });
  return { seconds: Math.max(end - frames[0].t, 0), bytes: statSync(out).size };
}

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const dataUrl = (file) => `data:image/${extname(file).slice(1).replace('jpg', 'jpeg')};base64,${readFileSync(file).toString('base64')}`;

/** A page that shows two pictures side by side, each under its label. */
export function compareHtml(before, after, { beforeLabel = 'Before', afterLabel = 'After' } = {}) {
  const side = (file, label, tone) => `<figure><figcaption style="color:${tone}">${escape(label)}</figcaption><img src="${dataUrl(file)}"></figure>`;
  return `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; background: #111; font: 600 22px/1.2 system-ui, sans-serif; }
    #pair { display: inline-flex; gap: 24px; padding: 24px; align-items: flex-start; background: #111; }
    figure { margin: 0; display: flex; flex-direction: column; gap: 12px; }
    img { display: block; max-width: 900px; max-height: 900px; width: auto; height: auto; border: 1px solid #333; border-radius: 6px; }
  </style><div id="pair">${side(before, beforeLabel, '#f2a3a3')}${side(after, afterLabel, '#9fe0a8')}</div>`;
}
