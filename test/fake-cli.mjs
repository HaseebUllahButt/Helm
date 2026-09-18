#!/usr/bin/env node
// Replays a recorded CLI stream so driver tests run without the real CLI.
//
//   FAKE_FIXTURE=test/fixtures/claude/tool.ndjson FAKE_STDIN=/tmp/in node test/fake-cli.mjs claude ...
//
// Rules, so the pairing of requests and responses is real rather than
// scripted:
//   - every stdin line is appended to FAKE_STDIN
//   - claude: nothing is printed until the first user message arrives; a
//     recorded control_request pauses until a control_response for it is
//     read; a recorded control_response (the receipt for an interrupt)
//     waits for a control_request from the test and echoes its request_id
//   - codex, and the ACP CLIs (devin, opencode): a recorded response (id +
//     result) waits for the next request from the test and takes its id; a
//     recorded server request (id + method, like session/request_permission)
//     pauses until the test answers it; notifications flow freely
// `--version` prints a version that satisfies the driver.

import { readFileSync, appendFileSync } from 'node:fs';

const VERSIONS = { codex: 'codex-cli 0.154.0', devin: 'devin 3000.10.21', opencode: '1.18.26' };
const kind = process.argv[2];
if (process.argv.includes('--version')) {
  console.log(VERSIONS[kind] ?? '2.1.260 (Claude Code)');
  process.exit(0);
}

const lines = readFileSync(process.env.FAKE_FIXTURE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const stdinLog = process.env.FAKE_STDIN;
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const inbox = [];
const waiters = [];
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    if (stdinLog) appendFileSync(stdinLog, line + '\n');
    const msg = JSON.parse(line);
    if (process.env.FAKE_DEBUG) process.stderr.write(`fake: in ${msg.type ?? msg.method ?? msg.id} waiters=${waiters.length}\n`);
    const w = waiters.findIndex((x) => x.pred(msg));
    if (w >= 0) waiters.splice(w, 1)[0].resolve(msg);
    else inbox.push(msg);
  }
});
process.stdin.on('end', () => setTimeout(() => process.exit(0), 50));

function next(pred) {
  const i = inbox.findIndex(pred);
  if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
  return new Promise((resolve) => waiters.push({ pred, resolve }));
}

if (kind === 'claude') {
  const asked = new Set(lines.filter((m) => m.type === 'control_request').map((m) => m.request_id));
  await next((m) => m.type === 'user');
  for (const m of lines) {
    if (m.type === 'control_request') {
      out(m);
      if (process.env.FAKE_DEBUG) process.stderr.write(`fake: waiting for response to ${m.request_id}\n`);
      await next((x) => x.type === 'control_response' && x.response?.request_id === m.request_id);
      if (process.env.FAKE_DEBUG) process.stderr.write(`fake: resumed after ${m.request_id}\n`);
      continue;
    }
    if (m.type === 'control_response') {
      // The CLI acknowledges our permission answers with a control_response
      // of its own; those just print. A response to a request con sent (an
      // interrupt receipt) waits for the test to send that request.
      if (asked.has(m.response?.request_id)) { out(m); continue; }
      const req = await next((x) => x.type === 'control_request');
      out({ ...m, response: { ...m.response, request_id: req.request_id } });
      continue;
    }
    if (m.type === 'user' && m.isReplay) { out(m); continue; }
    out(m);
    await sleep(2);
  }
  // Like the CLI: stay alive until stdin closes.
} else {
  for (const m of lines) {
    if (m.id !== undefined && m.method) {
      out(m);
      await next((x) => x.id === m.id && ('result' in x || 'error' in x));
      continue;
    }
    if (m.id !== undefined) {
      const req = await next((x) => x.id !== undefined && x.method);
      out({ ...m, id: req.id });
      continue;
    }
    out(m);
    await sleep(2);
  }
}
