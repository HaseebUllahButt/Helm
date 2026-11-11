import { useEffect, useState } from 'react';
import { DEFAULT_CACHE_TTL, historySize, staleHistory, type StaleHistory } from '@helm/usage/idle-history';
import type { Session } from '../client';

/**
 * The big, cold Claude history the next send would read again at full
 * price, or null (idle-history.js). It turns on by itself when the cache
 * time runs out. Only a machine that can compact first says so
 * (`compactFirst`); an older one gets no choice it would ignore.
 */
export function useStaleHistory(session: Session, busy: boolean): StaleHistory | null {
  const [now, setNow] = useState(() => Date.now());
  const c = session.context;
  const ttl = c?.ttl && c.ttl > 0 ? c.ttl : DEFAULT_CACHE_TTL;
  useEffect(() => {
    if (!session.compactFirst || !c?.at) return;
    const wait = c.at + ttl - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(wait + 1_000, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [session.compactFirst, c?.at, ttl]);
  if (!session.compactFirst || busy) return null;
  return staleHistory(session, Math.max(now, Date.now()));
}

/** What the send button says for this choice. */
export const historySendLabel = (keepFull: boolean) => keepFull ? 'Send with full history' : 'Compact and send';

/**
 * The chip beside send. Compact is the default: the chat was idle, so the
 * full history costs the most. One tap keeps the full history for the
 * next send.
 */
export function HistoryChoice({ stale, keepFull, onToggle }: { stale: StaleHistory; keepFull: boolean; onToggle: () => void }) {
  const size = historySize(stale.tokens);
  const why = `This chat was idle. Its cache expired, so Claude reads all ${size} tokens of history again at full price.`;
  return <button type="button" className={`ctl history-choice${keepFull ? '' : ' on'}`} onClick={onToggle} aria-pressed={!keepFull}
    title={keepFull
      ? `${why} The next send keeps the full history. Select to compact it first.`
      : `${why} Claude compacts the history into a summary first, then sends. Select to keep the full history.`}
    aria-label={keepFull ? `Next send keeps all ${size} tokens of history. Select to compact first.` : `Next send compacts ${size} tokens of history first. Select to keep the full history.`}>
    <span className="history-short">{keepFull ? 'Full' : 'Compact'} {size}</span>
    {/* A narrow box has no hover text, so its own line says it in words. */}
    <span className="history-long">{keepFull ? `Next send keeps all ${size} of history. Tap to compact first.` : `Next send compacts ${size} of history first. Tap to keep all of it.`}</span>
  </button>;
}
