import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { concatList, clipArgs, makeClip, compareHtml } from '../scripts/proof-media.mjs';

const dir = mkdtempSync(join(tmpdir(), 'helm-proof-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('each frame lasts until the next one, and the last until the stop', () => {
  const list = concatList([{ file: '/a/0.jpg', t: 10 }, { file: "/a/it's.jpg", t: 10.5 }, { file: '/a/2.jpg', t: 10.5 }], 12);
  assert.equal(list, [
    "file '/a/0.jpg'", 'duration 0.500',
    "file '/a/it'\\''s.jpg'", 'duration 0.040',
    "file '/a/2.jpg'", 'duration 1.500', '',
  ].join('\n'));
});

test('clips are WebP for the chat or MP4, nothing else', () => {
  assert.ok(clipArgs('l.txt', 'c.webp').includes('libwebp_anim'));
  assert.ok(clipArgs('l.txt', 'c.mp4').includes('libx264'));
  assert.throws(() => clipArgs('l.txt', 'c.avi'), /\.webp/);
});

test('recorded frames become a playing clip of the right length', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, async () => {
  const frames = ['red', 'blue'].map((color, i) => {
    const file = join(dir, `${i}.jpg`);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=64x48`, '-frames:v', '1', file]);
    return { file, t: 100 + i };
  });
  const out = join(dir, 'clip.mp4');
  const { seconds, bytes } = await makeClip(frames, 102, out, { dir, fps: 10 });
  assert.equal(seconds, 2);
  assert.ok(bytes > 0);
  const length = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' }));
  assert.ok(Math.abs(length - 2) < 0.25, `clip lasts ${length} s`);
  await makeClip(frames, 102, join(dir, 'clip.webp'), { dir });
  assert.equal(readFileSync(join(dir, 'clip.webp')).subarray(8, 12).toString(), 'WEBP');
});

test('the side-by-side page labels both pictures and embeds them', () => {
  const png = join(dir, 'p.png');
  writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  const html = compareHtml(png, png, { beforeLabel: 'Before <fix>', afterLabel: 'After' });
  assert.match(html, /Before &lt;fix&gt;/);
  assert.match(html, />After</);
  assert.equal(html.match(/data:image\/png;base64,/g).length, 2);
});
