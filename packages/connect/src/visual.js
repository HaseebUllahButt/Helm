import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseFragment, serialize } from 'parse5';
import { visualDocument } from '@helm/protocol/visual';

export const MAX_VISUAL_BYTES = 4 * 1024 * 1024;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Live pages stay separate from saved HTML; never fetch an agent's URL here. */
export function visualUrl(value) {
  if (typeof value !== 'string') throw new Error('canvas URL must be http or https without a login');
  let url;
  try { url = new URL(value); } catch { throw new Error('canvas URL must be http or https without a login'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('canvas URL must be http or https without a login');
  return url.href;
}

export function validateVisual({ html, title = 'Visual reply', height = 420, renderId, placement, url }) {
  if (url !== undefined) {
    url = visualUrl(url);
    if (placement !== 'canvas') throw new Error('live pages must open in canvas');
    const escaped = url.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    html = `<p><a href="${escaped}">Open live page</a></p>`;
  }
  if (typeof html !== 'string' || !html.trim() || Buffer.byteLength(html) > MAX_VISUAL_BYTES) {
    throw new Error('a visual must contain HTML, up to 4 MiB including embedded images');
  }
  if (typeof title !== 'string' || !title.trim() || title.length > 160) throw new Error('visual title must be 1–160 characters');
  if (!Number.isInteger(height) || height < 120 || height > 1200) throw new Error('visual height must be an integer from 120 to 1200');
  if (!/^[a-f0-9]{24}$/.test(renderId ?? '')) throw new Error('invalid render ID');
  if (placement !== undefined && placement !== 'canvas') throw new Error('invalid visual placement');
  const normalized = serialize(parse(html));
  if (Buffer.byteLength(normalized) > MAX_VISUAL_BYTES) throw new Error('visual exceeds 4 MiB');
  return { html: normalized, title: title.trim(), height, renderId, ...(placement ? { placement } : {}), ...(url ? { url } : {}) };
}

/** Only recognized image bytes may be copied into a page, never arbitrary files. */
export function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (bytes.subarray(4, 8).toString() === 'ftyp' && /^(avif|avis)$/.test(bytes.subarray(8, 12).toString())) return 'image/avif';
  const text = bytes.toString('utf8').replace(/^\s*<\?xml[^>]*>\s*/i, '');
  if (/^\s*<svg\b/i.test(text) && /<\/svg>\s*$/i.test(text)) {
    const nodes = parseFragment(text).childNodes.filter(n => n.nodeName !== '#text' || n.value.trim());
    if (nodes.length === 1 && nodes[0].tagName === 'svg') return 'image/svg+xml';
  }
  throw new Error('local visual assets must be PNG, JPEG, GIF, WebP, AVIF, or SVG images');
}

/** Snapshot local assets on the publishing machine, before any remote RPC. */
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|avif|svg)$/i;

export async function prepareVisual(file) {
  const path = resolve(file), source = await stat(path);
  // A screenshot on its own needs no page around it: show it at chat width.
  const picture = IMAGE_FILE.test(path);
  if (!source.isFile() || (!picture && source.size > MAX_HTML_BYTES)) throw new Error('HTML source must be a file up to 512 KiB');
  const html = picture
    ? `<!doctype html><img src="${encodeURIComponent(basename(path))}" alt="" style="display:block;max-width:100%;height:auto">`
    : await readFile(path, 'utf8');
  if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw new Error('HTML source exceeds 512 KiB');
  const doc = parse(html), cache = new Map();
  let embeddedBytes = Buffer.byteLength(html);
  const embed = async (url) => {
    if (!url || /^(?:data:|https?:|blob:|#|\/\/)/i.test(url)) return url;
    if (/^[a-z][a-z\d+.-]*:/i.test(url) && !url.startsWith('file:')) throw new Error(`unsupported image URL: ${url}`);
    const [asset, suffix = ''] = url.split(/(?=[?#])/s, 2);
    const local = asset.startsWith('file:') ? fileURLToPath(asset) : resolve(dirname(path), decodeURIComponent(asset));
    if (!cache.has(local)) {
      const info = await stat(local);
      if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error('each local image must be a file up to 2 MiB');
      const bytes = await readFile(local);
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error('local image exceeds 2 MiB');
      const data = `data:${imageMime(bytes)};base64,${bytes.toString('base64')}`;
      cache.set(local, data);
    }
    const data = cache.get(local);
    embeddedBytes += Buffer.byteLength(data);
    if (embeddedBytes > MAX_VISUAL_BYTES) throw new Error('visual exceeds 4 MiB including images');
    return data + (suffix.startsWith('#') ? suffix : '');
  };
  const css = async (text) => {
    const matches = [...text.matchAll(/url\(\s*(?:(["'])(.*?)\1|([^)'"\s]+))\s*\)/gi)];
    for (const match of matches.reverse()) text = text.slice(0, match.index) + `url("${await embed(match[2] ?? match[3])}")` + text.slice(match.index + match[0].length);
    return text;
  };
  const walk = async (node) => {
    for (const attr of node.attrs ?? []) {
      if ((['img', 'source'].includes(node.tagName) && attr.name === 'src') || (node.tagName === 'video' && attr.name === 'poster') || (node.tagName === 'image' && attr.name === 'href')) attr.value = await embed(attr.value);
      if (['img', 'source'].includes(node.tagName) && attr.name === 'srcset') {
        // Data URLs already contain commas; self-contained srcsets stay intact.
        if (!attr.value.includes('data:')) {
          const entries = [];
          for (const entry of attr.value.split(',')) {
            const [url, ...size] = entry.trim().split(/\s+/);
            entries.push([await embed(url), ...size].join(' '));
          }
          attr.value = entries.join(', ');
        }
      }
      if (attr.name === 'style') attr.value = await css(attr.value);
    }
    if (node.tagName === 'style') for (const child of node.childNodes ?? []) if (child.nodeName === '#text') child.value = await css(child.value);
    for (const child of node.childNodes ?? []) await walk(child);
    if (node.content) await walk(node.content);
  };
  await walk(doc);
  const snapshot = serialize(doc);
  if (Buffer.byteLength(snapshot) > MAX_VISUAL_BYTES) throw new Error('visual exceeds 4 MiB including images');
  return snapshot;
}

/** An isolated browser: no user profile, no Helm/network state, always closed. */
export async function previewVisual(html, { output, width = 900, appearance = 'dark' } = {}) {
  if (!Number.isInteger(width) || width < 240 || width > 1600) throw new Error('preview width must be 240–1600');
  if (!['dark', 'light'].includes(appearance)) throw new Error('appearance must be dark or light');
  const { chromium } = await import('playwright');
  const executablePath = process.env.HELM_CHROMIUM_PATH || process.env.HELM_TEST_CHROMIUM
    || ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
  let browser;
  try { browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), timeout: 15_000 }); }
  catch (error) { throw new Error(`preview needs Chromium; set HELM_CHROMIUM_PATH or run npx playwright install chromium. ${error.message}`); }
  try {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(10_000);
    const messages = [], errors = [];
    page.on('console', msg => { if (messages.length < 30) messages.push({ level: msg.type(), text: msg.text().slice(0, 1000) }); });
    page.on('pageerror', err => { if (errors.length < 30) errors.push(err.message.slice(0, 1000)); });
    const theme = appearance === 'light' ? { scheme: 'light', '--bg': '#f3f4f7', '--card': '#ffffff', '--raised': '#ffffff', '--text': '#1a1d24', '--text-dim': '#3d4350', '--mutedfg': '#5a6170', '--line': 'rgb(26 29 36 / 10%)', '--primary': 'oklch(0.52 0.18 270)', '--primary-q': '#4450c8', '--amber': '#c98a1a', '--amber-text': '#8a5a00', '--sky': '#2a6690', '--emerald': '#1f7356', '--red': '#b8322a' } : { scheme: 'dark' };
    const doc = visualDocument(html, { theme });
    await page.setContent('<iframe sandbox="allow-scripts" style="border:0;width:100%;height:900px"></iframe><style>body{margin:0}</style>');
    await page.locator('iframe').evaluate((frame, src) => { frame.srcdoc = src; }, doc);
    await page.frameLocator('iframe').locator('meta[http-equiv="Content-Security-Policy"]').waitFor({ state: 'attached' });
    const frame = page.frames()[1];
    await frame.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
    const contentHeight = await frame.evaluate(() => Math.ceil(document.body.scrollHeight));
    const height = Math.max(120, Math.min(contentHeight, 5000));
    await page.setViewportSize({ width, height });
    await page.locator('iframe').evaluate((el, h) => { el.style.height = `${h}px`; }, height);
    await page.locator('iframe').screenshot({ path: output, animations: 'disabled', timeout: 10_000 });
    return { output, width, height, contentHeight, clipped: contentHeight > height, messages, errors };
  } finally { await browser.close(); }
}

/** Native providers keep their transcript; saved visuals join it by timestamp. */
export function withVisualMessages(messages, events) {
  const result = [...messages];
  const millis = value => typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  for (const event of events.filter(e => e.type === 'item.start' && e.kind === 'visual' && e.visual)) {
    const message = { role: 'assistant', text: '', tools: [], at: event.at, sourceId: event.id, visual: event.visual };
    const index = result.findIndex(m => millis(m.at) > event.at);
    result.splice(index < 0 ? result.length : index, 0, message);
  }
  return result;
}
