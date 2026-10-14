import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const number = (value) => { const n = Number(value); if (value === undefined || !Number.isFinite(n)) throw new Error('Coordinates must be numbers.'); return n; };
/** helm device <operation> [id] --machine <name> [--session <thread>] */
export async function runDeviceCommand(args, { rpc, self, machineId, env = process.env, print = console.log } = {}) {
  const [operation = 'list', ...rest] = args;
  const values = [], flags = {};
  let agentArgs = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--') { agentArgs = rest.slice(i + 1); break; }
    if (arg.startsWith('--')) {
      const flag = arg.slice(2);
      if (!['machine','output','session'].includes(flag) || !rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error(`Invalid device option ${arg}.`);
      if (flags[flag]) throw new Error(`Duplicate device option ${arg}.`);
      flags[flag] = rest[++i];
    } else values.push(arg);
  }
  const target = flags.machine ? machineId(flags.machine) : typeof self === 'function' ? self() : self;
  const sessionId = flags.session || env.HELM_SESSION_ID || env.HELM_NATIVE_SESSION || undefined;
  const params = { ...(sessionId ? { sessionId } : {}) };
  let method = `device.${operation}`;
  if (['list','readiness'].includes(operation)) { if (values.length) throw new Error(`helm device ${operation} takes no device ID.`); }
  else if (operation === 'close') { if (!sessionId || values.length) throw new Error('helm device close requires --session or an agent thread.'); }
  else {
    if (!values[0]) throw new Error('Pass the exact device ID returned by helm device list.');
    params.deviceId = values[0];
    if (['tap','swipe','type','key','launch'].includes(operation)) {
      method = 'device.action';
      if (operation === 'tap' && values.length === 3) params.action = { type: 'tap', x: number(values[1]), y: number(values[2]) };
      else if (operation === 'swipe' && [5,6].includes(values.length)) params.action = { type: 'swipe', x: number(values[1]), y: number(values[2]), x2: number(values[3]), y2: number(values[4]), ...(values[5] ? { duration: number(values[5]) } : {}) };
      else if (operation === 'type' && values.length === 2) params.action = { type: 'type', text: values[1] };
      else if (operation === 'key' && values.length === 2) params.action = { type: 'key', key: values[1] };
      else if (operation === 'launch' && values.length === 2) params.action = { type: 'open', ...(/^[a-z][a-z0-9+.-]*:/i.test(values[1]) ? { url: values[1] } : { app: values[1] }) };
      else throw new Error(`Invalid helm device ${operation} arguments.`);
    } else if (operation === 'agent') { if (values.length !== 1 || !agentArgs.length) throw new Error('Usage: helm device agent <id> [--machine <host>] -- snapshot -i'); params.args = agentArgs; }
    else if (!['start','open','screenshot'].includes(operation) || values.length !== 1) throw new Error('Device commands: readiness, list, start, open, close, tap, swipe, type, key, launch, screenshot, agent.');
  }
  if (agentArgs.length && operation !== 'agent') throw new Error('-- arguments are only supported for helm device agent.');
  if (flags.output && operation !== 'screenshot') throw new Error('--output is only supported for screenshot.');
  const result = await rpc(target, method, params, ['start','open','agent'].includes(operation) ? 200_000 : 30_000);
  if (operation === 'screenshot' && flags.output) {
    const output = resolve(flags.output);
    await writeFile(output, Buffer.from(result.data, 'base64'), { mode: 0o600 });
    print(JSON.stringify({ output, width: result.width, height: result.height, mimeType: result.mimeType }));
  } else print(JSON.stringify(result, null, 2));
  return result;
}
