/** 148500 -> 148.5k, 1000000 -> 1M. One decimal, so a figure beside its window reads as a fraction. */
const size = (n: number) => {
  const short = (v: number, unit: string) => `${v.toFixed(1).replace(/\.0$/, '')}${unit}`;
  return n < 1000 ? String(Math.round(n)) : n < 1_000_000 ? short(n / 1000, 'k') : short(n / 1_000_000, 'M');
};

const R = 6;
const CIRCLE = 2 * Math.PI * R;

/**
 * How full this conversation's memory is, always in view like the CLI's
 * status line: a thin ring and a percentage. Hovering (or a long press on a
 * phone) gives the numbers. It turns amber near the point where the CLI
 * starts compacting and red when little room is left.
 */
export function ContextMeter({ used, window }: { used: number; window: number }) {
  if (!(used > 0) || !(window > 0)) return null;
  const pct = Math.min(100, Math.round((used / window) * 100));
  const title = `${size(used)} of ${size(window)} used`;
  return <span className={`ctx-meter${pct >= 95 ? ' bad' : pct >= 80 ? ' warn' : ''}`} role="img" title={title} aria-label={`Context ${title}, ${pct}%`}>
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle className="ctx-ring-bg" cx="8" cy="8" r={R} />
      <circle className="ctx-ring" cx="8" cy="8" r={R} strokeDasharray={`${(CIRCLE * pct) / 100} ${CIRCLE}`} transform="rotate(-90 8 8)" />
    </svg>
    <span className="ctx-pct">{pct}%</span>
    <span className="ctx-detail">{size(used)} of {size(window)}</span>
  </span>;
}
