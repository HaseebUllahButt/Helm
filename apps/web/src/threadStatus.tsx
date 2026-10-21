import { useEffect, useSyncExternalStore } from 'react';
import { Icon } from './Icon';
import { busyWord, needsAttention, runningThread } from './format';
import { useNow, waitingSince } from './useNow';

/**
 * What a sidebar row says at its right edge, in one slot: it is working (with
 * a clock), it needs you, it failed, it finished and you have not looked yet,
 * or - when none of that is true - how long ago it last did anything.
 */

type Thread = {
  id: string; status?: string; compacting?: unknown; updatedAt?: number; turns?: number; alive?: boolean;
  /** When the owner last looked, on any device - the machine keeps it. */
  seenAt?: number;
  team?: { working?: number; blocked?: number; failed?: number };
  recovery?: { kind?: string } | null;
  /** Started on a repo still coming down from GitHub. */
  clone?: { state?: string; percent?: number } | null;
  chatWorktree?: { setup?: string } | null;
};

export type ThreadMood = 'needs' | 'failed' | 'working' | 'unread' | 'quiet';

/** The turn failed (or hit a limit) and nothing is running on top of it. */
export const failedThread = (s: Thread) =>
  !runningThread(s) && (['error', 'limited'].includes(s.recovery?.kind ?? '') || !!s.team?.failed || s.clone?.state === 'failed');

export function moodOf(s: Thread, unread: boolean): ThreadMood {
  if (s.status === 'blocked') return 'needs';
  // A thread still working with a snoozed alert on a helper is, here, working.
  if (runningThread(s)) return 'working';
  if (failedThread(s)) return 'failed';
  if (needsAttention(s)) return 'needs';
  return unread ? 'unread' : 'quiet';
}

// ------------------------------------------------------------ seen / unread

const SEEN_KEY = 'helm-seen:v1';
const KEEP_MS = 30 * 86_400_000;
type Seen = { since: number; at: Record<string, number> };
let seen: Seen | null = null;
const watchers = new Set<() => void>();
let version = 0;

function readSeen(): Seen {
  if (seen) return seen;
  let stored: Seen | null = null;
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed.since === 'number' && parsed.at && typeof parsed.at === 'object') stored = parsed;
  } catch { /* storage denied or damaged: start fresh */ }
  // The first time this device runs this, everything already finished counts
  // as read - otherwise the whole history would light up green at once.
  seen = stored ?? { since: Date.now(), at: {} };
  if (!stored) writeSeen();
  return seen;
}

function writeSeen() {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch { /* full or blocked: the check just returns next visit */ }
}

/**
 * The owner has looked at this thread as it is now. This device answers at
 * once; the machine is told too (by the caller), so the others follow.
 * False when this device already had it as seen.
 */
export function markSeen(id: string, at = Date.now()): boolean {
  const state = readSeen();
  if ((state.at[id] ?? 0) >= at) return false;
  state.at[id] = at;
  const cutoff = Date.now() - KEEP_MS;
  for (const key of Object.keys(state.at)) if (state.at[key] < cutoff) delete state.at[key];
  writeSeen();
  version += 1;
  watchers.forEach((fn) => fn());
  return true;
}

/** When this device last looked at the thread; 0 when it never did. */
export const seenHere = (id: string) => readSeen().at[id] ?? 0;

/** Re-render when something was marked seen. */
export function useSeenVersion() {
  return useSyncExternalStore(
    (fn) => { watchers.add(fn); return () => { watchers.delete(fn); }; },
    () => version,
    () => version,
  );
}

/** Finished since the owner last looked: a settled thread whose finish time is newer than the last look. */
export function isUnread(s: Thread): boolean {
  if (!s.updatedAt || (s.turns ?? 0) < 1) return false;
  if (s.status !== 'idle' && s.status !== 'done') return false;
  const state = readSeen();
  return s.updatedAt > Math.max(state.since, state.at[s.id] ?? 0, s.seenAt ?? 0);
}

// ------------------------------------------------------------- turn clock

/**
 * When the current turn began. The machine does not send a start time, only
 * when the thread last changed - which other small changes can move. So the
 * first moment this screen sees the thread working is kept, and used until it
 * stops (or has not been drawn for a while, in which case the machine's own
 * time is the better guess again).
 */
const started = new Map<string, { from: number; last: number }>();
const STALE_MS = 60_000;

export function turnStart(s: Thread, now = Date.now()): number {
  const known = started.get(s.id);
  if (known && now - known.last < STALE_MS) { known.last = now; return known.from; }
  const from = Math.min(s.updatedAt || now, now);
  started.set(s.id, { from, last: now });
  return from;
}
export const forgetTurn = (id: string) => { started.delete(id); };

/** "45s", "2m 05s", "1h 05m". */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m ${String(total % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/** "5m", "2h", "3d" - and "now" for the first moments. */
export const compactAge = (ts: number | undefined, now: number) => {
  const text = waitingSince(ts, now);
  return text === 'just now' ? 'now' : text;
};

/** "wrapped up 2h ago", split so a phone can drop the lead-in. */
export const wrappedUp = (ts: number | undefined, now: number): { lead: string; rest: string } => {
  const text = waitingSince(ts, now);
  return !text ? { lead: '', rest: '' } : text === 'just now' ? { lead: 'finished ', rest: 'just now' } : { lead: 'finished ', rest: `${text} ago` };
};

export function ThreadStatus({ s, mood, now, label }: { s: Thread; mood: ThreadMood; now: number; label?: string }) {
  const live = mood === 'working';
  // Re-draw every second, but only while something is working.
  const tick = useNow(1000, live);
  useEffect(() => { if (!live) forgetTurn(s.id); }, [live, s.id]);
  if (mood === 'needs') {
    return <span className="tstat needs" data-mood="needs"><Icon name="ask" size={13} /><span>Needs you</span></span>;
  }
  if (mood === 'failed') {
    return <span className="tstat failed" data-mood="failed"><Icon name="alert" size={13} /><span>Failed</span></span>;
  }
  if (mood === 'working') {
    // "starting" and "compacting" are not the turn's work yet; the word says so.
    const word = s.clone?.state === 'cloning' ? `copying from GitHub ${s.clone.percent ?? 0}%`
      : s.chatWorktree?.setup === 'running' ? 'setting up' : busyWord(s.status, s.compacting);
    return (
      <span className="tstat working" data-mood="working">
        <Icon name="think" size={13} className="tspin" />
        <span className="tclock">{word === 'working' ? clock(tick - turnStart(s, tick)) : word === 'compacting' ? 'shortening chat history' : word}</span>
      </span>
    );
  }
  if (mood === 'unread') {
    return <span className="tstat unread" data-mood="unread" role="img" aria-label="Finished. You have not opened this chat." title="Finished. You have not opened this chat."><Icon name="check" size={14} /></span>;
  }
  const age = label ?? compactAge(s.updatedAt, now);
  return age ? <span className="tstat quiet" data-mood="quiet">{age}</span> : null;
}
