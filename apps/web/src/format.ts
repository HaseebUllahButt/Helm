/**
 * How helm says numbers. Money and duration appear per turn, per thread and
 * in the session list, and they have to agree everywhere: a turn that reads
 * `$0.02` must not roll up into a thread that reads `0.0243`.
 */

/**
 * How long something took, the way a person says it: "45s", "3m 43s",
 * "1h 05m". Whole seconds, so a ticking counter never wobbles in width.
 */
export const seconds = (ms?: number) => {
  if (ms == null || !Number.isFinite(ms)) return '';
  if (ms < 1000) return '<1s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
};

/**
 * A name Helm shortened itself ends in "…" (see promptTitle). On screen the
 * dots go and the end fades instead, the same as a name the edge cuts.
 */
export const shownTitle = (title = '') => {
  const end = /\s*(?:…|\.{3})$/.exec(title);
  return end && end.index > 0 ? { text: title.slice(0, end.index), cut: true } : { text: title, cut: false };
};

/** Sub-cent work is real work; it just is not a number worth printing. */
export const money = (usd?: number | null) =>
  (usd == null || usd <= 0 ? '' : usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`);

/** A file size for a person, e.g. a transfer. */
export const bytes = (n?: number | null) =>
  (n == null ? ''
    : n < 1024 ? `${n} B`
    : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB`
    : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB`
    : `${(n / 1024 ** 3).toFixed(1)} GB`);

/**
 * Where a thread stands, in the three words Home sorts by. Every list and
 * count - sidebar, machine screen, the machine rows - asks these, so a
 * thread is never "running" in one place and "done" in another.
 *
 * Running is any work in progress: a CLI still starting up, a turn that is
 * thinking, calling tools or compacting, or a parent whose child tasks are
 * still going. Done is the one claim that has to be earned: the agent said
 * it is idle. Exited, unknown or missing words are not a finished task.
 */
export interface ThreadState {
  status?: string;
  team?: { working?: number; blocked?: number; failed?: number };
  recovery?: { kind?: string } | null;
  /** Started on a repo still coming down from GitHub; a failed one waits for "Try again". */
  clone?: { state?: string } | null;
}

/** Listed as a thread: not a helper, or a helper with no parent thread to sit under. */
export const listedThread = (s: { delegation?: unknown; unhomed?: boolean }) => !s.delegation || !!s.unhomed;

/** The agent itself is busy: starting, or inside a turn. */
export const busyStatus = (status?: string) => status === 'working' || status === 'starting';

/** The word for a busy agent: one still launching has not started the work yet. */
export const busyWord = (status?: string, compacting?: unknown) =>
  (status === 'starting' ? 'starting' : compacting ? 'compacting' : 'working');

/** A question or approval is open, a child is stuck, or a turn failed and is waiting for a decision. */
export const needsAttention = (s: ThreadState) =>
  s.status === 'blocked' || !!s.team?.blocked || !!s.team?.failed
  || (!busyStatus(s.status) && ['error', 'limited', 'restart'].includes(s.recovery?.kind ?? ''))
  || s.clone?.state === 'failed';

/** Running describes work in progress, not a process waiting for input. */
export const runningThread = (s: ThreadState) => busyStatus(s.status) || !!s.team?.working;

/** Settled and waiting for the next message - the only state "done" may show. */
export const settledThread = (s: ThreadState) =>
  (s.status === 'idle' || s.status === 'done') && !runningThread(s) && !needsAttention(s);

/**
 * The machine could not tell whether the agent is working - a CLI it did not
 * start, whose history does not say. Neither running nor done: it is shown
 * as "status unavailable", never as idle and never left out of the count.
 */
export const unknownThread = (s: ThreadState) =>
  s.status === 'unknown' && !runningThread(s) && !needsAttention(s);
