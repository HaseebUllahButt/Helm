import { createRequire } from 'node:module';
import { binaryPath } from '../../../native/log-index/build-id.mjs';

const require = createRequire(import.meta.url);
let scan = null;
if (process.env.HELM_LOG_READER !== 'javascript') {
  try {
    const native = require(binaryPath());
    scan = native.scanEventPositions;
  } catch (error) {
    // A source checkout can run before its optional native reader is built.
    // A missing or incompatible binary must not prevent opening any chat.
    if (!['MODULE_NOT_FOUND', 'ERR_DLOPEN_FAILED'].includes(error.code)) throw error;
  }
}

export const logReader = scan ? 'rust' : 'javascript';
export function scanEventPositions(bytes) { return scan?.(bytes) ?? null; }
