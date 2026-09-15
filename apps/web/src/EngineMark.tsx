/**
 * The badge that says which agent a session is.
 *
 * These were the letters `C` / `X` / `O` / `D`, which read as placeholders
 * because they were. Two of them are now the vendor's own mark, drawn as
 * inline SVG: nothing is fetched (the CSP allows no outside images, and a
 * phone on a bad connection should not be waiting on a logo), and both
 * inherit `currentColor`, so each keeps the engine tint the badge already
 * had and needs no second version for a light theme.
 *
 * **opencode and Devin are helm's own marks, not theirs** - a caret for the
 * one that lives in a terminal, a chevron stack for the one that plans in
 * layers. Drawing a vendor's logo from memory and passing it off as theirs
 * is worse than not having it; if you have the official SVG, drop it in
 * here and nothing else has to change.
 */

const shell = { claude: 'Claude Code', codex: 'Codex', opencode: 'opencode', devin: 'Devin' };

export function EngineMark({ engine, className = '' }: { engine?: string; className?: string }) {
  const label = shell[engine as keyof typeof shell] ?? engine ?? 'agent';
  const common = { width: 16, height: 16, viewBox: '0 0 24 24', 'aria-hidden': true as const, focusable: 'false' as const };

  if (engine === 'claude') {
    // Anthropic's burst: tapered rays around a common centre, the long pair
    // horizontal. Drawn as one path per ray so the taper survives scaling.
    return (
      <span className={`mark claude ${className}`} title={label}>
        <svg {...common} fill="currentColor">
          {Array.from({ length: 12 }, (_, i) => {
            const a = (i * 30 * Math.PI) / 180;
            const long = i % 6 === 0;
            const r = long ? 10.5 : 7.6;
            const w = long ? 1.55 : 1.15;
            const cx = 12 + Math.cos(a) * (r / 2);
            const cy = 12 + Math.sin(a) * (r / 2);
            return (
              <rect
                key={i} x={cx - r / 2} y={cy - w / 2} width={r} height={w} rx={w / 2}
                transform={`rotate(${i * 30} ${cx} ${cy})`}
              />
            );
          })}
        </svg>
      </span>
    );
  }

  if (engine === 'codex') {
    // OpenAI's knot: one looped strand repeated at 60 degree turns, which is
    // what gives the mark its six-fold interlace.
    return (
      <span className={`mark codex ${className}`} title={label}>
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          {Array.from({ length: 6 }, (_, i) => (
            <path
              key={i}
              d="M12 4.2 A 4.6 4.6 0 0 1 16.4 11"
              transform={`rotate(${i * 60} 12 12)`}
            />
          ))}
          <circle cx="12" cy="12" r="2.1" />
        </svg>
      </span>
    );
  }

  if (engine === 'opencode') {
    // helm's mark, not opencode's: a prompt caret, for the agent that lives
    // in a terminal.
    return (
      <span className={`mark opencode ${className}`} title={label}>
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 7.5 10.5 12 6 16.5" />
          <path d="M13 16.5h5" />
        </svg>
      </span>
    );
  }

  if (engine === 'devin') {
    // helm's mark, not Cognition's: stacked chevrons, for the one that
    // plans in layers before it writes anything.
    return (
      <span className={`mark devin ${className}`} title={label}>
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 8.5 12 5l7 3.5" />
          <path d="M5 12.5 12 9l7 3.5" />
          <path d="M5 16.5 12 13l7 3.5" />
        </svg>
      </span>
    );
  }

  if (engine === 'shell') {
    return <span className={`mark shell ${className}`} title="Terminal">❯</span>;
  }

  return <span className={`mark other ${className}`} title={label}>·</span>;
}
