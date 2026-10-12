import { createContext, useContext, useEffect, useState } from 'react';
import type { Item, Turn } from './types';
import { money, seconds } from '../format';

/** Lets a chip in the wrap-up ask the transcript to open and show one step. */
export const Reveal = createContext<(id: string) => void>(() => {});

// Short and friendly, like the CLI's own. Seven is coprime with twenty, so
// stepping by seven walks all of them before one comes round again.
const VERBS = [
  'Cooking', 'Pondering', 'Untangling', 'Tinkering', 'Mulling it over', 'Sketching', 'Weaving', 'Simmering', 'Polishing', 'Sifting',
  'Chasing leads', 'Stitching', 'Brewing', 'Whittling', 'Noodling', 'Connecting dots', 'Shaping', 'Wrangling', 'Digging in', 'Assembling',
];
const VERB_SECONDS = 5;

/** Same turn, same verbs in the same order - nothing flickers on a re-render. */
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
export const verbAt = (turnId: string, elapsedSeconds: number) =>
  VERBS[(hash(turnId) + Math.floor(elapsedSeconds / VERB_SECONDS) * 7) % VERBS.length];

/** "42s", "1m 05s": whole seconds, so a ticking counter never wobbles in width. */
const clock = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`);

/**
 * The shared useNow ticker runs at whatever pace its first user asked for
 * (often 15s), too slow for a seconds counter. This one lives only while a
 * working line is on screen.
 */
function useEverySecond(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function WorkingLine({ turn }: { turn: Turn }) {
  const now = useEverySecond();
  const start = Number.isFinite(turn.at) ? turn.at : turn.items[0]?.startedAt;
  const elapsed = start ? Math.max(0, Math.floor((now - start) / 1000)) : 0;
  return (
    <div className="working">
      <span className="pulse-dot" aria-hidden="true" />
      <span className="shine">{verbAt(turn.id, elapsed)}…</span>
      {start ? <span className="working-time">{clock(elapsed)}</span> : null}
    </div>
  );
}

const TEST_RUN = /\b((npm|pnpm|yarn|bun)\s+(run\s+)?test|vitest|jest|pytest|go\s+test|cargo\s+test|node\s+(\S+\s+)*--test|mocha|playwright\s+test)\b/;

/** The last test run decides: an early failure that was then fixed is not news. */
export function testResult(items: Item[]): 'passed' | 'failed' | null {
  const last = items.filter((it) => it.kind === 'command' && it.command && TEST_RUN.test(it.command) && it.exitCode != null).at(-1);
  return last ? (last.exitCode === 0 ? 'passed' : 'failed') : null;
}

/** Each distinct file the turn edited, with the first step that touched it. */
export function changedFiles(items: Item[]): { path: string; itemId: string }[] {
  const seen = new Map<string, string>();
  for (const it of items) if (it.kind === 'edit') for (const c of it.changes ?? []) if (c.path && !seen.has(c.path)) seen.set(c.path, it.id);
  return [...seen].map(([path, itemId]) => ({ path, itemId }));
}

const MAX_CHIPS = 5;

/** "Done in 42s · 3 files changed · tests passed · $0.02", and a chip per file. */
export function WrapUp({ turn }: { turn: Turn }) {
  const reveal = useContext(Reveal);
  const d = turn.done;
  const files = changedFiles(turn.items);
  const tests = testResult(turn.items);
  const parts = [
    d?.durationMs ? `Done in ${seconds(d.durationMs)}` : '',
    files.length ? `${files.length} ${files.length === 1 ? 'file' : 'files'} changed` : '',
    tests ? `tests ${tests}` : '',
    money(d?.costUsd),
  ].filter(Boolean);
  if (!parts.length) return null;
  return (
    <div className="turn-meta wrapup">
      <span>{parts.join(' · ')}</span>
      {files.length > 0 && (
        <div className="wrapup-files">
          {files.slice(0, MAX_CHIPS).map((f) => (
            <button key={f.path} type="button" className="wrapup-chip" title={f.path} onClick={() => reveal(f.itemId)}>
              {f.path.split('/').pop() || f.path}
            </button>
          ))}
          {files.length > MAX_CHIPS && <span className="wrapup-more">+{files.length - MAX_CHIPS} more</span>}
        </div>
      )}
    </div>
  );
}
