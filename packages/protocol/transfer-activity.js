import { mkdirSync, writeFileSync, utimesSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { HELM_DIR } from './network.js';

// Runtime metadata, not payload: Linux /tmp is normally tmpfs. Isolate both
// users and test/development Helm homes. Expiring leases recover after crashes.
const DIR = join(tmpdir(), `helm-transfers-${userInfo().uid}-${createHash('sha256').update(HELM_DIR).digest('hex').slice(0, 16)}`);
const STALE_MS = 45_000;

export function beginTransferActivity(dir = DIR) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${process.pid}-${randomBytes(12).toString('hex')}`);
  writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
  const timer = setInterval(() => {
    try { const now = new Date(); utimesSync(file, now, now); } catch { /* update sees a stale lease */ }
  }, 10_000);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    try { unlinkSync(file); } catch { /* already released */ }
  };
}

export function hasActiveTransfers(dir = DIR, now = Date.now()) {
  let names;
  try { names = readdirSync(dir); } catch { return false; }
  let active = false;
  for (const name of names) {
    if (!/^\d+-[a-f0-9]{24}$/.test(name)) continue;
    const file = join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > STALE_MS) throw new Error('stale');
      process.kill(Number(name.split('-')[0]), 0);
      active = true;
    } catch {
      try { unlinkSync(file); } catch { /* another process cleaned up */ }
    }
  }
  return active;
}
