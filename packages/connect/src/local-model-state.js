import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { HELM_DIR } from './paths.js';

export const modelDir = join(HELM_DIR, 'local-models');
export const hosts = (net) => Object.values(net.machines).filter((m) => !net.revoked?.[m.id]);
export const modelUrl = (port) => `http://127.0.0.1:${port}/v1`;
export const validPort = (port) => Number.isInteger(port) && port > 0 && port < 65536;
export const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 32);

export function modelName(value) {
  if (typeof value !== 'string' || value.length > 200
      || !/^(?:[a-z0-9][a-z0-9._-]*\/)*[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)?$/i.test(value)) {
    throw new Error('Give an Ollama model name, such as qwen2.5:0.5b.');
  }
  return value.toLowerCase().replace(/:latest$/, '');
}

export function readModelState(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export function writeModelState(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, file);
}

export function forwardId(host, peer, generation) {
  return hash(JSON.stringify(['local-models', host, peer, generation]));
}
