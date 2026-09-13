/**
 * SessionRuntime — the contract helm needs from whatever actually owns the
 * terminals.
 *
 * helm itself knows nothing about herdr, tmux or PTYs; it knows it can create
 * a session in a directory with an environment, put an agent in it, read what
 * came out, send input, and be told when the agent's state changes. Anything
 * that can do those things can back helm.
 *
 * Implementations emit:
 *   'status' { paneId, status, agent }   status: idle|working|blocked|done|unknown
 *   'closed' { paneId }
 *
 * and declare what they can do:
 *   capabilities.agentState  - reports blocked/working/done without us parsing output
 *   capabilities.rawStream   - can stream raw terminal bytes rather than rendered text
 *   capabilities.persistent  - sessions outlive the helm daemon
 *
 * @typedef {Object} SessionHandle
 * @property {string} paneId
 * @property {string} [workspaceId]
 * @property {string} [tabId]
 * @property {string} [agentName]
 */

export { HerdrRuntime } from './herdr-runtime.js';

/** Pick a runtime. Only one exists today; the seam is the point. */
export async function createRuntime(kind = process.env.HELM_RUNTIME || 'herdr', opts = {}) {
  if (kind === 'herdr') {
    const { HerdrRuntime } = await import('./herdr-runtime.js');
    return new HerdrRuntime(opts);
  }
  throw new Error(`unknown session runtime: ${kind}`);
}
