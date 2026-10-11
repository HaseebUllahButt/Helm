import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseAgentArgs } from './delegation.js';
import { expand } from './paths.js';

export function parseTaskArgs(args, { env = process.env, cwd = process.cwd(), machineId } = {}) {
  const { options, words } = parseAgentArgs(args, {
    values: ['account', 'source-folder', 'target-folder', 'session', 'model', 'mode', 'handoff-id'],
    switches: ['no-env', 'allow-skipped', 'json'],
  });
  const who = words.shift();
  if (!who || !options.account) throw new Error('usage: helm send-task <machine> --account <target-profile> [task...]');
  const handoffId = options['handoff-id'] || randomBytes(12).toString('hex');
  if (!/^[a-f0-9]{24}$/.test(handoffId)) throw new Error('handoff id must be 24 lowercase hexadecimal characters');
  return { options, request: {
    handoffId, targetMachineId: machineId(who), profileId: options.account,
    folder: resolve(expand(options['source-folder'] || env.HELM_CWD || cwd)),
    targetFolder: options['target-folder'],
    // An explicitly selected folder is a new task. Continuing a session
    // there requires --session so another project cannot pause this chat.
    sessionId: options.session || (!options['source-folder'] ? env.HELM_SESSION_ID : undefined),
    model: options.model, mode: options.mode, prompt: words.join(' '),
    includeEnv: !options['no-env'], allowSkipped: !!options['allow-skipped'],
  } };
}
