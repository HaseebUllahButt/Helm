import * as logIndex from './log-index-native.js';

const nativeFunction = (name) => logIndex.nativeFunction?.(name) ?? null;

// Other systems keep their existing process and filesystem paths.
const linux = (process.env.HELM_TEST_PLATFORM || process.platform) === 'linux';
const processes = linux ? nativeFunction('discoveryProcessList') : null;
const directory = linux ? nativeFunction('discoveryReadDirectory') : null;

export function discoverProcesses(root) {
  try { return processes?.(root) ?? null; }
  catch { return null; }
}

export async function discoverDirectory(root) {
  try { return await directory?.(root) ?? null; }
  catch { return null; }
}
