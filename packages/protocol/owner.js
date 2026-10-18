/**
 * The owner's preferences: one short list about the person, not a project
 * or a machine, that Helm puts in front of every agent it starts.
 *
 * It is owner-wide, so every machine keeps a copy and the copies reconcile
 * whenever a daemon and a hub talk (the OWNER frame), the same fingerprint
 * exchange the roster uses. It is not part of the roster: a roster record has
 * exactly one author, the machine it describes, while this list is edited
 * from any machine and by the keeper. So it is one record with one stamp and
 * the newer record wins whole. Two edits while partitioned keep the later one;
 * with a list this small that is what the owner expects.
 *
 * A machine that has never heard of a change holds the seed below. Every
 * machine starts from the same seed with the same stamp, so they agree before
 * anyone writes anything, and the first real edit anywhere wins everywhere.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { HELM_DIR, MAX_CLOCK_SKEW_MS, assertWritableDirectory } from './network.js';

export const OWNER_FILE = join(HELM_DIR, 'owner.json');

/** The hard limit on what a record may hold. The keeper keeps it to about 12. */
export const MAX_LINES = 20;
export const MAX_LINE = 300;
// The whole record on the wire. Unknown fields are kept, not dropped (see
// checkOwner), so this is what bounds them.
const MAX_BYTES = 16 * 1024;
const BY = ['seed', 'owner', 'keeper'];

/**
 * Taken once from what held the owner's preferences before Helm did: the
 * "How to talk to me" section of ~/.claude-personal/CLAUDE.md and the
 * "Talking to the owner" section of Helm's own AGENTS.md.
 */
export const SEED = Object.freeze({
  lines: Object.freeze([
    'Plain English: short replies, simple words, short sentences.',
    'No jargon. If a term cannot be avoided, explain it in a few words.',
    'Say what the owner or their client will see, not how the code does it.',
  ]),
  keeper: true,
  updatedAt: Date.UTC(2026, 9, 18),
  by: 'seed',
  why: "Taken from CLAUDE.md and Helm's AGENTS.md",
});

const line = (v, max = MAX_LINE) =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

const textList = (v) => Array.isArray(v) && v.length <= MAX_LINES && v.every((x) => line(x));

/**
 * The record if every field is what it claims to be, else null.
 *
 * Validate and reject, never repair: a record changed on the way in is one
 * whose author keeps re-sending the original, and the two machines then
 * trade it on every tick for ever. Unknown fields pass untouched for the same
 * reason - a newer Helm may add one, and an older one must not strip it.
 */
export function checkOwner(rec, { now = Date.now() } = {}) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  let size;
  try { size = Buffer.byteLength(JSON.stringify(rec)); } catch { return null; }
  if (size > MAX_BYTES) return null;
  if (!textList(rec.lines)) return null;
  if (typeof rec.keeper !== 'boolean') return null;
  if (!Number.isFinite(rec.updatedAt) || rec.updatedAt < 0 || rec.updatedAt > now + MAX_CLOCK_SKEW_MS) return null;
  if (!BY.includes(rec.by)) return null;
  if (rec.where !== undefined && !line(rec.where, 64)) return null;
  if (rec.why !== undefined && !line(rec.why, 200)) return null;
  if (rec.learned !== undefined) {
    const l = rec.learned;
    if (!l || typeof l !== 'object' || !Number.isFinite(l.at) || !textList(l.added) || !textList(l.removed)) return null;
  }
  return rec;
}

const stable = (v) => (Array.isArray(v) ? v.map(stable)
  : v && typeof v === 'object' ? Object.keys(v).sort().reduce((o, k) => { o[k] = stable(v[k]); return o; }, {}) : v);

/** A short fingerprint, the same on every machine holding the same record. */
export const ownerHash = (rec) =>
  createHash('sha256').update(JSON.stringify(stable(rec ?? null))).digest('base64url').slice(0, 16);

/**
 * Newer stamp wins. Equal stamps with different contents are settled by the
 * fingerprint, so two machines can never each keep their own and disagree.
 */
export const newerOwner = (a, b) =>
  (b.updatedAt > a.updatedAt || (b.updatedAt === a.updatedAt && ownerHash(b) > ownerHash(a)) ? b : a);

export function loadOwner(file = OWNER_FILE) {
  if (!existsSync(file)) return SEED;
  try { return checkOwner(JSON.parse(readFileSync(file, 'utf8'))) ?? SEED; } catch { return SEED; }
}

function write(rec, file) {
  assertWritableDirectory();
  mkdirSync(HELM_DIR, { recursive: true, mode: 0o700 });
  // Whole old or whole new: the daemon and the hub on this machine both read it.
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(rec, null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
  return rec;
}

/** Take a record from another machine. True when it replaced ours. */
export function mergeOwner(incoming, { file = OWNER_FILE, now = Date.now() } = {}) {
  const theirs = checkOwner(incoming, { now });
  if (!theirs) return false;
  const ours = loadOwner(file);
  if (newerOwner(ours, theirs) !== theirs || ownerHash(theirs) === ownerHash(ours)) return false;
  write(theirs, file);
  return true;
}

/** One line as it is kept: trimmed, one line, bullets and doubles gone. */
export function cleanLines(lines) {
  const out = [];
  for (const raw of Array.isArray(lines) ? lines : String(lines ?? '').split('\n')) {
    const text = String(raw ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim();
    if (text && !out.some((x) => x.toLowerCase() === text.toLowerCase())) out.push(text);
  }
  return out;
}

/**
 * Change the list here, as the owner (from the app) or the keeper.
 *
 * Nothing changes when nothing would: the same lines and switch return the
 * record as it was, stamp and all, so a save with no edit spreads nothing.
 * The stamp only moves forward, even on a machine whose clock is behind the
 * record it holds, or the edit would lose to the older record.
 */
export function editOwner({ lines, keeper } = {}, { by = 'owner', where, why, now = Date.now(), file = OWNER_FILE } = {}) {
  const current = loadOwner(file);
  const next = lines === undefined ? [...current.lines] : cleanLines(lines);
  if (next.length > MAX_LINES) throw new Error(`keep the list to ${MAX_LINES} lines or fewer`);
  const long = next.find((l) => l.length > MAX_LINE);
  if (long) throw new Error(`a line can be at most ${MAX_LINE} characters: "${long.slice(0, 40)}…"`);
  const on = keeper === undefined ? current.keeper : keeper === true;
  const same = next.length === current.lines.length && next.every((l, i) => l === current.lines[i]);
  if (same && on === current.keeper) return { record: current, changed: false };
  const record = {
    lines: next,
    keeper: on,
    updatedAt: Math.max(now, current.updatedAt + 1),
    by,
    ...(where ? { where: String(where).slice(0, 64) } : {}),
    ...(why ? { why: String(why).slice(0, 200) } : {}),
    ...(current.learned ? { learned: current.learned } : {}),
  };
  if (by === 'keeper' && !same) {
    record.learned = {
      at: record.updatedAt,
      added: next.filter((l) => !current.lines.includes(l)),
      removed: current.lines.filter((l) => !next.includes(l)),
    };
  }
  if (!checkOwner(record, { now: record.updatedAt })) throw new Error('that list cannot be saved');
  return { record: write(record, file), changed: true };
}
