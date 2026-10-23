import { nativeFunction } from './log-index-native.js';

const extract = nativeFunction('extractUsageMessages');
export const usageReader = extract ? 'rust' : 'javascript';

export function extractUsageMessages(records) {
  if (!extract) return null;
  try { return JSON.parse(extract(records)); }
  catch { return null; }
}

/** Yield parsed metadata without retaining old message bodies on the fallback path. */
export function* readUsageMessages(records) {
  const projected = extractUsageMessages(records);
  for (let n = 0; n < records.length; n++) {
    try { yield projected ? projected[n][0] ?? JSON.parse(projected[n][1]) : JSON.parse(records[n]); }
    catch { /* Keep the existing recovery for unreadable records. */ }
  }
}
