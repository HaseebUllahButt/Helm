import type { Turn } from './types';

/**
 * "42 tok/s" while the agent writes.
 *
 * Counted from the streamed text, at four characters a token, rather than
 * from the drivers' usage figures: those arrive once, at the end of a turn,
 * and describe only its last model call (a turn that streamed 65,000
 * characters reported 77 output tokens). The text arrives in pieces as it is
 * written, for Claude and Codex alike, so it is the one live signal there is.
 * Four characters a token is the usual rough figure for English and code;
 * the readout is a speedometer, not a bill.
 */
export const CHARS_PER_TOKEN = 4;
/** Long enough to smooth the bursts deltas arrive in, short enough to follow a slowdown. */
export const WINDOW_MS = 5_000;
/** Nothing new for this long means the agent is running a tool, not writing. */
export const QUIET_MS = 2_000;
/** Less than this much to go on and the first bursts read as nonsense. */
const MIN_SPAN_MS = 1_000;

export type Sample = { at: number; chars: number };

/**
 * What the model has written so far in this turn: its words, its visible
 * thinking and the tool calls it typed out, subagents included. Command
 * output streams too, but that is the machine talking, not the model.
 */
export function streamedChars(turn: Pick<Turn, 'items'> | undefined): number {
  let chars = 0;
  for (const item of turn?.items ?? []) {
    if (item.kind === 'text' || item.kind === 'thinking') chars += item.text.length;
    else if (item.kind === 'tool' || item.kind === 'subagent') chars += item.inputJson?.length ?? 0;
  }
  return chars;
}

/**
 * Record a reading. Only changes are kept, so the reading at any moment is
 * the last one before it; everything older than that one at the window's
 * start is dropped. A count that goes down is a different turn: start over.
 */
export function addSample(samples: Sample[], at: number, chars: number): Sample[] {
  const last = samples.at(-1);
  if (last && chars === last.chars) return samples;
  if (last && chars < last.chars) return [{ at, chars }];
  const next = [...samples, { at, chars }];
  const start = at - WINDOW_MS;
  let keep = 0;
  while (keep + 1 < next.length && next[keep + 1].at <= start) keep++;
  return keep ? next.slice(keep) : next;
}

/** Tokens a second over the last few seconds, or null when there is nothing honest to say. */
export function tokensPerSecond(samples: Sample[], now: number): number | null {
  const last = samples.at(-1);
  if (!last || samples.length < 2 || now - last.at > QUIET_MS) return null;
  const start = now - WINDOW_MS;
  // The reading at the window's start: the last change at or before it, or
  // the first reading this view took when it started watching later.
  let base = samples[0];
  for (const sample of samples) if (sample.at <= start) base = sample;
  const from = Math.max(base.at, start);
  const span = now - from;
  if (span < MIN_SPAN_MS) return null;
  const rate = Math.round((last.chars - base.chars) / CHARS_PER_TOKEN / (span / 1000));
  return rate >= 1 ? rate : null;
}
