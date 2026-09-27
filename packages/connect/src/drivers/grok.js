import { AcpDriver } from './acp.js';
import { modeFor } from '../modes.js';

/**
 * Grok, headless: `grok agent stdio` speaks ACP over stdio.
 *
 * Verified against grok 1.0.41: `initialize` answers protocol 1 with
 * loadSession, session/list, prompt capabilities and a command menu;
 * `session/new` emits `_x.ai/session/setup` progress notices before the
 * result, which on an unauthenticated box never arrives - that surfaces as
 * the agent's own init error, which is the truth.
 *
 * `--no-leader` keeps this process its own agent: grok can otherwise attach
 * to a shared leader and helm would be steering somebody else's backend.
 * Flags sit between `agent` and `stdio`, so this driver builds argv itself
 * rather than letting profileArgs trail the subcommand.
 */
export const GROK_MIN_VERSION = '1.0.0';

export class GrokDriver extends AcpDriver {
  constructor(opts) {
    super({
      engine: 'grok',
      label: 'Grok',
      min: GROK_MIN_VERSION,
      // Unused - args is built below so profile args land before `stdio`.
      args: () => [],
      acpMode: (m) => modeFor('grok', m)?.acp ?? null,
    }, opts);
  }

  get args() {
    const a = ['agent', '--no-leader'];
    const mode = modeFor('grok', this.mode);
    // The only approval flag `grok agent` accepts; finer modes go through
    // ACP session modes / configOptions once the session is up.
    if (mode?.approveAll) a.push('--always-approve');
    if (this.model) a.push('-m', this.model);
    if (this.effort) a.push('--reasoning-effort', this.effort);
    a.push(...this.profileArgs);
    a.push('stdio');
    return a;
  }
}
