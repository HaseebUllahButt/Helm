import { AcpDriver } from './acp.js';
import { modeFor } from '../modes.js';

/**
 * Cursor, headless: `cursor-agent acp` speaks ACP over stdio (the binary is
 * `agent` on older installs; the launcher resolves either).
 *
 * Verified against cursor-agent 2026.08.11: `initialize` answers protocol 1
 * with loadSession, session/list and image prompts. An unauthenticated box
 * gets "Authentication required ... agent login" out of `session/new`,
 * which helm surfaces as the session's init error - exactly what a person
 * needs to fix.
 *
 * Written against cursor-agent 2026.08.11-e8db854.
 */
export class CursorDriver extends AcpDriver {
  constructor(opts) {
    super({
      engine: 'cursor',
      label: 'Cursor',
      // The version string is a date-based build id, not semver.
      min: '0.0.0',
      args: () => ['acp'],
      acpMode: (m) => modeFor('cursor', m)?.acp ?? null,
    }, opts);
  }
}
