#!/usr/bin/env node
// Record what the agent CLIs really say on the wire.
//
// Runs one short turn per case against the installed `claude` and `codex`
// using the owner's real logins, and writes every stdout line to
// test/fixtures/<engine>/<case>.ndjson and every stdin line to
// <case>.in.ndjson. The drivers and their tests are written against these
// files, not against documentation.
//
//   node scripts/record-driver.mjs claude                    # all claude cases
//   node scripts/record-driver.mjs codex command             # one codex case
//   HELM_PROFILE=claudea node scripts/record-driver.mjs claude
//
// The CLI is launched the way helm launches it: through a helm profile
// (`materialize`), so the account, its home directory and its credential
// are the real ones. HELM_PROFILE picks the profile; it defaults to the
// engine's plain profile.
//
// Everything runs in a throwaway directory. Home paths are scrubbed to `~`
// before writing so the fixtures can be committed.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadProfiles, materialize } from '../packages/connect/src/profiles.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'test', 'fixtures');
const HOME = homedir();

const scrub = (line) => line.split(HOME).join('~');

function launcher(engine) {
  const id = process.env.HELM_PROFILE ?? engine;
  const profile = (loadProfiles()?.profiles ?? []).find((p) => p.id === id);
  if (!profile) throw new Error(`no helm profile '${id}'; run helm profiles`);
  const spec = materialize(profile);
  console.log(`using profile ${id} (${spec.cmd}, env ${Object.keys(spec.env).join(',') || 'none'})`);
  return { cmd: spec.cmd, env: spec.env };
}

/** A child speaking newline-delimited JSON on stdio, with both directions logged. */
class Wire {
  constructor(cmd, args, { cwd, env }) {
    this.out = [];
    this.in = [];
    this.handlers = [];
    this.child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', (d) => process.stderr.write(`  [stderr] ${d}`));
    let buf = '';
    this.child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        this.out.push(line);
        let msg; try { msg = JSON.parse(line); } catch { console.log('  [non-json]', line.slice(0, 120)); continue; }
        for (const h of this.handlers) h(msg);
      }
    });
    this.exited = new Promise((r) => this.child.on('exit', (code, sig) => r({ code, sig })));
  }
  send(obj) {
    const line = JSON.stringify(obj);
    this.in.push(line);
    this.child.stdin.write(line + '\n');
  }
  on(h) { this.handlers.push(h); }
  wait(pred, ms = 120_000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting')), ms);
      this.on((m) => { if (pred(m)) { clearTimeout(t); resolve(m); } });
    });
  }
  async end() {
    this.child.stdin.end();
    const r = await Promise.race([this.exited, new Promise((r) => setTimeout(() => r(null), 8000))]);
    if (!r) this.child.kill('SIGKILL');
  }
  save(engine, name) {
    const dir = join(FIXTURES, engine);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.ndjson`), this.out.map(scrub).join('\n') + '\n');
    writeFileSync(join(dir, `${name}.in.ndjson`), this.in.map(scrub).join('\n') + '\n');
    console.log(`  saved ${engine}/${name}: ${this.out.length} out, ${this.in.length} in`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-record-'));
  writeFileSync(join(dir, 'README.md'), '# scratch\n\nhelm recording fixture.\n');
  return dir;
};

// ------------------------------------------------------------------ claude

const CLAUDE_BASE = [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool', 'stdio',
  '--model', 'haiku', '--max-turns', '4',
];

const userMsg = (text) => ({
  type: 'user', session_id: '', parent_tool_use_id: null, uuid: randomUUID(),
  message: { role: 'user', content: [{ type: 'text', text }] },
});

/**
 * @param {object} c
 * @param {string} c.prompt
 * @param {string} [c.mode]
 * @param {(req: any) => any} c.answer   returns the PermissionResult for a can_use_tool
 * @param {boolean} [c.interrupt]
 */
async function claudeCase(name, c) {
  console.log(`\n== claude/${name}`);
  const cwd = scratch();
  const args = [...CLAUDE_BASE, '--permission-mode', c.mode ?? 'default', `--session-id=${randomUUID()}`];
  const w = new Wire(CLAUDE.cmd, args, { cwd, env: CLAUDE.env });
  let interrupted = false;
  w.on((m) => {
    if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
      const res = c.answer(m.request);
      console.log(`  can_use_tool ${m.request.tool_name} -> ${res.behavior}`);
      w.send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: res } });
    }
    if (m.type === 'control_request' && m.request?.subtype !== 'can_use_tool') {
      console.log(`  control_request ${m.request?.subtype} (unanswered)`);
    }
    if (c.interrupt && !interrupted && m.type === 'stream_event' && m.event?.type === 'content_block_delta') {
      interrupted = true;
      setTimeout(() => w.send({ type: 'control_request', request_id: 'helm-int-1', request: { subtype: 'interrupt', cancel_queued: true } }), 300);
    }
  });
  w.send(userMsg(c.prompt));
  try { await w.wait((m) => m.type === 'result'); } catch (e) { console.log('  ', e.message); }
  await sleep(500);
  await w.end();
  w.save('claude', name);
}

const CLAUDE_CASES = {
  plain: { prompt: 'Reply with exactly the words: hello from helm', answer: () => ({ behavior: 'deny', message: 'no tools in this test' }) },
  // `echo` is on Claude Code's built-in safe list and never prompts in default
  // mode; a Write does, and comes with a permission_suggestions setMode.
  tool: {
    prompt: 'Use the Bash tool to run `echo helm-test`, then use the Write tool to save its output to a file named out.txt in this directory. Then say done in one line.',
    answer: () => ({ behavior: 'allow' }),
  },
  deny: {
    prompt: 'Use the Write tool to create a file named out.txt containing "hi". If you cannot, say so in one line.',
    answer: () => ({ behavior: 'deny', message: 'The user declined this on their phone.' }),
  },
  always: {
    prompt: 'Use the Write tool to create a file named a.txt containing "a", then another file named b.txt containing "b". Then say done in one line.',
    answer: (req) => ({ behavior: 'allow', updatedPermissions: req.permission_suggestions ?? [] }),
  },
  question: {
    prompt: 'Use the AskUserQuestion tool to ask me one question: "Tabs or spaces?" with exactly two options, "Tabs" and "Spaces". Then tell me which I chose in one line.',
    answer: (req) => {
      if (req.tool_name !== 'AskUserQuestion') return { behavior: 'deny', message: 'only the question please' };
      // AskUserQuestionInput has an `answers` map (question text -> chosen
      // label) "collected by the permission component": we are that component.
      const q = req.input.questions[0];
      const chosen = q.options.find((o) => /spaces/i.test(o.label)) ?? q.options[0];
      return { behavior: 'allow', updatedInput: { ...req.input, answers: { [q.question]: chosen.label } } };
    },
  },
  plan: {
    mode: 'plan',
    prompt: 'Write a one-line plan to add a LICENSE file to this directory, then call ExitPlanMode to present it.',
    answer: (req) => (req.tool_name === 'ExitPlanMode' ? { behavior: 'allow' } : { behavior: 'deny', message: 'plan only' }),
  },
  interrupt: {
    interrupt: true,
    prompt: 'Write the numbers from 1 to 300, one per line, with no other text.',
    answer: () => ({ behavior: 'deny', message: 'no tools' }),
  },
};

// ------------------------------------------------------------------- codex

async function codexCase(name, c) {
  console.log(`\n== codex/${name}`);
  const cwd = scratch();
  const w = new Wire(CODEX.cmd, ['app-server', '--stdio'], { cwd, env: CODEX.env });
  let id = 0;
  const call = (method, params) => {
    const rid = ++id;
    w.send({ jsonrpc: '2.0', id: rid, method, params });
    return w.wait((m) => m.id === rid && ('result' in m || 'error' in m));
  };
  let turnId = null, threadId = null, interrupted = false;
  w.on((m) => {
    if (m.id !== undefined && m.method) {
      const res = c.answer(m.method, m.params);
      console.log(`  server request ${m.method} -> ${JSON.stringify(res)}`);
      w.send({ jsonrpc: '2.0', id: m.id, result: res });
    }
    if (c.interrupt && !interrupted && m.method === 'item/agentMessage/delta' && turnId) {
      interrupted = true;
      setTimeout(() => call('turn/interrupt', { threadId, turnId }), 300);
    }
  });
  await call('initialize', { clientInfo: { name: 'helm', title: 'Helm', version: '0.0.1' }, capabilities: { experimentalApi: true } });
  w.send({ jsonrpc: '2.0', method: 'initialized' });
  const started = await call('thread/start', {
    cwd, approvalPolicy: c.approvalPolicy ?? 'on-request', sandbox: c.sandbox ?? 'workspace-write',
  });
  if (!started.result) throw new Error(`thread/start failed: ${JSON.stringify(started.error)}`);
  threadId = started.result?.thread?.id;
  const turn = await call('turn/start', {
    threadId, input: [{ type: 'text', text: c.prompt, text_elements: [] }], effort: 'low',
  });
  turnId = turn.result?.turn?.id;
  try { await w.wait((m) => m.method === 'turn/completed', 180_000); } catch (e) { console.log('  ', e.message); }
  await sleep(500);
  await w.end();
  w.save('codex', name);
}

const CODEX_CASES = {
  plain: { prompt: 'Reply with exactly the words: hello from helm', answer: () => ({ decision: 'decline' }) },
  command: {
    approvalPolicy: 'untrusted',
    prompt: 'Run the shell command `echo helm-test` and tell me its output. Do nothing else.',
    answer: (method, p) => (method === 'item/commandExecution/requestApproval' ? { decision: 'accept' } : { decision: 'decline' }),
  },
  decline: {
    approvalPolicy: 'untrusted',
    prompt: 'Run the shell command `echo helm-test` and tell me its output. If it is declined, say so in one line.',
    answer: () => ({ decision: 'decline' }),
  },
  edit: {
    approvalPolicy: 'on-request', sandbox: 'read-only',
    prompt: 'Create a file named helm-note.txt containing the single line "hi". Then say done.',
    answer: (method) => (method === 'item/fileChange/requestApproval' ? { decision: 'accept' } : { decision: 'accept' }),
  },
  interrupt: {
    interrupt: true,
    prompt: 'Write the numbers from 1 to 300, one per line, with no other text.',
    answer: () => ({ decision: 'decline' }),
  },
};

// -------------------------------------------------------------------- main

const [engine, only] = process.argv.slice(2);
const table = engine === 'claude' ? CLAUDE_CASES : engine === 'codex' ? CODEX_CASES : null;
if (!table) { console.error('usage: record-driver.mjs <claude|codex> [case]'); process.exit(2); }
const run = engine === 'claude' ? claudeCase : codexCase;
const CLAUDE = engine === 'claude' ? launcher('claude') : null;
const CODEX = engine === 'codex' ? launcher('codex') : null;
for (const [name, c] of Object.entries(table)) {
  if (only && only !== name) continue;
  await run(name, c);
}
