/** The headless driver for each engine, and what a session record looks like once it leaves this machine. */
import { ClaudeDriver } from './drivers/claude.js';
import { CodexDriver } from './drivers/codex.js';
import { OpencodeDriver, Opencode2Driver } from './drivers/opencode.js';
import { DevinDriver } from './drivers/devin.js';
import { GrokDriver } from './drivers/grok.js';
import { CursorDriver } from './drivers/cursor.js';
import { AgyDriver } from './drivers/agy.js';
import { AntigravityDriver } from './drivers/antigravity.js';
import { PiDriver, OmpDriver } from './drivers/pi.js';
import { bareTitle } from './titles.js';
import { askPreview } from './notify.js';

/** engine id -> its headless driver class; ENGINES[id].driver names one. */
export const DRIVERS = {
  claude: ClaudeDriver,
  codex: CodexDriver,
  opencode: OpencodeDriver,
  opencode2: Opencode2Driver,
  devin: DevinDriver,
  grok: GrokDriver,
  cursor: CursorDriver,
  agy: AgyDriver,
  antigravity: AntigravityDriver,
  pi: PiDriver,
  omp: OmpDriver,
};

/** How many prompts wait, and what the newest one is about. */
export const pendingSummary = (pending) => ({ pending: pending.length,
  ask: pending.length ? { ...askPreview(pending[pending.length - 1]), requestId: pending[pending.length - 1].requestId } : null });

/**
 * What a session looks like on the wire: everything but helm's own notes.
 * Both ways out - `list()` and every `session` event - go through it, so a
 * note kept for naming a thread never rides along to every paired device.
 */
export const wire = ({ promptSample, unsent, transcript, externalHome, externalLock, externalPid, nativeHome, nativePid, nativeSocket, nativeAgents, dismissedNativeFailures, nativeSent, externalImported, externalSource, externalTail, externalImagesVersion, originHandoffId, delegationReply, taskReturnContext, lastLimits, rewindProcId, rewindFailure, ...s }) => ({
  ...s, rewindSupported: !!DRIVERS[s.driver]?.canRewind && !s.external && !nativeSocket && !s.nativeCli && !s.shared && !rewindFailure,
  ...(typeof s.title === 'string' && /\[(?:Image|Pasted text) #/.test(s.title) ? { title: bareTitle(s.title) || s.title } : {}),
});
