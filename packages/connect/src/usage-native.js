import { nativeFunction } from './log-index-native.js';

const extract = nativeFunction('extractUsageMessages');
export const usageReader = extract ? 'rust' : 'javascript';

export function extractUsageMessages(records) {
  if (!extract) return null;
  try { return JSON.parse(extract(records)); }
  catch { return null; }
}
