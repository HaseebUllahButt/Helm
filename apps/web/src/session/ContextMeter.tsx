/** 148500 -> 148.5k, 1000000 -> 1M. One decimal, so a figure beside its window reads as a fraction. */
export const size = (n: number) => {
  const short = (v: number, unit: string) => `${v.toFixed(1).replace(/\.0$/, '')}${unit}`;
  return n < 1000 ? String(Math.round(n)) : n < 1_000_000 ? short(n / 1000, 'k') : short(n / 1_000_000, 'M');
};

const R = 6;
const CIRCLE = 2 * Math.PI * R;

/**
 * How full this conversation's memory is, always in view like the CLI's
 * status line: a thin ring and a percentage. Hovering (or a long press on a
 * phone) gives the numbers. It turns amber near the point where the CLI
 * starts compacting and red when little room is left. With `onPress` it is
 * a button that opens the "Compact at" menu.
 */
export function ContextMeter({ used, window, onPress, open, compacted = false }: { used: number; window: number; onPress?: () => void; open?: boolean; compacted?: boolean }) {
  if (!(window > 0) || !(used > 0 || compacted)) return null;
  const pct = compacted ? 0 : Math.min(100, Math.round((used / window) * 100));
  const title = compacted ? `Compacted · the new size shows after the next reply` : `${size(used)} of ${size(window)} used`;
  const cls = `ctx-meter${pct >= 95 ? ' bad' : pct >= 80 ? ' warn' : ''}`;
  const body = <>
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle className="ctx-ring-bg" cx="8" cy="8" r={R} />
      <circle className="ctx-ring" cx="8" cy="8" r={R} strokeDasharray={`${(CIRCLE * pct) / 100} ${CIRCLE}`} transform="rotate(-90 8 8)" />
    </svg>
    <span className="ctx-pct">{compacted ? 'compacted' : `${pct}%`}</span>
  </>;
  return onPress
    ? <button type="button" className={`${cls} press`} title={`${title} · change when it compacts`} aria-label={`Context ${title}${compacted ? '' : `, ${pct}%`}. Change when it compacts`}
      aria-haspopup="menu" aria-expanded={!!open} onClick={onPress}>{body}</button>
    : <span className={cls} role="img" title={title} aria-label={`Context ${title}${compacted ? '' : `, ${pct}%`}`}>{body}</span>;
}
