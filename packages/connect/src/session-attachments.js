/** Pictures and files attached to a message: checked here, then handed to the agent or saved for it. */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { HELM_DIR } from './paths.js';

/**
 * What a client may attach to one message.
 *
 * Image count is left to the CLI. The browser compresses image bytes, but that is a
 * courtesy, not a guarantee: `session.input` is reachable by anything
 * holding a device token, and whatever arrives is written to the event log
 * and piped into a CLI's stdin. So the limits are enforced here too, and an
 * attachment that breaks them fails the send loudly instead of being
 * quietly dropped on the way to the model.
 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHED_BYTES = 24 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const MB = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * Can this live driver be handed image bytes? One predicate, used both to
 * decide what to send and to tell the app whether to offer the clip, so the
 * two can never disagree.
 */
export function driverTakesImages(d) {
  if (!d || typeof d.sendWithAttachments !== 'function') return false;
  return d.acceptsImages?.() ?? true;
}

/**
 * Split what the owner attached into pictures, which go to the model as
 * images, and every other file (a PDF, a spreadsheet, notes), which is saved
 * on the agent's machine for it to read with its own tools.
 */
export function acceptAttachments(attachments) {
  const list = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
  const isImage = (a) => String(a.mime ?? '').toLowerCase().startsWith('image/');
  const images = acceptImages(list.filter(isImage));
  let total = images.reduce((sum, a) => sum + base64Bytes(a.data), 0);
  const files = [];
  for (const a of list.filter((a) => !isImage(a))) {
    const filename = String(a.filename ?? 'file').slice(0, 120);
    const data = String(a.data ?? '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) throw new Error(`${filename} is not valid base64`);
    const bytes = base64Bytes(data);
    if (bytes > MAX_FILE_BYTES) throw new Error(`${filename} is ${MB(bytes)}; the limit is ${MB(MAX_FILE_BYTES)}`);
    total += bytes;
    if (total > MAX_ATTACHED_BYTES) throw new Error(`those attachments come to ${MB(total)}; the limit is ${MB(MAX_ATTACHED_BYTES)} a message`);
    files.push({ filename, data });
  }
  return { images, files };
}

const base64Bytes = (data) => Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);

/**
 * Write attached files under ~/.helm/uploads/<chat>/ and say where they are,
 * in the words the agent reads after the owner's message. Each message gets
 * its own folder, so two files with one name never overwrite each other.
 */
export function saveUploads(sessionId, files, root = join(HELM_DIR, 'uploads')) {
  if (!files.length) return '';
  const dir = join(root, sessionId, randomBytes(6).toString('hex'));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lines = files.map(({ filename, data }) => {
    const name = basename(filename).replace(/[\x00-\x1f/\\]/g, '_').replace(/^\.+/, '') || 'file';
    const path = join(dir, name);
    writeFileSync(path, Buffer.from(data, 'base64'), { mode: 0o600 });
    return `[File: ${filename}]: ${JSON.stringify(path)}`;
  });
  return `The owner attached ${files.length === 1 ? 'a file' : `${files.length} files`}, saved on this machine. Read ${files.length === 1 ? 'it' : 'them'} before answering:\n${lines.join('\n')}`;
}

export function acceptImages(attachments) {
  const list = Array.isArray(attachments) ? attachments.filter(Boolean) : [];
  if (!list.length) return [];
  let total = 0;
  const out = [];
  for (const a of list) {
    const mime = String(a.mime ?? '').toLowerCase().split(';')[0].trim();
    const filename = String(a.filename ?? 'image').slice(0, 120);
    if (!mime.startsWith('image/')) throw new Error(`${filename} is ${mime || 'of unknown type'}; only images can be attached`);
    const data = String(a.data ?? '');
    if (!data) throw new Error(`${filename} arrived with no image data`);
    // Base64 is the wire form all the way to the CLIs, so it is validated
    // rather than re-encoded - a malformed payload would otherwise surface
    // as an opaque failure from inside the agent.
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) {
      throw new Error(`${filename} is not valid base64`);
    }
    const bytes = Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    if (bytes > MAX_IMAGE_BYTES) throw new Error(`${filename} is ${MB(bytes)}; the limit is ${MB(MAX_IMAGE_BYTES)}`);
    total += bytes;
    if (total > MAX_ATTACHED_BYTES) throw new Error(`those attachments come to ${MB(total)}; the limit is ${MB(MAX_ATTACHED_BYTES)} a message`);
    out.push({ filename, mime, data });
  }
  return out;
}
