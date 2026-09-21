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

/**
 * `devin acp` advertises /session-stats but no /usage - that spelling only
 * exists in the standalone CLI. helm offers /usage anyway and rewrites it
 * on the wire (spec.mapPrompt); it sits in the fallback list and in
 * extraCommands so it is offered whichever list wins.
 */
const DEVIN_USAGE = { name: 'usage', description: 'Show session usage', source: 'devin' };

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
      effortId: null,
      fallbackCommands: DEVIN_COMMANDS,
      extraCommands: [DEVIN_USAGE],
      mapPrompt: (text) => /^\/usage\s*$/i.test(text) ? '/session-stats' : text,
    }, opts);
  }
}
