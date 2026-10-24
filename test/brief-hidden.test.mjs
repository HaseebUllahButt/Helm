import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-brief-'));
process.env.HELM_NO_SERVICE = '1';
process.env.HELM_SSH_DIR = join(process.env.HELM_DIR, 'ssh');
process.env.HELM_DB = join(process.env.HELM_DIR, 'hub.sqlite');
process.env.HELM_PROCS_SOCKET = join(process.env.HELM_DIR, 'procs.sock');
process.env.HELM_TERMINALS_SOCKET = join(process.env.HELM_DIR, 'terminals.sock');
process.env.HELM_NATIVE_SOCKET = join(process.env.HELM_DIR, 'native.sock');
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({ version: 1, profiles: [
  { id: 'oc2', label: 'OpenCode 2', engine: 'opencode2', cmd: process.execPath, source: 'custom' },
] }));
const { Sessions } = await import('../packages/connect/src/sessions.js');
const { WRITING_REMINDER, stripBrief } = await import('../packages/protocol/brief.js');

// A CLI with no standing-instructions channel that echoes what it is sent,
// the way an ACP agent replays the prompt as the turn's opening line.
class EchoDriver extends EventEmitter {
  constructor(opts) { super(); Object.assign(this, opts); this.engineSessionId = randomUUID(); this.status = 'idle'; this.sent = []; }
  async start() {}
  push(type, extra = {}) { if (type === 'status') this.status = extra.status; this.emit('event', { type, ...extra }); }
  async send(text) {
    this.sent.push(text);
    this.push('status', { status: 'working' });
    this.push('turn.start', { turnId: `t${this.sent.length}`, text });
    this.push('turn.done', { turnId: `t${this.sent.length}`, status: 'ok' });
    this.push('status', { status: 'idle' });
  }
  async kill() { this.push('status', { status: 'exited' }); }
}

test('Helm\'s brief reaches a CLI without an instructions channel, but never shows as the owner\'s words', async (t) => {
  const drivers = new Map();
  const runtime = new EventEmitter();
  runtime.listLive = async () => new Map();
  const sessions = new Sessions(runtime, { makeDriver: (_engine, opts) => { const d = new EchoDriver(opts); drivers.set(opts.env.HELM_SESSION_ID, d); return d; } });
  t.after(() => sessions.stop());
  sessions.delegationBrief = () => '[Helm: you are running on Laptop.]\n[Helm: use helpers.]';
  const chat = await sessions.start({ cwd: process.env.HELM_DIR, profileId: 'oc2' });
  const settle = () => new Promise((r) => setTimeout(r, 50));

  await sessions.input(chat.id, 'Fix the login form');
  await settle();
  const d = drivers.get(chat.id);
  assert.equal(d.sent[0], `<helm_instructions>\n[Helm: you are running on Laptop.]\n[Helm: use helpers.]\n</helm_instructions>\n\n<user_request>\nFix the login form\n</user_request>\n\n${WRITING_REMINDER}`);
  // The owner's bubble is what they typed; the CLI's echo is matched to it.
  const events = sessions.history(chat.id, { tail: 100 }).events;
  const starts = events.filter((e) => e.type === 'turn.start');
  assert.equal(starts[0].text, 'Fix the login form');
  assert.ok(starts.slice(1).every((e) => e.inputId === starts[0].turnId), 'the echo is claimed by the owner\'s message');

  // Told once per CLI conversation; the writing reminder rides on every message.
  await sessions.input(chat.id, 'Now the tests');
  await settle();
  assert.equal(d.sent[1], `Now the tests\n\n${WRITING_REMINDER}`);
  assert.equal(stripBrief(d.sent[0]), 'Fix the login form');
  assert.equal(stripBrief(d.sent[1]), 'Now the tests');
  // A conversation the CLI had to start over has not been told.
  d.engineSessionId = randomUUID();
  await sessions.input(chat.id, 'And the docs');
  await settle();
  assert.match(d.sent[2], /^<helm_instructions>[\s\S]*<user_request>\nAnd the docs\n<\/user_request>\n\n<helm_reminder>[\s\S]*<\/helm_reminder>$/);
  await sessions.input(chat.id, '/status');
  await settle();
  assert.equal(d.sent.at(-1), '/status');
});
