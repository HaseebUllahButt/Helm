import { AcpDriver } from './acp.js';
import { modeFor } from '../modes.js';

/**
 * opencode, headless: `opencode acp` speaks ACP over stdio.
 *
 * Its session "mode" is the agent choice - `build` asks, `plan` plans - so
 * helm's wider permission modes are enforced driver-side: 'edit' and 'auto'
 * answer matching `session/request_permission` requests without ever
 * bothering the phone (see modes.js `autoAllow`). Model and thinking level
 * ride `session/set_config_option` ('model' and 'effort'); the model picker
 * it returns doubles as the session's catalogue.
 *
 * Written against opencode 1.18.26, probed live: session/new returns
 * configOptions for model, effort and mode; session/load resumes by id.
 */
export const OPENCODE_MIN_VERSION = '1.18.0';

export class OpencodeDriver extends AcpDriver {
  constructor(opts) {
    super({
      engine: 'opencode',
      label: 'opencode',
      min: OPENCODE_MIN_VERSION,
      args: (d) => ['acp', '--cwd', d.cwd],
      acpMode: (m) => modeFor('opencode', m)?.acp ?? null,
      effortId: 'effort',
    }, opts);
  }
}
