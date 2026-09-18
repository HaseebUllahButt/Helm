import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// herdr owns the processes behind pane-backed sessions. If it no longer lists
// a pane, the agent is gone - whatever that session was last seen doing.
// Trusting the remembered status instead is what left a machine that had
// restarted mid-turn reporting "needs you" for a prompt nobody could answer,
// permanently at the top of the phone's list.
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-stale-'));
process.env.HELM_NO_SERVICE = '1';

writeFileSync(join(process.env.HELM_DIR, 'sessions.json'), JSON.stringify({
  version: 1,
  sessions: [
    { id: 'gone', paneId: 'p1', engine: 'codex', status: 'working', cwd: '/tmp/a', title: 'Codex', updatedAt: 1 },
    { id: 'asking', paneId: 'p2', engine: 'claude', status: 'blocked', cwd: '/tmp/b', title: 'Claude', updatedAt: 2 },
    { id: 'here', paneId: 'p3', engine: 'codex', status: 'working', cwd: '/tmp/c', title: 'Codex', updatedAt: 3 },
    { id: 'sh', paneId: 'p4', engine: 'shell', status: 'shell', cwd: '/tmp/d', title: 'shell', updatedAt: 4 },
  ],
}));

/** Only p3 is still running. */
class OnePane extends EventEmitter {
  async read() { return { text: '' }; }
  watch() {}
  async listLive() {
    return new Map([['p3', { id: 'p3', engine: 'codex', status: 'working', cwd: '/tmp/c' }]]);
  }
}

test('a pane-backed session whose pane is gone reads exited, not what it was last doing', async () => {
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const list = await new Sessions(new OnePane(), {}).list();
  const by = Object.fromEntries(list.map((x) => [x.id, x]));

  assert.equal(by.gone.status, 'exited');
  assert.equal(by.gone.alive, false);
  assert.equal(by.asking.status, 'exited', 'a prompt nobody can answer is not "blocked"');
  assert.equal(by.asking.alive, false);
  assert.equal(by.sh.status, 'exited');

  // The one herdr still has is untouched.
  assert.equal(by.here.status, 'working');
  assert.equal(by.here.alive, true);

  // And nothing dead outranks it: "needs you" has to mean something.
  assert.equal(list[0].id, 'here');
});
