import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'helm-index-save-'));
for (const [key, name] of Object.entries({ HELM_DIR: 'helm', HELM_DB: 'db.sqlite', HELM_SSH_DIR: 'ssh', HELM_NATIVE_SOCKET: 'native.sock', HELM_TERMINALS_SOCKET: 'terminals.sock', HELM_PROCS_SOCKET: 'procs.sock' })) process.env[key] = join(root, name);
process.env.HELM_NO_SERVICE = '1';
mkdirSync(process.env.HELM_DIR);
const { Sessions } = await import('../packages/connect/src/sessions.js');
test.after(() => rmSync(root, { recursive: true, force: true }));

const file = join(process.env.HELM_DIR, 'sessions.json');
const saved = () => JSON.parse(readFileSync(file, 'utf8')).sessions;
class Host extends EventEmitter { nativeSessions() { return []; } has() { return false; } async write() {} async view() { return ''; } unview() {} detach() {} }
const open = () => new Sessions(new EventEmitter(), { nativeHost: new Host(), nativeDiscovery: false });

test('a burst of changes is written once, compact, and nothing is lost', async () => {
  writeFileSync(file, JSON.stringify({ version: 1, sessions: [{ id: 'a', engine: 'claude', cwd: root, status: 'idle', createdAt: 1, updatedAt: 1 }] }, null, 2));
  const before = statSync(file).mtimeMs;
  const sessions = open();
  for (let i = 0; i < 50; i++) sessions.markSeen('a');
  assert.equal(statSync(file).mtimeMs, before, 'the changes wait for one write');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(saved()[0].seenAt > 1, 'the write comes by itself soon after');
  assert.ok(!readFileSync(file, 'utf8').includes('\n'), 'no indentation');

  // A second copy in the same process - a restart in a test, say - reads
  // what the first one has not written yet.
  const at = sessions.markSeen('a').seenAt;
  const second = open();
  assert.equal(second.get('a').seenAt, at);
  await second.stop();

  // Stopping writes what is waiting.
  sessions.setNotifyDone('a', false);
  await sessions.stop();
  assert.equal(saved()[0].notifyDone, false);
});
