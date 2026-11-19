// helm webchat: make a signed-in web chat a Helm account (webchat/).
import { parseAgentArgs } from './agent-args.js';

const USAGE = 'helm webchat add <account> --site gemini|chatgpt|claude --profile <browser profile> [--model <name>] [--temporary] [--machine <name>] | list [--json] | remove <account>';

export async function runWebchatCommand(args, { rpc, self, findSession, machine, print = console.log, env = process.env } = {}) {
  const { words, options } = parseAgentArgs(args, { values: ['site', 'profile', 'model', 'machine'], switches: ['temporary', 'json'] });
  const [command = 'list', name, ...extra] = words;
  const accounts = await import('./webchat/accounts.js');
  if (command === 'worker') {
    const { runWebchatWorker } = await import('./webchat/worker.js');
    await runWebchatWorker({ rpc, self, findSession, machine, env });
    return 0;
  }
  if (command === 'add') {
    if (!name || extra.length) throw new Error(USAGE);
    if (!options.site) throw new Error('Choose the site: --site gemini, --site chatgpt or --site claude.');
    // A machine name is checked now, so a typo does not wait for the first question.
    if (options.machine) machine(options.machine);
    const { account, replaced } = accounts.addWebchat(name, {
      site: options.site, profile: options.profile, model: options.model ?? null,
      machine: options.machine ?? null, temporary: !!options.temporary,
    });
    print(`${replaced ? 'Changed' : 'Added'} ${account.id}: ${line(account)}`);
    print(`Sign in to ${account.siteLabel} in the browser profile "${account.profile}" first.`);
    print(`Ask it: helm delegate ${account.id} -- "your question"`);
    return 0;
  }
  if (command === 'list') {
    if (name) throw new Error(USAGE);
    const list = accounts.listWebchat();
    if (options.json) print(JSON.stringify({ accounts: list }));
    else if (!list.length) print('No web chat accounts. Add one with helm webchat add.');
    else for (const a of list) print(`${a.id}  ${line(a)}`);
    return 0;
  }
  if (command === 'remove') {
    if (!name || extra.length) throw new Error(USAGE);
    const gone = accounts.removeWebchat(name);
    print(`Removed ${gone.id}. Chats that used it stay, but cannot get new answers.`);
    return 0;
  }
  if (['help', '--help'].includes(command)) { print(USAGE); return 0; }
  throw new Error(`Unknown command: helm webchat ${command}. ${USAGE}`);
}

function line(a) {
  return [a.siteLabel, `profile ${a.profile}`, a.model ? `model ${a.model}` : 'model: the site default',
    a.temporary ? 'temporary chats' : 'saved chats', a.machine ? `browser on ${a.machine}` : null].filter(Boolean).join(', ');
}
