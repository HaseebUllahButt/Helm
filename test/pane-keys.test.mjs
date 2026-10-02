import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// When a machine has no pty, a terminal is a herdr pane. The quick keys used
// to reach it as key *names* ("Escape", "C-c"), which herdr does not share,
// so most of them were silently dropped. They now go as the bytes a keyboard
// sends, down the same road as typing.
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-pane-keys-'));
process.env.HELM_NO_SERVICE = '1';
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));

writeFileSync(join(process.env.HELM_DIR, 'sessions.json'), JSON.stringify({
  version: 1,
  sessions: [{ id: 'sh', paneId: 'p1', workspaceId: 'w1', engine: 'shell', status: 'shell', cwd: '/tmp', title: 'Terminal 1', updatedAt: 1 }],
}));

class Pane extends EventEmitter {
  sent = [];
  async read() { return { text: '' }; }
  watch() {}
  async listLive() { return new Map([['p1', { id: 'p1', engine: 'shell', status: 'shell', cwd: '/tmp' }]]); }
  sendText(handle, text) { this.sent.push(['text', handle.paneId, text]); return { ok: true }; }
  sendKeys(handle, keys) { this.sent.push(['keys', handle.paneId, keys]); return { ok: true }; }
}

test('quick keys reach a pane as keyboard bytes, not names', async () => {
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const runtime = new Pane();
  const sessions = new Sessions(runtime, {});
  await sessions.list();
  await sessions.keys('sh', ['Escape', 'Up', 'C-c', 'Enter', 'Tab', 'PageDown']);
  assert.deepEqual(runtime.sent, [['text', 'p1', '\x1b\x1b[A\x03\r\t\x1b[6~']]);
});
