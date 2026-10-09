import { resetPhrase, type LimitWindow } from './limits';

/**
 * A separate composer status row: usage never competes with action buttons.
 * It names the account the chat spends, beside that account's limits, so
 * whose plan this is and how much of it is left are read in one place.
 * Hovering it says when each limit resets.
 */
export function LimitsLine({ windows, account }: { windows: LimitWindow[]; account?: string }) {
  const title = [account, ...windows.map(w => `${w.label}: ${w.used}% used${w.resetsAt ? ` · ${resetPhrase(w.resetsAt)}` : ''}`)]
    .filter(Boolean).join('\n') || 'Account limits';
  return <div className="limits-line" title={title} aria-label={title}>
    <span className={`limits-caption${account ? ' account' : ''}`}>{account || 'Account limits'}</span>
    {windows.length > 0 && <div className="limits-windows">{windows.map(w => <span key={w.label} className={`lw${w.used >= 95 ? ' bad' : w.used >= 80 ? ' warn' : ''}`}>
      <span className="limits-meter" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.max(0, w.used))}%` }} /></span>
      <span>{w.label} <b>{w.used}%</b> used</span>
    </span>)}</div>}
  </div>;
}
