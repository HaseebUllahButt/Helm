import { AcpDriver } from './acp.js';
import { modeFor } from '../modes.js';
import { devinUsageReport } from '../devin-usage.js';

/**
 * Devin CLI, headless: `devin acp` speaks ACP over stdio.
 *
 * Devin's own session modes are real - Code/Ask/Plan/Bypass map straight
 * onto helm's (modes.js `acp`), so permission policy is the agent's and
 * every request reaches the phone. Models are picked with
 * `session/set_config_option` 'model'; since 3000.11.x the session also
 * advertises 'thought_level' (medium/high/max) as the thinking dial - the
 * "-medium"/"-high" tail on a model id is just its name.
 *
 * Written against devin 3000.10.21, probed live: session/new returns modes
 * and configOptions, session/load resumes by id and replays history first.
 * The thought_level picker is probed on 3000.11.1; an older agent simply
 * never advertises it and helm offers no thinking chip.
 */
export const DEVIN_MIN_VERSION = '3000.10.0';

/**
 * `devin acp` advertises /session-stats but has no /usage at all - over ACP
 * it answers "Unknown command". In the standalone CLI /usage is the account
 * quota card, a TUI feature that calls the seat-management API rather than
 * the session. helm answers it locally (spec.localCommand) with the same
 * GetUserStatus read, so it works while a turn runs; /session-stats stays
 * the real ACP command for the per-session numbers.
 */
const DEVIN_USAGE = { name: 'usage', description: 'Show account quota and usage', source: 'devin' };

/**
 * What `/` can mean in a devin session when the agent never said so itself.
 * `devin acp` advertises its commands with available_commands_update, and
 * that list always wins when it arrives - this is the cold-start answer,
 * so the palette offers devin's real commands rather than only /compact.
 * Mirrored from the set devin 3000.10.31 advertises.
 */
export const DEVIN_COMMANDS = [
  { name: 'login', description: 'Authenticate with an API key', source: 'devin' },
  { name: 'logout', description: 'Clear authentication', source: 'devin' },
  { name: 'status', description: 'Check authentication status', source: 'devin' },
  { name: 'workspace', description: 'List workspace directories', source: 'devin' },
  { name: 'ask', description: 'Switch to Ask mode (read-only)', source: 'devin' },
  { name: 'plan', description: 'Switch to Plan mode, or plan with a prompt', source: 'devin' },
  { name: 'code', description: 'Switch to Code mode, or run a prompt in it', source: 'devin' },
  { name: 'smart', description: 'Switch to Smart mode, or run a prompt in it', source: 'devin' },
  { name: 'bypass', description: 'Switch to Bypass Permissions mode, or run a prompt under it', source: 'devin' },
  { name: 'compact', description: 'Force conversation compaction', source: 'devin' },
  { name: 'context', description: 'Show context window usage', source: 'devin' },
  { name: 'fast', description: 'Switch to the fastest model available to you, or run a prompt with it', source: 'devin' },
  { name: 'loop', description: 'Run a prompt then auto-review the diff in a loop', source: 'devin' },
  { name: 'recap', description: 'Recap the session so far with a short summary', source: 'devin' },
  { name: 'session-stats', description: 'Show session statistics', source: 'devin' },
  DEVIN_USAGE,
  { name: 'rename', description: 'Rename this session', source: 'devin' },
  { name: 'share', description: 'Share this conversation with your team on Devin', source: 'devin' },
  { name: 'mcp', description: 'List configured MCP servers and their status', source: 'devin' },
  { name: 'bug', description: 'Report a bug to the Devin CLI developers', source: 'devin' },
  { name: 'help', description: 'Show available commands', source: 'devin' },
];

export class DevinDriver extends AcpDriver {
  constructor(opts) {
    super({
      engine: 'devin',
      label: 'Devin',
      min: DEVIN_MIN_VERSION,
      args: () => ['acp'],
      acpMode: (m) => modeFor('devin', m)?.acp ?? null,
      effortId: 'thought_level',
      fallbackCommands: DEVIN_COMMANDS,
      extraCommands: [DEVIN_USAGE],
      localCommand: (driver, text) =>
        /^\/usage\s*$/i.test(String(text).trim())
          ? () => devinUsageReport({
              transcript: driver.transcript,
              engineSessionId: driver.engineSessionId,
              env: driver.env,
              fetchStatus: driver.fetchStatus,
              version: DEVIN_MIN_VERSION,
            })
          : null,
    }, opts);
    // Tests inject fetchStatus so no call ever leaves the machine.
    if (opts?.fetchStatus) this.fetchStatus = opts.fetchStatus;
  }
}
