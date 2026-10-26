import { memo, useId } from 'react';

/**
 * The band behind the sidebar's top bar: the sky just after the sun has gone
 * down over the sea, fading into the sidebar. Borrowed from T3 Code
 * Nightly's night sky. The colours are CSS variables, so each theme paints
 * its own sunset. No viewBox: the scene is laid out in percentages and
 * pixels, so a wide sidebar spreads it out instead of stretching it.
 */
const STARS: [string, number, number, number][] = [
  ['6%', 7, 0.55, 0.8], ['17%', 15, 0.45, 0.5], ['34%', 5, 0.4, 0.45], ['52%', 11, 0.4, 0.35],
  ['66%', 6, 0.45, 0.55], ['80%', 9, 0.5, 0.7], ['93%', 14, 0.4, 0.45],
];
const CLOUDS: [string, number, number, number][] = [
  ['14%', 39, 30, 0.5], ['42%', 35, 26, 0.45], ['63%', 41, 34, 0.55], ['88%', 37, 28, 0.4],
];
const GLINTS: [string, number, number, number][] = [
  ['9%', 52, 10, 0.3], ['27%', 55, 16, 0.4], ['44%', 51, 12, 0.35], ['58%', 57, 9, 0.25],
  ['71%', 53, 18, 0.4], ['86%', 56, 11, 0.3],
];

export const SidebarSunset = memo(function SidebarSunset() {
  // Gradients are referenced by id; a page can hold more than one band.
  const id = `sun${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const stop = (name: string) => ({ stopColor: `var(--sunset-${name})` });
  return (
    <div className="sidebar-sunset" aria-hidden="true">
      <svg width="100%" height="96" fill="none">
        <defs>
          <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
            <stop style={stop('top')} />
            <stop offset=".5" style={stop('mid')} />
            <stop offset=".85" style={stop('low')} />
            <stop offset="1" style={stop('horizon')} />
          </linearGradient>
          <radialGradient id={`${id}-glow`} cx=".5" cy=".5" r=".6">
            <stop style={stop('glow')} stopOpacity=".5" />
            <stop offset=".5" style={stop('glow')} stopOpacity=".15" />
            <stop offset="1" style={stop('glow')} stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`${id}-sea`} x1="0" y1="0" x2="0" y2="1">
            <stop style={stop('sea-top')} />
            <stop offset="1" style={stop('sea')} />
          </linearGradient>
          <filter id={`${id}-soft`} x="-20%" y="-200%" width="140%" height="500%"><feGaussianBlur stdDeviation="1.6" /></filter>
        </defs>

        <rect width="100%" height="48" fill={`url(#${id}-sky)`} />
        <g style={{ fill: 'var(--sunset-star)' }}>
          {STARS.map(([x, y, r, o]) => <circle key={x} cx={x} cy={y} r={r} opacity={o} />)}
        </g>
        <rect y="20" width="100%" height="56" fill={`url(#${id}-glow)`} />
        <g filter={`url(#${id}-soft)`} style={{ fill: 'var(--sunset-cloud)' }}>
          {CLOUDS.map(([x, y, rx, o]) => <ellipse key={x} cx={x} cy={y} rx={rx} ry="1.6" opacity={o} />)}
        </g>
        <rect y="48" width="100%" height="48" fill={`url(#${id}-sea)`} />
        <g style={{ fill: 'var(--sunset-shine)' }}>
          {GLINTS.map(([x, y, w, o]) => <rect key={x} x={x} y={y} width={w} height=".9" rx=".45" opacity={o} />)}
        </g>
      </svg>
    </div>
  );
});
