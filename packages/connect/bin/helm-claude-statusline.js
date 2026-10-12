#!/usr/bin/env node
// Capture only Claude's native quota windows; preserve the owner's status line verbatim.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sendHook } from '../src/claude-hooks.js';
let input = '';

/**
 * How full the conversation is, as Claude's own /context counts it: against
 * the account's compaction window when settings.json sets a smaller one.
 */
function contextFrom(state) {
  const c = state.context_window;
  const used = (c?.total_input_tokens ?? 0) + (c?.total_output_tokens ?? 0);
  let window = c?.context_window_size;
  if (!(used > 0) || !(window > 0)) return null;
  try {
    const dir = (process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')).replace(/^~(?=\/|$)/, homedir());
    const bare = id => String(id).toLowerCase().replace(/\[.*\]$/, '').replace(/-\d{8}$/, '');
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).modelSettings ?? {};
    const compact = Object.entries(settings).find(([id]) => bare(id) === bare(state.model?.id))?.[1]?.autoCompactWindow;
    if (compact > 0 && compact < window) window = compact;
  } catch { /* no settings: the model's own window */ }
  return { used, window };
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  const capture = async () => {
    try {
      const state = JSON.parse(input), limits = state.rate_limits;
      if (process.env.HELM_NATIVE_SESSION) await sendHook(process.env.HELM_NATIVE_SESSION,
        { hook_event_name: 'HelmSettings', model: state.model?.id, effort: state.effort, session_id: state.session_id }, { timeoutMs: 1000 });
      const context = contextFrom(state);
      if (context && process.env.HELM_NATIVE_SESSION) await sendHook(process.env.HELM_NATIVE_SESSION,
        { hook_event_name: 'HelmContext', ...context }, { timeoutMs: 1000 });
      if (limits && process.env.HELM_NATIVE_SESSION) await sendHook(process.env.HELM_NATIVE_SESSION,
        { hook_event_name: 'HelmUsage', rate_limits: limits }, { timeoutMs: 1000 });
    } catch { /* a missing Helm never breaks the owner's status line */ }
  };
  const command = process.argv[2];
  const render = command ? new Promise(resolve => {
    const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'inherit', 'inherit'] });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('error', () => resolve());
    child.on('exit', code => { process.exitCode = code ?? 0; resolve(); });
  }) : Promise.resolve();
  await Promise.all([capture(), render]);
});
