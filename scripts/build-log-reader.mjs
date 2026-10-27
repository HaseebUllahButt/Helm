import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binaryPath, crateDir } from '../native/log-index/build-id.mjs';

const exec = promisify(execFile);
export async function buildLogReader({ required = false, log = console.log } = {}) {
  const output = binaryPath();
  if (existsSync(output)) return { available: true, output };
  const homeCargo = join(homedir(), '.cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
  const cargo = process.env.CARGO || (existsSync(homeCargo) ? homeCargo : 'cargo');
  try { await exec(cargo, ['--version']); }
  catch (error) {
    if (required || error.code !== 'ENOENT') throw error;
    log('Keep the current chat reader. Install Rust to build the faster reader.');
    return { available: false };
  }
  log('Build the Rust chat reader.');
  const args = ['build', '--release', '--locked', '--manifest-path', join(crateDir, 'Cargo.toml')];
  try { await exec(cargo, args, { maxBuffer: 8 * 1024 * 1024 }); }
  catch (error) { throw new Error(`Cannot build the Rust chat reader.\n${error.stderr || error.message}`); }
  const library = process.platform === 'win32' ? 'helm_log_index.dll'
    : process.platform === 'darwin' ? 'libhelm_log_index.dylib' : 'libhelm_log_index.so';
  const target = process.env.CARGO_TARGET_DIR || join(crateDir, 'target');
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    copyFileSync(join(target, 'release', library), temporary);
    renameSync(temporary, output);
    // Load in a separate process so a failed build cannot replace a running reader.
    await exec(process.execPath, ['-e', 'require(process.argv[1]).scanEventPositions(Buffer.from("{}"))', output]);
  } catch (error) { rmSync(output, { force: true }); throw error; }
  finally { rmSync(temporary, { force: true }); }
  return { available: true, output };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildLogReader();
}
