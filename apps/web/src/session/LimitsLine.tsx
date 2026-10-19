import type { ReactNode } from 'react';
import { resetPhrase, type LimitWindow } from './limits';

/**
 * The composer's usage, beside its buttons on a wide box. Each limit is just
 * its window and percent. It names the account the chat spends, so
 * whose plan this is and how much of it is left are read in one place.
 * Hovering it says when each limit resets. The chat's context meter sits at
 * its end, so everything about "how much is left" is read in one row.
 */
export function LimitsLine({ windows, account, context }: { windows: LimitWindow[]; account?: string; context?: ReactNode }) {
  const title = [account, ...windows.map(w => `${w.label}: ${w.used}% used${w.resetsAt ? ` · ${resetPhrase(w.resetsAt)}` : ''}`)]
    .filter(Boolean).join('\n') || 'Account limits';
  return <div className="limits-line" title={title} aria-label={title}>
    {(account || windows.length > 0 || !context) && <span className={`limits-caption${account ? ' account' : ''}`}>{account || 'Account limits'}</span>}
    {windows.length > 0 && <div className="limits-windows">{windows.map(w => <span key={w.label} className={`lw${w.used >= 95 ? ' bad' : w.used >= 80 ? ' warn' : ''}`}>
      <span>{w.label} <b>{w.used}%</b></span>
    </span>)}</div>}
    {context}
  </div>;
}
