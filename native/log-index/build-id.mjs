import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const crateDir = fileURLToPath(new URL('.', import.meta.url));
export function buildId(dir = crateDir) {
  const sources = path => readdirSync(join(dir, path), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? sources(join(path, entry.name)) : entry.name.endsWith('.rs') ? [join(path, entry.name)] : []);
  const hash = createHash('sha256');
  for (const name of ['Cargo.toml', 'Cargo.lock', 'build.rs', ...sources('src')].sort()) {
    hash.update(name.replaceAll('\\', '/')); hash.update('\0'); hash.update(readFileSync(join(dir, name)));
  }
  return hash.digest('hex').slice(0, 20);
}
export function binaryPath(dir = crateDir) {
  return join(dir, `log-index.${process.platform}-${process.arch}.${buildId(dir)}.node`);
}
