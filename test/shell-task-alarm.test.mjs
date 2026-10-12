import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-shell-alarm-'));
process.env.HELM_NO_SERVICE = '1';
process.env.HELM_DB = join(process.env.HELM_DIR, 'helm.db');
process.env.HELM_SSH_DIR = join(process.env.HELM_DIR, 'ssh');
process.env.HELM_TERMINALS_SOCKET = join(process.env.HELM_DIR, 'terminals.sock');
process.env.HELM_PROCS_SOCKET = join(process.env.HELM_DIR, 'procs.sock');
process.env.HELM_NATIVE_SOCKET = join(process.env.HELM_DIR, 'native.sock');
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));

test('a crashed background command saved by an older daemon is no longer a failed child task', async (t) => {
  const dir = process.env.HELM_DIR;
  mkdirSync(join(dir, 'events'), { recursive: true });
  // What older daemons saved: Claude's background Bash counted as a native
  // helper, its failure kept on the thread as "1 child tasks failed".
  writeFileSync(join(dir, 'sessions.json'), JSON.stringify({ version: 1, sessions: [{
    id: 'parent1', title: 'scrape', engine: 'claude', cwd: '/tmp', status: 'idle',
    nativeAgents: { toolu_bash: 'error', toolu_agent: 'error' },
    team: { working: 0, blocked: 0, failed: 2 },
  }] }));
  writeFileSync(join(dir, 'events', 'parent1.jsonl'), [
    { seq: 1, at: 1, type: 'item.start', id: 'toolu_bash', kind: 'tool', name: 'Bash', turnId: 't1', input: {} },
    { seq: 2, at: 2, type: 'item.start', id: 'toolu_agent', kind: 'subagent', name: 'Task', turnId: 't1', input: {} },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const sessions = new Sessions(new EventEmitter(), { makeDriver: () => { throw Error('history must not launch'); } });
  t.after(() => sessions.stop());
  const s = sessions.get('parent1');
  assert.deepEqual(s.nativeAgents, { toolu_agent: 'error' }, 'a real helper keeps its failure');
  assert.equal(s.team.failed, 1);
});

test('saved quick-chat artifact subscriptions are repaired without ending actual background helpers', async (t) => {
  const dir = process.env.HELM_DIR;
  writeFileSync(join(dir, 'sessions.json'), JSON.stringify({ version: 1, sessions: [{
    id: 'quick1', title: 'chart', engine: 'claude', quick: true, cwd: '/tmp', status: 'idle',
    nativeAgents: { artifact: 'working', monitor: 'working', typed: 'working', helper: 'working', approval: 'blocked' },
    team: { working: 4, blocked: 1, failed: 0 },
  }, {
    id: 'quick2', title: 'finished chart', engine: 'claude', quick: true, cwd: '/tmp', status: 'idle',
    nativeAgents: { artifact: 'working' }, team: { working: 1, blocked: 0, failed: 0 },
  }] }));
  writeFileSync(join(dir, 'events', 'quick1.jsonl'), [
    { type: 'item.start', id: 'artifact', kind: 'tool', name: 'Artifact' },
    { type: 'item.update', id: 'artifact', agent: { id: 'watch1', status: 'running' } },
    { type: 'item.start', id: 'monitor', kind: 'tool', name: 'Monitor' },
    { type: 'item.update', id: 'typed', agent: { id: 'watch2', status: 'running', type: 'monitor_ws' } },
    { type: 'item.start', id: 'helper', kind: 'subagent', name: 'Agent' },
    { type: 'item.start', id: 'approval', kind: 'subagent', name: 'Task' },
  ].map((e, i) => JSON.stringify({ seq: i + 1, at: i + 1, ...e })).join('\n') + '\n');
  writeFileSync(join(dir, 'events', 'quick2.jsonl'), JSON.stringify({
    seq: 1, at: 1, type: 'item.start', id: 'artifact', kind: 'tool', name: 'Artifact',
  }) + '\n');
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const sessions = new Sessions(new EventEmitter(), { makeDriver: () => { throw Error('history must not launch'); } });
  t.after(() => sessions.stop());
  const s = sessions.get('quick1');
  assert.equal(s.status, 'idle');
  assert.deepEqual(s.nativeAgents, { helper: 'working', approval: 'blocked' });
  assert.deepEqual(s.team, { working: 1, blocked: 1, failed: 0 });
  assert.deepEqual(sessions.get('quick2').team, { working: 0, blocked: 0, failed: 0 });
  assert.equal(sessions.hasActiveDelegations('quick2'), false);
  const saved = JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8')).sessions[0];
  assert.deepEqual(saved.nativeAgents, s.nativeAgents, 'the repair survives another restart');
});
