import { AcpDriver } from './acp.js';

/**
 * Rovo Dev, headless: `rovo acp` speaks ACP over stdio.
 *
 * Not installed on the machine this was written against; the adapter rests
 * on firstmate's verified record of `session/prompt -> end_turn` and
 * `session/cancel`, which is the same ACP surface opencode and devin use.
 * No mode vocabulary is claimed - if the session advertises one, the
 * generic configOptions path picks it up on its own.
 */
export class RovoDriver extends AcpDriver {
  constructor(opts) {
    super({
      engine: 'rovo',
      label: 'Rovo Dev',
      min: '0.0.0',
      args: () => ['acp'],
      acpMode: () => null,
    }, opts);
  }
}
