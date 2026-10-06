#!/usr/bin/env node
// Claude Code runs this for each hook Helm adds to a terminal Claude
// (claude-hooks.js). Anything going wrong ends quietly with no output, so
// the terminal behaves exactly as it would without Helm.
import { sendHook } from '../src/claude-hooks.js';

const native = process.env.HELM_NATIVE_SESSION;
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  try {
    if (!native) return;
    const output = await sendHook(native, JSON.parse(input));
    if (output) process.stdout.write(JSON.stringify(output));
  } catch { /* nothing to say */ }
});
