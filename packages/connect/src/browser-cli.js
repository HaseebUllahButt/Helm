import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseAgentArgs } from './delegation.js';

export async function runBrowserCommand(args, { rpc, self, findSession, env = process.env, print = console.log } = {}) {
  const { words, options } = parseAgentArgs(args, { values: ['session', 'engine', 'output', 'budget'], switches: ['full-page'] });
  const [command = 'tabs', tabId, source] = words;
  if (['help', '--help'].includes(command)) { print('helm browser open <url> [--engine chromium|bowser] | tabs | look <tab> | act <tab> <JSON> | screenshot <tab> --output <path> | close <tab> [--session <thread>]'); return; }
  const sessionId = options.session || env.HELM_SESSION_ID || env.HELM_NATIVE_SESSION;
  if (!sessionId) throw new Error('run browser commands in a Helm chat, or pass --session <thread>');
  const target = options.session ? await findSession(sessionId) : { env: self(), session: { id: sessionId } };
  const id = target.session.id;
  let result;
  if (command === 'tabs') result = await rpc(target.env, 'browser.list', { id });
  else if (command === 'open') result = await rpc(target.env, 'browser.open', { id, url: tabId || 'about:blank', engine: options.engine || 'chromium' }, 30000);
  else if (command === 'close') result = await rpc(target.env, 'browser.close', { id, tabId });
  else if (['look', 'act', 'screenshot'].includes(command)) {
    let action = command === 'look' ? { kind: 'look', budget: Number(options.budget ?? 6000) } : command === 'screenshot' ? { kind: 'screenshot', fullPage: !!options['full-page'] } : JSON.parse(source || '{}');
    result = await rpc(target.env, 'browser.action', { id, tabId, action }, 60000);
    if (command === 'screenshot') {
      if (!options.output) throw new Error('screenshot needs --output <path>');
      const match = /^data:image\/(?:jpeg|png);base64,(.+)$/.exec(result.image || ''); if (!match) throw new Error('browser did not return a screenshot');
      const path = resolve(options.output); await writeFile(path, Buffer.from(match[1], 'base64')); result = { output: path };
    }
  } else throw new Error(`unknown browser command: ${command}`);
  print(JSON.stringify(result, null, 2)); return result;
}
