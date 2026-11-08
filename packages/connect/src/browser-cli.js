import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseAgentArgs } from './agent-args.js';

export async function runBrowserCommand(args, { rpc, self, findSession, env = process.env, print = console.log } = {}) {
  const { words, options } = parseAgentArgs(args, { values: ['session', 'output', 'budget', 'note', 'within', 'frame'], switches: ['full-page', 'default', 'clear-default', 'restart'] });
  const [command = 'tabs', tabId, source] = words;
  if (['help', '--help'].includes(command)) { print('helm browser open <url> | tabs | look <tab> [--within <CSS selector>] [--frame <number>] | act <tab> <JSON> | flows | run <tab> <name> key=value ... | point <tab> <element # or CSS selector> [--note <text>] | screenshot <tab> --output <path> | close <tab> | profiles | logins <profile> [--default] | logins --clear-default | mode [window|extended] [--restart] | setup [--session <chat-id>]'); return; }
  const sessionId = options.session || env.HELM_SESSION_ID || env.HELM_NATIVE_SESSION;
  if (!sessionId) throw new Error('run browser commands in a Helm chat, or pass --session <chat-id>');
  const target = options.session ? await findSession(sessionId) : { env: self(), session: { id: sessionId } };
  const id = target.session.id;
  let result;
  if (command === 'mode') {
    if (tabId && !['window', 'extended'].includes(tabId)) throw new Error('choose a browser mode: window or extended');
    if (options.restart && tabId !== 'extended') throw new Error('use --restart with helm browser mode extended');
    result = await rpc(target.env, 'browser.mode', { id, ...(tabId ? { mode: tabId, restart: !!options.restart } : {}) }, options.restart ? 60000 : 20000);
  }
  // Only when the owner asks: it opens a page and uses the clipboard on their screen.
  else if (command === 'setup') result = await rpc(target.env, 'browser.setup', { do: 'open' }, 30000);
  else if (command === 'profiles') result = await rpc(target.env, 'browser.profiles', { id });
  else if (command === 'logins') {
    if (options['clear-default']) { if (tabId || options.default) throw new Error('use --clear-default by itself'); result = await rpc(target.env, 'browser.loginDefault', { id, profileKey: null }); }
    else {
      const profileKey = words.slice(1).join(' '); if (!profileKey) throw new Error('choose a profile from helm browser profiles');
      result = await rpc(target.env, 'browser.importLogins', { id, profileKey }, 60000);
      if (options.default) result = { ...result, ...(await rpc(target.env, 'browser.loginDefault', { id, profileKey })) };
    }
  }
  else if (command === 'tabs') result = await rpc(target.env, 'browser.list', { id });
  else if (command === 'flows') result = await rpc(target.env, 'browser.flows', { id });
  else if (command === 'run') {
    const values = Object.fromEntries(words.slice(3).map(value => { const at = value.indexOf('='); if (at < 1) throw new Error('flow parameters use key=value'); return [value.slice(0, at), value.slice(at + 1)]; }));
    result = await rpc(target.env, 'browser.run', { id, tabId, name: source, with: values }, 60000);
  }
  else if (command === 'open') result = await rpc(target.env, 'browser.open', { id, url: tabId || 'about:blank' }, 30000);
  else if (command === 'close') result = await rpc(target.env, 'browser.close', { id, tabId });
  else if (['look', 'act', 'screenshot', 'point'].includes(command)) {
    if (command === 'point' && !source) throw new Error('point needs an element number or CSS selector');
    let action = command === 'look' ? { kind: 'look', budget: Number(options.budget ?? 6000), ...(options.within ? { within: options.within } : {}), ...(options.frame != null ? { frame: /^\d+$/.test(options.frame) ? Number(options.frame) : options.frame } : {}) } : command === 'screenshot' ? { kind: 'screenshot', fullPage: !!options['full-page'] }
      : command === 'point' ? { kind: 'point', ...(/^\d+$/.test(source) ? { ref: Number(source) } : { selector: source }), ...(options.note ? { note: options.note } : {}) } : JSON.parse(source || '{}');
    // A call may ask for more time than the usual minute.
    result = await rpc(target.env, 'browser.action', { id, tabId, action }, Math.max(60000, (Number(action.timeout) || 0) + 15000));
    if (command === 'screenshot') {
      if (!options.output) throw new Error('screenshot needs --output <path>');
      const match = /^data:image\/(?:jpeg|png);base64,(.+)$/.exec(result.image || ''); if (!match) throw new Error('browser did not return a screenshot');
      const path = resolve(options.output); await writeFile(path, Buffer.from(match[1], 'base64')); result = { output: path };
    }
  } else throw new Error(`unknown browser command: ${command}`);
  print(JSON.stringify(result, null, 2)); return result;
}
