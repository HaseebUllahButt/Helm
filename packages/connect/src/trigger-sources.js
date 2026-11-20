import { createHash } from 'node:crypto';
import { glob, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { ENGINES } from './engines.js';
import { usableProfiles } from './auth.js';
import { getProfiles } from './profiles.js';
import { accountKey, pickerPrefs } from './settings.js';
import { startWork } from './work-command.js';
import { ownNode } from './own-node.js';

export const digest = value => createHash('sha256').update(value).digest('hex');

export function onMachine(path, cwd = homedir()) {
  return path === '~' || /^~[/\\]/.test(path)
    ? resolve(homedir(), path.slice(2)) : resolve(cwd, path);
}

export async function fileFingerprint(path, pattern) {
  const paths = pattern ? [] : [path];
  if (pattern) for await (const match of glob(path)) paths.push(match);
  const hash = createHash('sha256');
  for (const file of paths.sort()) {
    try {
      const s = await stat(file, { bigint: true });
      hash.update(JSON.stringify([file, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String)));
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
  }
  return hash.digest('hex');
}

export function shellArgs(command) {
  return process.platform === 'win32'
    ? [process.env.ComSpec || 'cmd.exe', '/d', '/c', command]
    : ['/bin/sh', '-c', command];
}

/** Hash all output, with separate hashes so pipe timing cannot change it. */
export function checkCommand(command, cwd, signal) {
  return new Promise((resolve, reject) => {
    const child = startWork({ argv: shellArgs(command), cwd, timeout: 60_000 }, { node: ownNode() });
    const out = createHash('sha256'), err = createHash('sha256');
    let failure;
    const cancel = () => { if (child.connected) child.send({ cancel: true }, () => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    child.stdin.end();
    child.stdout.on('data', data => out.update(data));
    child.stderr.on('data', data => err.update(data));
    child.on('message', message => { if (message.error) failure = message.error; });
    child.once('error', reject);
    child.once('close', (code, killed) => {
      signal.removeEventListener('abort', cancel);
      if (failure || killed || code == null) reject(new Error(failure || 'The check command stopped.'));
      else resolve(JSON.stringify([code, out.digest('hex'), err.digest('hex')]));
    });
  });
}

export async function triggerAccount(wanted, fallback) {
  const profiles = await usableProfiles((await getProfiles()).filter(p => ENGINES[p.engine]?.driver));
  const picker = pickerPrefs();
  const matching = key => profiles.find(p => key === p.id || key === accountKey(p));
  if (!wanted) {
    const profile = [fallback, picker.agent, picker.last].filter(Boolean).map(matching).find(Boolean)
      ?? profiles.find(p => !picker.hidden.includes(accountKey(p)));
    if (!profile) throw new Error('Choose an account that Helm can start. Run helm agents.');
    return profile.id;
  }
  const exact = matching(wanted);
  if (exact) return exact.id;
  const matches = profiles.filter(p => [p.id, p.label].some(name => name?.toLowerCase() === wanted.toLowerCase()));
  if (matches.length === 1) return matches[0].id;
  throw new Error(matches.length ? 'More than one account matches. Use the ID from helm agents.'
    : 'Helm cannot start chats with this account. Run helm agents.');
}
