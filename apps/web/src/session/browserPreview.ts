export type BrowserPreview = 'low' | 'balanced' | 'full' | 'smooth' | 'text';
export type ConnectionHint = { saveData?: boolean; effectiveType?: string };

/** Optional network hints help on first paint; measured delivery works on Safari too. `elapsed` is the round trip without server waiting; 0 means not measured yet. */
export function previewForLink(elapsed: number, narrow: boolean, connection?: ConnectionHint): BrowserPreview {
  if (connection?.saveData || ['slow-2g', '2g'].includes(connection?.effectiveType || '') || elapsed >= 900) return 'low';
  if (narrow || connection?.effectiveType === '3g' || elapsed >= 250) return 'balanced';
  if (elapsed > 0 && elapsed < 60) return 'smooth';
  return 'full';
}

/** How long the server may hold a frame request waiting for something new to paint. */
export function previewWait(mode: BrowserPreview): number {
  return mode === 'text' ? 0 : 1000;
}

/** Pause between requests. A server that held the request already paced it; older servers answer at once and need a timer. */
export function previewDelay(mode: BrowserPreview, elapsed: number, held = false): number {
  if (held) return 0;
  return Math.min(5000, Math.max(mode === 'text' ? 2000 : mode === 'low' ? 1000 : mode === 'balanced' ? 500 : mode === 'full' ? 250 : 100, elapsed));
}

export function previewLease(elapsed: number): number {
  return Math.min(60000, Math.max(15000, Math.ceil(elapsed * 3 + 5000)));
}
