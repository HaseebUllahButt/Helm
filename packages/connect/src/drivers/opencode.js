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
      // A prompt sent while a run is going is added to that session and
      // read by the running loop at its next step, the way the TUI queues
      // typing; both prompts answer when the loop ends.
      promptWhileBusy: true,
    }, opts);
  }

  /** A waiting message joins the running loop at its next step. */
  async steer(text, attachments = [], options = {}) { return this.sendDuringTurn(text, attachments, options); }
}

/**
 * OpenCode 2 preview, which ships as a separate `opencode2` executable. Its
 * ACP side has not been seen to fold a second prompt into a running loop,
 * so messages typed mid-turn wait for the reply there.
 */
export class Opencode2Driver extends AcpDriver {
  constructor(opts) {
    super({
      engine: 'opencode2',
      label: 'OpenCode 2',
      // Preview versions are 0.0.0-beta-N; the live ACP handshake is the
      // compatibility check that matters while that channel is unversioned.
      min: '0.0.0',
      args: () => ['acp'],
      acpMode: (m) => modeFor('opencode2', m)?.acp ?? null,
      effortId: 'effort',
      // session/load replays every past message only for Helm to drop them;
      // resume picks the conversation up without the replay. Builds without
      // it fall back to session/load.
      resumeVerb: 'session/resume',
    }, opts);
  }
}
