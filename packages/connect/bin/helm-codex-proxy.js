#!/usr/bin/env node
// Keep the native Codex connection on Helm's process host across daemon restarts.
import WebSocket from 'ws';
import { createInterface } from 'node:readline';

const socket = process.argv[2];
if (!socket) { process.stderr.write('Give the Codex socket path.\n'); process.exit(1); }
const ws = new WebSocket(`ws+unix://${socket}:/`);
const waiting = [];
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  if (!line.trim()) return;
  if (ws.readyState === WebSocket.OPEN) ws.send(line);
  else if (ws.readyState === WebSocket.CONNECTING) waiting.push(line);
});
input.on('close', () => { if (ws.readyState === WebSocket.CONNECTING) ws.terminate(); else ws.close(); });
ws.on('open', () => { for (const line of waiting.splice(0)) ws.send(line); });
ws.on('message', data => process.stdout.write(String(data) + '\n'));
process.stdout.on('error', () => ws.close());
ws.on('error', error => { process.stderr.write(`Could not connect to Codex: ${error.message}\n`); process.exitCode = 1; });
ws.on('close', () => { input.close(); process.stdin.destroy(); });
