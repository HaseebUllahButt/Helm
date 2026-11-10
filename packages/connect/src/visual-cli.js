import { randomBytes } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { FILE_PIECE_BYTES, MAX_ORIGINAL_BYTES, preparePdf, prepareVisual, previewVisual, visualUrl } from './visual.js';

const PICTURE = /\.(?:png|jpe?g|gif|webp|avif|svg)$/i;

/**
 * Send the original file to the chat's machine in pieces, so the canvas can
 * Download it. A machine with an older Helm cannot take it: the visual still
 * shows, only without Download.
 */
async function uploadOriginal(rpc, env, id, renderId, path) {
  const handle = await open(path, 'r');
  try {
    const size = (await handle.stat()).size;
    if (!size || size > MAX_ORIGINAL_BYTES) return false;
    const buf = Buffer.alloc(Math.min(FILE_PIECE_BYTES, size));
    for (let offset = 0; offset < size;) {
      const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, size - offset), offset);
      if (!bytesRead) throw new Error(`${basename(path)} changed while Helm read it`);
      try { await rpc(env, 'session.visual-file', { id, renderId, offset, data: buf.subarray(0, bytesRead).toString('base64') }, 60_000); }
      catch (error) { if (/unknown method|not supported/i.test(error.message)) return false; throw error; }
      offset += bytesRead;
    }
    return true;
  } finally { await handle.close(); }
}

export async function runVisualCommand(command, args, { rpc, self, findSession, env = process.env, print = console.log, preview = previewVisual } = {}) {
  const options = {}, files = [];
  const flags = new Set(command !== 'preview' ? ['title', 'height', 'session', 'render-id'] : ['output', 'width', 'appearance']);
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (!flags.has(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`invalid visual option: ${args[i]}`);
      options[key] = args[++i];
    } else files.push(args[i]);
  }
  if (files.length !== 1) throw new Error(`usage: helm ${command} <file.html | picture.png | file.pdf${command === 'canvas' ? ' | https://…' : ''}>`);
  const url = command === 'canvas' && /^[a-z][a-z0-9+.-]*:/i.test(files[0]) ? visualUrl(files[0]) : undefined;
  const pdfFile = !url && command !== 'preview' && /\.pdf$/i.test(files[0]);
  const projectFile = command === 'canvas' && !url && !pdfFile && !/\.html?$/i.test(files[0]) && !PICTURE.test(files[0]);
  const pdf = pdfFile ? await preparePdf(files[0]) : undefined;
  if (pdf && pdf.pages.length < pdf.total) print(`Showing the first ${pdf.pages.length} of ${pdf.total} pages.`);
  const html = url || projectFile || pdfFile ? undefined : await prepareVisual(files[0]);
  if (command === 'preview') {
    const output = resolve(options.output || `${tmpdir()}/helm-visual-${randomBytes(6).toString('hex')}.png`);
    const result = await preview(html, { output, width: Number(options.width ?? 900), appearance: options.appearance ?? 'dark' });
    print(JSON.stringify(result, null, 2));
    return result;
  }
  const id = options.session || env.HELM_SESSION_ID || env.HELM_NATIVE_SESSION;
  if (!id) throw new Error(`run helm ${command} inside an agent chat, or pass --session <chat-id>`);
  const target = options.session ? await findSession(id) : { env: self(), session: { id } };
  const renderId = options['render-id'] || randomBytes(12).toString('hex');
  if (projectFile) {
    // Explicit sessions can live on another machine: keep their relative paths there.
    const path = options.session ? files[0] : resolve(files[0]);
    const result = await rpc(target.env, 'session.canvas', { id: target.session.id, path, requestId: renderId }, 60_000);
    print(JSON.stringify({ sessionId: target.session.id, ...result }, null, 2));
    return result;
  }
  // The original PDF or picture goes first, for Download. A saved page downloads as the page itself.
  const original = pdfFile || (!url && PICTURE.test(files[0])) ? resolve(files[0]) : undefined;
  const params = { id: target.session.id, ...(pdf ? { pages: pdf.pages, total: pdf.total } : { html }), ...(url ? {} : { name: basename(files[0]) }), title: options.title || 'Visual reply', height: Number(options.height ?? 420), renderId, ...(command === 'canvas' ? { placement: 'canvas', ...(url ? { url } : {}) } : {}) };
  let result;
  try {
    if (original && (await stat(original)).size <= MAX_ORIGINAL_BYTES && await uploadOriginal(rpc, target.env, target.session.id, renderId, original)) params.upload = true;
    result = await rpc(target.env, 'session.render', params, 60_000);
  }
  catch (error) { throw new Error(`${error.message}. If delivery is uncertain, retry the same file and options with --render-id ${renderId}; that ID prevents duplicate visuals.`); }
  print(JSON.stringify({ sessionId: target.session.id, renderId, ...result }, null, 2));
  return result;
}
