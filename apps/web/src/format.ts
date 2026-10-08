/**
 * How helm says numbers. Money and duration appear per turn, per thread and
 * in the session list, and they have to agree everywhere: a turn that reads
 * `$0.02` must not roll up into a thread that reads `0.0243`.
 */

export const seconds = (ms?: number) =>
  (ms == null ? '' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`);

/** Sub-cent work is real work; it just is not a number worth printing. */
export const money = (usd?: number | null) =>
  (usd == null || usd <= 0 ? '' : usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`);

/** A file size for a person, e.g. media listings. */
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
}

/** The agent itself is busy: starting, or inside a turn. */
export const busyStatus = (status?: string) => status === 'working' || status === 'starting';

/** The word for a busy agent: one still launching has not started the work yet. */
export const busyWord = (status?: string) => (status === 'starting' ? 'starting' : 'working');

/** A question or approval is open, a child is stuck, or a turn failed and is waiting for a decision. */
export const needsAttention = (s: ThreadState) =>
  s.status === 'blocked' || !!s.team?.blocked || !!s.team?.failed
  || (!busyStatus(s.status) && ['error', 'limited', 'restart'].includes(s.recovery?.kind ?? ''));

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
