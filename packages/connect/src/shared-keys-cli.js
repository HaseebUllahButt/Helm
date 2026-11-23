import { sealCodeSnapshot } from './code-transfer.js';
import { keyName, keyNames, keyValue, token } from './shared-key-store.js';
import { readHiddenLine } from './sudo-cli.js';

const RETRY = /timed out|timeout|not connected|did not respond|ECONN|socket|closed|restarting|starting/i;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function authorizeKeys(names, { rpc, self, target, kind, id = token(),
  chat = process.env.HELM_SESSION_ID || process.env.HELM_NATIVE_SESSION,
  callerThreadId = process.env.CODEX_THREAD_ID, signals = process, warn = console.error } = {}) {
  const request = { id, target, kind, names: keyNames(names), chat, callerThreadId };
  let stopped = false;
  const cancel = () => {
    stopped = true;
    void rpc(self, 'keys.cancel', { id }, 5_000).catch(() => {});
  };
  const call = async (method, params) => {
    while (!stopped) {
      try { return await rpc(self, method, params, 25_000); }
      catch (error) {
        if (error.rpc || !RETRY.test(error.message)) throw error;
        await pause(1000);
      }
    }
    return { state: 'cancelled' };
  };
  signals.on('SIGINT', cancel); signals.on('SIGTERM', cancel);
  try {
    let result = await call('keys.request', request);
    if (result.state === 'asking') warn('Allow the shared key request in the Helm app.');
    while (result.state === 'asking' && !stopped) {
      result = await call('keys.wait', { id });
      if (result.state === 'missing') result = await call('keys.request', request);
    }
    if (stopped || result.state === 'cancelled') throw new Error('The shared key request stopped.');
    if (result.state !== 'allowed') throw new Error('The owner denied access to the shared key.');
    return id;
  } finally {
    signals.off('SIGINT', cancel); signals.off('SIGTERM', cancel);
  }
}

export async function runKeysCommand(args, { rpc, self, env = process.env, read = readHiddenLine,
  write = console.log } = {}) {
  const [action, name] = args;
  const list = action === 'list' && (args.length === 1 || (args.length === 2 && name === '--json'));
  if (list) {
    const result = await rpc(self, 'keys.list', {});
    if (name === '--json') return write(JSON.stringify(result));
    if (!result.keys.length) write('No shared keys.');
    for (const key of result.keys) write([key.name, key.machines.join(', ') || 'Unused',
      key.lastUse ? new Date(key.lastUse).toISOString() : ''].join('  ').trimEnd());
    for (const grant of result.grants) write(`${grant.name}  ${grant.title || grant.chat}  ${grant.machine}  ${grant.id}`);
    return;
  }
  if (!['set', 'remove', 'revoke'].includes(action) || args.length !== 2) {
    throw new Error('Use helm keys set <NAME>, list, remove <NAME> or revoke <grant>.');
  }
  if (env.HELM_SESSION_ID || env.HELM_NATIVE_SESSION) throw new Error('Manage shared keys in Settings or from your own terminal.');
  if (action === 'revoke') {
    await rpc(self, 'keys.revoke', { id: name });
    write('Removed the shared key grant.');
    return;
  }
  keyName(name);
  if (action === 'remove') {
    await rpc(self, 'keys.remove', { name });
    write(`Removed ${name}.`);
    return;
  }
  const bytes = await read(`Enter the value for ${name}. Typing is hidden. `);
  if (!bytes) throw new Error('No key was saved.');
  try {
    let value;
    try { value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new Error('Use text for the key value.'); }
    keyValue(value);
    const { publicKey } = await rpc(self, 'keys.public', {});
    const sealed = sealCodeSnapshot({ value }, publicKey, `shared-key-save-${name}`);
    await rpc(self, 'keys.set', { name, sealed });
    write(`Saved ${name}.`);
  } finally { bytes.fill(0); }
}
