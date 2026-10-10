import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-shell-alarm-'));
process.env.HELM_NO_SERVICE = '1';
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));

test('a crashed background command saved by an older daemon is no longer a failed child task', async () => {
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
  const s = sessions.get('parent1');
  assert.deepEqual(s.nativeAgents, { toolu_agent: 'error' }, 'a real helper keeps its failure');
  assert.equal(s.team.failed, 1);
});
