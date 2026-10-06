#!/usr/bin/env node
import { runClaudeChannel } from '../src/claude-channel.js';
try { await runClaudeChannel(process.env.HELM_NATIVE_SESSION); }
catch (error) { console.error(`Helm chat: ${error.message}`); process.exitCode = 1; }
