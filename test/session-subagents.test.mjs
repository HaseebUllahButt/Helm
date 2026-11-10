import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionSubagents } from '../packages/connect/src/session-subagents.js';

test('a removed chat releases helper records and ignores its pending read', async () => {
  const session = { id: 'gone', spawned: true, engine: 'test' };
  let updates = 0;
  const core = { index: new Map([[session.id, session]]),
    delegation: { refreshTeam() { updates++; } } };
  const sessions = { log() {}, events: { derive: () => [{ id: 'helper', status: 'working' }] } };
  const helpers = new SessionSubagents(sessions, core);
  helpers.agentTools.set(session.id, new Map([['helper', new Set(['tool'])]]));
  const reading = helpers.refreshNative(session);
  assert.equal(helpers.native.size, 1);
  helpers.forget(session.id);
  core.index.delete(session.id);
  await reading;
  assert.equal(helpers.native.size, 0);
  assert.equal(helpers.agentTools.size, 0);
  assert.equal(updates, 0, 'a late read cannot publish the removed chat');
});

test('legacy native messages have no receipt and a repeated request sends twice', async () => {
  let calls=0;
  const session={id:'parent',engine:'codex',driver:'codex',nativeCards:[{id:'helper',canMessage:true}]};
  const sessions={get:()=>session};
  const core={drivers:new Map([['parent',{messageSubagent:async()=>{calls++;}}]]),save(){}};
  const helpers=new SessionSubagents(sessions,core);
  helpers.refreshNative=async()=>{};
  await helpers.messageNative('parent','helper','look again');
  await helpers.messageNative('parent','helper','look again');
  assert.equal(calls,2);
});

test('a Claude helper whose own record ended long ago drops an old "working" report', async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'helm-ended-helper-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'chat', 'subagents');
  mkdirSync(dir, { recursive: true });
  const write = (id, tool, records, ageMs) => {
    writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify({ description: id, toolUseId: tool }));
    const file = join(dir, `agent-${id}.jsonl`);
    writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const when = (Date.now() - ageMs) / 1000;
    utimesSync(file, when, when);
  };
  const ask = { type: 'user', timestamp: new Date().toISOString(), message: { content: 'look' } };
  const reply = { type: 'assistant', message: { id: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } };
  const tool = { type: 'assistant', message: { id: 'm2', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } };
  write('ended', 'toolu_ended', [ask, reply], 5 * 60_000);
  write('fresh', 'toolu_fresh', [ask, reply], 0);
  write('busy', 'toolu_busy', [ask, tool], 5 * 60_000);
  const session = { id: 'parent', engine: 'claude', transcript: join(root, 'chat.jsonl'),
    nativeAgents: { toolu_ended: 'working', toolu_woken: 'working', toolu_fresh: 'working', toolu_busy: 'working' } };
  let saves = 0;
  const core = { index: new Map([[session.id, session]]), save() { saves++; }, delegation: { refreshTeam() {} } };
  const helpers = new SessionSubagents({ log() {}, events: { derive: () => [] } }, core);
  // SendMessage woke the ended helper once under its own call.
  helpers.agentTools.set(session.id, new Map([['ended', new Set(['toolu_woken'])]]));
  await helpers.refreshNative(session);
  assert.deepEqual(session.nativeAgents, { toolu_fresh: 'working', toolu_busy: 'working' },
    'a just-ended helper may be woken again, and a quiet tool call is still running');
  assert.equal(saves, 1);
});
