import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { expand } from './paths.js';
import { createBackup, restoreBackup } from './backup.js';

/** Keys travel through a private file, never through arguments or chat output. */
export function backupCommand(args, { log = console.log } = {}) {
  const [command, ...rest] = args;
  if (command === 'key') {
    if (rest.length !== 1) throw new Error('Use helm backup key <file>.');
    const secret = randomBytes(32);
    try { writeFileSync(expand(rest[0]), secret, { mode: 0o600, flag: 'wx' }); }
    finally { secret.fill(0); }
    log('Backup key saved. Keep a separate safe copy. Helm cannot replace a lost key.');
    return;
  }
  const position = rest.indexOf('--key-file');
  if (position < 0 || !rest[position + 1]) throw new Error('Choose a private key file with --key-file <file>.');
  const keyFile = expand(rest[position + 1]);
  rest.splice(position, 2);
  const offline = rest.includes('--offline');
  if (offline) rest.splice(rest.indexOf('--offline'), 1);
  if (!['create', 'restore'].includes(command) || rest.length !== 2 || rest.some(v => v.startsWith('--'))) {
    throw new Error('Use helm backup create <folder> <file> --key-file <file> --offline, or helm backup restore <file> <folder> --key-file <file>.');
  }
  if (process.platform !== 'win32' && (statSync(keyFile).mode & 0o077)) {
    throw new Error('Make the key file private: chmod 600 <key-file>.');
  }
  const password = readFileSync(keyFile);
  try {
    if (command === 'create') {
      const result = createBackup({ source: expand(rest[0]), destination: expand(rest[1]), password, offline });
      log(`Encrypted backup saved with ${result.files} files. Keep its key in a separate safe place.`);
    } else {
      restoreBackup({ archive: expand(rest[0]), destination: expand(rest[1]), password });
      log('Backup restored for offline review. Startup is blocked. Check current trusted removals and completed work before recovery.');
    }
  } finally { password.fill(0); }
}
