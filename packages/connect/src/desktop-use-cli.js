export const DESKTOP_USAGE = 'helm desktop guide [platform | <topic>] | apps | open <app> [args...] | look <app> [snapshot options] | close <app> | restart <app> | switch [on | off] | <any agent-desktop command> [options]';

export async function runDesktopCommand(args, { rpc, self, findSession, env = process.env, print = console.log } = {}) {
  // Only --session belongs to Helm. Every other word and option goes to the desktop program as it is.
  const at = args.indexOf('--session'), sessionArg = at >= 0 ? args[at + 1] : undefined;
  const rest = at >= 0 ? [...args.slice(0, at), ...args.slice(at + 2)] : args;
  const [command = 'help', ...more] = rest;
  if (['help', '--help', '-h'].includes(command)) { print(DESKTOP_USAGE); return; }
  const sessionId = sessionArg || env.HELM_SESSION_ID || env.HELM_NATIVE_SESSION;
  if (!sessionId) throw new Error('run desktop commands in a Helm chat, or pass --session <chat-id>');
  const target = sessionArg ? await findSession(sessionId) : { env: self(), session: { id: sessionId } };
  const id = target.session.id, call = (method, params = {}, timeout = 60000) => rpc(target.env, `desktop.${method}`, { id, ...params }, timeout);
  const app = () => { if (!more[0] || more[0].startsWith('-')) throw new Error(`${command} needs an app name, for example from helm desktop apps`); return more[0]; };
  let result;
  if (command === 'guide') result = await call('guide', { topic: more.join(' ') });
  else if (command === 'apps') result = await call('apps');
  else if (command === 'open') result = await call('open', { app: app(), args: more.slice(1) }, 60000);
  else if (command === 'restart') result = await call('restart', { app: app(), args: more.slice(1) }, 120000);
  else if (command === 'close') result = await call('close', { app: app() });
  else if (command === 'look') result = await call('look', { app: app(), args: more.slice(1) });
  else if (command === 'switch') {
    if (more[0] && !['on', 'off'].includes(more[0])) throw new Error('use helm desktop switch, switch on or switch off');
    result = await call('switch', more[0] ? { on: more[0] === 'on' } : {});
  } else result = await call('run', { args: rest }, 130000);
  if (typeof result?.guide === 'string') print(result.guide);
  // One line, as the program prints it: snapshots are long.
  else print(JSON.stringify(result));
  return result;
}
