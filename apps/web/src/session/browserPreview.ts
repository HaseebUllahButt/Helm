export type BrowserPreview = 'low' | 'balanced' | 'full' | 'text';
export type ConnectionHint = { saveData?: boolean; effectiveType?: string };

/** Optional network hints help on first paint; measured delivery works on Safari too. */
export function previewForLink(elapsed: number, narrow: boolean, connection?: ConnectionHint): BrowserPreview {
  if (connection?.saveData || ['slow-2g', '2g'].includes(connection?.effectiveType || '') || elapsed >= 900) return 'low';
  if (narrow || connection?.effectiveType === '3g' || elapsed >= 250) return 'balanced';
  return 'full';
}

export function previewDelay(mode: BrowserPreview, elapsed: number): number {
  return Math.min(5000, Math.max(mode === 'text' ? 2000 : mode === 'low' ? 1000 : mode === 'balanced' ? 500 : 250, elapsed));
}

export function previewLease(elapsed: number): number {
  return Math.min(60000, Math.max(15000, Math.ceil(elapsed * 3 + 5000)));
}
