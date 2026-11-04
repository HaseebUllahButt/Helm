import { AcpDriver } from './acp.js';
import { modeFor } from '../modes.js';

/**
 * Mistral Vibe, headless: `vibe-acp` speaks ACP over stdio.
 *
 * The chat CLI is `vibe`; its ACP side is a second program, `vibe-acp`,
 * installed next to it. The profile names `vibe` (that is what discovery
 * and native chats see), so the driver swaps the program name for its
 * ACP sibling in the same folder.
 *
 * Verified against vibe 3.0.4: `initialize` answers protocol 1 with
 * loadSession, session/list and image prompts. `session/new` returns the
 * modes (Vibe calls them agents: ask, accept-edits, smart-approve,
 * auto-approve) and configOptions 'mode', 'model' and 'thinking'. A box
 * with no Mistral sign-in gets "Missing API key for mistral provider."
 * from `session/new`; the driver turns that into the step the owner takes.
 */
export const VIBE_MIN_VERSION = '3.0.0';

/** `vibe` -> `vibe-acp`, keeping any folder in front of it. */
export function vibeAcpCommand(cmd) {
  if (typeof cmd !== 'string' || !cmd) return 'vibe-acp';
  const at = cmd.lastIndexOf('/');
  const dir = at >= 0 ? cmd.slice(0, at + 1) : '';
  const base = at >= 0 ? cmd.slice(at + 1) : cmd;
  return base === 'vibe' ? `${dir}vibe-acp` : cmd;
}

/** The words Helm shows when Vibe has no Mistral sign-in on this machine. */
export const VIBE_SIGN_IN = 'Vibe is not signed in on this machine. Run `vibe --setup` in a terminal, sign in with your Mistral account, then send the message again.';

export class VibeDriver extends AcpDriver {
  constructor(opts) {
    super({
      engine: 'vibe',
      label: 'Mistral Vibe',
      min: VIBE_MIN_VERSION,
      args: () => [],
      acpMode: (m) => modeFor('vibe', m)?.acp ?? null,
      effortId: 'thinking',
      explainError: (message) => /missing api key/i.test(String(message ?? '')) ? VIBE_SIGN_IN : null,
    }, opts);
    this.cmd = vibeAcpCommand(this.cmd);
  }
}
