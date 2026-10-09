#!/usr/bin/env node
// Apply the owner's Claude 5.5 compaction policy without copying credentials
// or replacing other account settings. Run separately on each machine:
// node scripts/configure-claude-compaction.mjs ~/.claude-personal
import { readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const THRESHOLDS = { 'claude-opus-5-5': 350_000, 'claude-sonnet-5-5': 250_000, 'claude-haiku-5-5': 99_000 };

export function configureCompaction(configDir) {
  const file = join(resolve(configDir), 'settings.json');
  const before = readFileSync(file, 'utf8');
  const settings = JSON.parse(before);
  settings.autoCompactEnabled = true;
  settings.modelSettings ??= {};
  for (const [model, threshold] of Object.entries(THRESHOLDS)) {
    settings.modelSettings[model] ??= {};
    // Claude Code 2.1.295 reserves 20k output + 13k summary tokens. Verified
    // using get_context_usage (summary), so the actual trigger is threshold.
    settings.modelSettings[model].autoCompactWindow = threshold + 33_000;
  }
  const after = JSON.stringify(settings, null, 2) + '\n';
  if (after === before) return { changed: false, file, thresholds: THRESHOLDS };
  const suffix = `${Date.now()}-${process.pid}`;
  const backup = `${file}.backup-autocompact-${suffix}`;
  writeFileSync(backup, before, { mode: 0o600, flag: 'wx' });
  const temp = `${file}.autocompact-${suffix}`;
  try {
    writeFileSync(temp, after, { mode: statSync(file).mode & 0o777, flag: 'wx' });
    renameSync(temp, file);
  } finally {
    try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { changed: true, file, backup, thresholds: THRESHOLDS };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('usage: node scripts/configure-claude-compaction.mjs <Claude config directory>');
  console.log(JSON.stringify(configureCompaction(process.argv[2])));
}
