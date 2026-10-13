import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

// A rename alone is not a durable journal: sync the file and its parent.
export function saveRecord(file, record) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, file);
  syncDirectory(dirname(file));
}
export function syncDirectory(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function records(dir) {
  try { return readdirSync(dir).filter(n => /^[a-f0-9]{24}\.json$/.test(n)).map(n => JSON.parse(readFileSync(join(dir, n), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
