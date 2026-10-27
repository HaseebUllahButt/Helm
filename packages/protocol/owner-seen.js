import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { HELM_DIR } from './network.js';

/**
 * When the owner last used Helm in a browser on this machine.
 *
 * The hub notes it when the app served by this machine itself (over
 * loopback, signed in as a device, never a machine credential) asks for
 * something only a person does: start a chat, type, answer. Agents ask
 * which machine the owner sits at (`helm forward` with no --to), so the
 * local link they give opens where the owner is.
 */
const FILE = () => join(HELM_DIR, 'owner-seen.json');
// Rare writes: a few per minute are enough to pick a machine.
const EVERY_MS = 20_000;
let last = 0;

/** Methods only a person sends from the app. */
export const OWNER_METHODS = new Set([
  'session.start', 'session.input', 'session.deliver', 'session.answer',
  'session.send-now', 'session.interrupt', 'session.attach',
]);

export function noteOwnerSeen(now = Date.now()) {
  if (now - last < EVERY_MS) return;
  last = now;
  try {
    const tmp = `${FILE()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ at: now }) + '\n', { mode: 0o600 });
    renameSync(tmp, FILE());
  } catch { /* a hint, never worth a failure */ }
}

export function ownerSeenAt() {
  try {
    const at = Number(JSON.parse(readFileSync(FILE(), 'utf8'))?.at);
    return Number.isFinite(at) && at > 0 ? at : null;
  } catch { return null; }
}

/** For tests: forget the last write, so the next note is written. */
export const resetOwnerSeen = () => { last = 0; };
