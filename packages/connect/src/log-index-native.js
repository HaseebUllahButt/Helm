import { createRequire } from 'node:module';
import { binaryPath } from '../../../native/log-index/build-id.mjs';

const require = createRequire(import.meta.url);
let binding = null;
if (process.env.HELM_LOG_READER !== 'javascript') {
  try {
    binding = require(binaryPath());
  } catch (error) {
    // A source checkout can run before its optional native reader is built.
    // A missing or incompatible binary must not prevent opening any chat.
    if (!['MODULE_NOT_FOUND', 'ERR_DLOPEN_FAILED'].includes(error.code)) throw error;
  }
}

// All native features use one source-matched library and the same recovery path.
export function nativeFunction(name) {
  return typeof binding?.[name] === 'function' ? binding[name] : null;
}
export const nativeFeatures = Object.freeze(Object.keys(binding ?? {}).filter(name => nativeFunction(name)).sort());
const scan = nativeFunction('scanEventPositions');
export const logReader = scan ? 'rust' : 'javascript';
export function scanEventPositions(bytes) { return scan?.(bytes) ?? null; }
