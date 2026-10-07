import { resetPhrase, type LimitWindow } from './limits';

/** A separate composer status row: usage never competes with action buttons. */
export function LimitsLine({ windows }: { windows: LimitWindow[] }) {
  const title = windows.map(w => `${w.label} limit: ${w.used}% used${w.resetsAt ? `, ${resetPhrase(w.resetsAt)}` : ''}`).join('\n');
  return <div className="limits-line" title={title} aria-label={title}>
    <span className="limits-caption">Account limits</span>
    <div className="limits-windows">{windows.map(w => <span key={w.label} className={`lw${w.used >= 95 ? ' bad' : w.used >= 80 ? ' warn' : ''}`}>
      <span className="limits-meter" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.max(0, w.used))}%` }} /></span>
      <span>{w.label} <b>{w.used}%</b> used</span>
    </span>)}</div>
  </div>;
}
