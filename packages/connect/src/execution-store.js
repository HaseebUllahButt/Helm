import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Readers see either the old complete record or the new complete record.
export function writeExecution(dir, state) {
  const file = join(dir, `state-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
    renameSync(file, join(dir, 'state.json'));
  } finally {
    try { rmSync(file, { force: true }); } catch { /* Preserve the write error. */ }
  }
}

export function readExecution(dir) {
  return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
}
