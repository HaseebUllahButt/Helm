import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'helm-native-hosts-'));
process.env.HELM_DIR = join(root, 'helm');
process.env.HELM_NO_SYSTEMD_RUN = '1';
const { TerminalHost, NativeHosts } = await import('../packages/connect/src/terminals.js');
const { loadPty } = await import('../packages/connect/src/pty.js');
const oldPath = join(root, 'old.sock'), newPath = join(root, 'new.sock');

async function until(fn, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await fn()) return; await new Promise((r) => setTimeout(r, 30)); }
  throw new Error('timed out');
}

test('an update leaves running CLIs in the old host and opens new ones in the new host', { skip: !(await loadPty()) && 'no pty' }, async (t) => {
  // Before the update: a CLI running in the old version's host.
  const old = new TerminalHost({ socketPath: oldPath });
  await old.ensure();
  await old.open('running', { cmd: '/bin/sh', args: ['-c', 'read x; echo GOT=$x; sleep 0.2'], cols: 80, rows: 24 });
  old.detach();

  const hosts = new NativeHosts({ current: new TerminalHost({ socketPath: newPath }), olderPaths: () => [oldPath] });
  t.after(async () => { await hosts.shutdown(); const o = new TerminalHost({ socketPath: oldPath }); if (await o.ensure({ spawn: false })) await o.shutdown(); rmSync(root, { recursive: true, force: true }); });
  assert.equal(await hosts.ensure(), true);
  assert.equal(hosts.has('running'), true, 'still reachable after the update');
  await hosts.open('fresh', { cmd: '/bin/sh', args: ['-c', 'sleep 30'], cols: 80, rows: 24 });
  const current = new TerminalHost({ socketPath: newPath });
  await current.ensure({ spawn: false });
  assert.deepEqual(current.list(), ['fresh'], 'new CLIs open in the new host');
  current.detach();

  let out = '';
  hosts.on('data', (d) => { if (d.id === 'running') out += d.text; });
  await hosts.view('running', { cols: 80, rows: 24 });
  await hosts.write('running', 'hello\r');
  await until(() => out.includes('GOT=hello'));
  // Its last CLI gone, the old host is let go so it can exit.
  await until(() => !hosts.has('running'));
  assert.deepEqual(hosts.list(), ['fresh']);
});
