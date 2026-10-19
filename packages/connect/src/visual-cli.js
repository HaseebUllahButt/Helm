import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareVisual, previewVisual } from './visual.js';

export async function runVisualCommand(command, args, { rpc, self, findSession, env = process.env, print = console.log, preview = previewVisual } = {}) {
  const options = {}, files = [];
  const flags = new Set(command === 'render' ? ['title', 'height', 'session', 'render-id'] : ['output', 'width', 'appearance']);
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (!flags.has(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`invalid visual option: ${args[i]}`);
      options[key] = args[++i];
    } else files.push(args[i]);
  }
  if (files.length !== 1) throw new Error(`usage: helm ${command} <file.html | picture.png>`);
  const html = await prepareVisual(files[0]);
  if (command === 'preview') {
    const output = resolve(options.output || `${tmpdir()}/helm-visual-${randomBytes(6).toString('hex')}.png`);
    const result = await preview(html, { output, width: Number(options.width ?? 900), appearance: options.appearance ?? 'dark' });
    print(JSON.stringify(result, null, 2));
    return result;
  }
  const id = options.session || env.HELM_SESSION_ID || env.HELM_NATIVE_SESSION;
  if (!id) throw new Error('run helm render inside an agent chat, or pass --session <chat-id>');
  const target = options.session ? await findSession(id) : { env: self(), session: { id } };
  const renderId = options['render-id'] || randomBytes(12).toString('hex');
  const params = { id: target.session.id, html, title: options.title || 'Visual reply', height: Number(options.height ?? 420), renderId };
  let result;
  try { result = await rpc(target.env, 'session.render', params, 60_000); }
  catch (error) { throw new Error(`${error.message}. If delivery is uncertain, retry the same file and options with --render-id ${renderId}; that ID prevents duplicate visuals.`); }
  print(JSON.stringify({ sessionId: target.session.id, renderId, ...result }, null, 2));
  return result;
}
