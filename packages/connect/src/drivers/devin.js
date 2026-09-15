import { AcpDriver } from './acp.js';
import { modeFor } from '../modes.js';

/**
 * Devin CLI, headless: `devin acp` speaks ACP over stdio.
 *
 * Devin's own session modes are real - Code/Ask/Plan/Bypass map straight
 * onto helm's (modes.js `acp`), so permission policy is the agent's and
 * every request reaches the phone. Models are picked with
 * `session/set_config_option` 'model'; there is no separate thinking level -
 * each Devin model bakes it into the name ("…-low", "…-high", "…-fast").
 *
 * Written against devin 3000.10.21, probed live: session/new returns modes
 * and configOptions, session/load resumes by id and replays history first.
 */
export const DEVIN_MIN_VERSION = '3000.10.0';

export class DevinDriver extends AcpDriver {
  constructor(opts) {
    super({
      engine: 'devin',
      label: 'Devin',
      min: DEVIN_MIN_VERSION,
      args: () => ['acp'],
      acpMode: (m) => modeFor('devin', m)?.acp ?? null,
      effortId: null,
    }, opts);
  }
}
