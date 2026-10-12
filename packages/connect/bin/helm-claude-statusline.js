#!/usr/bin/env node
// Capture only Claude's native quota windows; preserve the owner's status line verbatim.
import { spawn } from 'node:child_process';
import { sendHook } from '../src/claude-hooks.js';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  const capture = async () => {
    try {
      const state = JSON.parse(input), limits = state.rate_limits;
      if (process.env.HELM_NATIVE_SESSION) await sendHook(process.env.HELM_NATIVE_SESSION,
        { hook_event_name: 'HelmSettings', model: state.model?.id, effort: state.effort, session_id: state.session_id }, { timeoutMs: 1000 });
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
