/**
 * The limit balancer: which account new work goes to when nobody picked one
 * by hand. A hand pick always wins. Otherwise work stays on the usual
 * account until that account is out of limit, then moves to another
 * account of the same AI tool that has limit left, so models and settings
 * still fit. Shared by the app (new chat) and the daemon (helm delegate,
 * helm spawn), so both decide the same way.
 *
 * Windows are `limitWindows` rows: { label, used (percent), resetsAt (Unix seconds) }.
 */

/** Percent used at which an account counts as out of limit. */
export const OUT_AT = 98;
/** Percent left another account needs before work moves to it. */
export const ROOM_NEEDED = 10;

/** A window whose reset time has passed is fresh again. */
export function liveWindows(windows = [], now = Date.now()) {
  return (windows ?? []).filter((w) => Number.isFinite(w?.used) && !(w.resetsAt && w.resetsAt * 1000 <= now));
}

/** Percent left in the tightest window that still runs; null when nothing is known. */
export function roomLeft(windows = [], now = Date.now()) {
  if (!(windows ?? []).some((w) => Number.isFinite(w?.used))) return null;
  const live = liveWindows(windows, now);
  if (!live.length) return 100;
  return Math.max(0, Math.round((100 - Math.max(...live.map((w) => w.used))) * 10) / 10);
}

/** When an account that is out can work again (Unix seconds), or null. */
export function outUntil(windows = [], now = Date.now()) {
  const full = liveWindows(windows, now).filter((w) => w.used >= OUT_AT);
  if (!full.length) return null;
  const resets = full.map((w) => w.resetsAt).filter(Number.isFinite);
  return resets.length === full.length ? Math.max(...resets) : null;
}

export const isOut = (windows, now = Date.now()) => liveWindows(windows, now).some((w) => w.used >= OUT_AT);

/** Most room first; an account with no readings comes after every known one with room. */
function roomiest(candidates, now) {
  const rated = candidates.map((c) => ({ c, room: roomLeft(c.windows, now) }));
  const known = rated.filter((r) => r.room !== null && r.room >= ROOM_NEEDED).sort((a, b) => b.room - a.room);
  const unknown = rated.filter((r) => r.room === null);
  return [...known, ...unknown][0] ?? null;
}

/**
 * Keep `wanted` unless it is out of limit; then move to the account of the
 * same tool with the most limit left. `candidates`: [{ key, engine, windows }].
 *
 * Returns { key, switched } and, when `wanted` is out, `until` (Unix
 * seconds, or null). When it switched, also `from` and `room` (percent left
 * in the new account, or null when unknown).
 */
export function balance(candidates, wanted, now = Date.now()) {
  const want = candidates.find((c) => c.key === wanted);
  if (!want || !isOut(want.windows, now)) return { key: wanted, switched: false };
  const until = outUntil(want.windows, now);
  const best = roomiest(candidates.filter((c) => c !== want && c.engine === want.engine && !isOut(c.windows, now)), now);
  if (!best) return { key: wanted, switched: false, until };
  return { key: best.c.key, switched: true, from: wanted, until, room: best.room };
}

/** The account with the most limit left, for "any account of this tool". */
export function pickRoomiest(candidates, now = Date.now()) {
  const open = candidates.filter((c) => !isOut(c.windows, now));
  const low = open.map((c) => ({ c, room: roomLeft(c.windows, now) })).sort((a, b) => (b.room ?? -1) - (a.room ?? -1));
  return (roomiest(open, now) ?? low[0])?.c ?? candidates[0] ?? null;
}
