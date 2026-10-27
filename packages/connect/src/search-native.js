import { nativeFunction } from './log-index-native.js';

const extract = nativeFunction('extractSearchEvents');
export const searchReader = extract ? 'rust' : 'javascript';

/** A native failure leaves the original log reader in charge of recovery. */
export function extractSearchEvents(bytes) {
  if (!extract) return null;
  try { return JSON.parse(extract(bytes)); } catch { return null; }
}
