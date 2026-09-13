import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The terminal used to be polled from the phone: one runtime read plus two
// trips through the hub per redraw. Now the daemon watches the pane itself and
// pushes only what changed. This checks the push: an append arrives as a
// delta, a redraw arrives as a reset, and nothing is sent when nothing moved.
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-stream-'));

class StubRuntime extends EventEmitter {
  screen = 'line one\n';
  reads = 0;
  async read() { this.reads++; return { text: this.screen }; }
  watch() {}
  async listLive() { return new Map(); }
}

test('an attached session pushes screen deltas, resets on redraw, and is quiet when idle', async (t) => {
  t.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
  const { Sessions } = await import('../packages/connect/src/sessions.js');
  const rt = new StubRuntime();
  const sessions = new Sessions(rt);
  const id = 'pane:w1:p1';
  const pushed = [];
  sessions.on('data', (d) => pushed.push(d));

  const first = await sessions.attach(id, { lines: 50, ansi: true });
  assert.equal(first.text, 'line one\n');

  // Idle: several polls, no pushes.
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(pushed.length, 0);
  assert.ok(rt.reads >= 2, 'the daemon should be polling the runtime');

  rt.screen = 'line one\nline two\n';
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(pushed.at(-1), { id, text: 'line two\n', reset: false });

  rt.screen = 'a whole new screen\n';
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(pushed.at(-1), { id, text: 'a whole new screen\n', reset: true });

  sessions.detach(id);
  const reads = rt.reads;
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(rt.reads, reads, 'detaching must stop the polling');
});
