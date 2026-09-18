import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Terminals outliving the daemon.
//
// The shell belongs to a separate host process, so restarting helm - which is
// what an upgrade does - must leave a running command running and its
// scrollback intact. That is the whole reason the host exists, so it is worth
// testing against a real shell rather than a stub.
const dir = mkdtempSync(join(tmpdir(), 'helm-term-host-'));
process.env.HELM_DIR = dir;
process.env.HELM_NO_SERVICE = '1';
// systemd-run would put the host in a transient unit that outlives the test
// run; here the plain detached child is what we want.
process.env.HELM_NO_SYSTEMD_RUN = '1';

const { TerminalHost, SOCKET_PATH } = await import('../packages/connect/src/terminals.js');
const { loadPty } = await import('../packages/connect/src/pty.js');

const opts = { skip: (await loadPty()) ? false : 'no pty addon built for this Node' };

async function until(fn, ms = 8000) {
  const stop = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > stop) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('a terminal survives the daemon that started it', opts, async (t) => {
  // The daemon's first life.
  const first = new TerminalHost();
  t.after(() => first.detach());

  assert.equal(await first.ensure(), true, 'a host should start on demand');
  assert.ok(existsSync(SOCKET_PATH), 'the host should be listening on its socket');

  const seen = [];
  first.on('data', (d) => seen.push(d.text));
  await first.open('t1', { cwd: dir });
  await first.view('t1', { cols: 100, rows: 30 });

  // Something long-running: the kind of thing losing would actually hurt.
  await first.write('t1', 'for i in 1 2 3 4 5 6 7 8 9; do echo tick-$i; sleep 1; done\r');
  await until(() => seen.join('').includes('tick-1'));

  // The daemon goes away - an upgrade, a crash, `systemctl restart`.
  first.detach();
  await new Promise((r) => setTimeout(r, 300));

  // Its replacement finds the terminal still there.
  const second = new TerminalHost();
  assert.equal(await second.ensure(), true);
  assert.deepEqual(second.list(), ['t1'], 'the terminal should have outlived the first daemon');

  const replay = await second.view('t1', { cols: 100, rows: 30 });
  assert.match(replay, /tick-1/, 'the scrollback should come back with it');

  // And the loop is still counting, which is the part that matters.
  const later = [];
  second.on('data', (d) => later.push(d.text));
  await until(() => later.join('').includes('tick-'));

  await second.close('t1');
  assert.equal(second.has('t1'), false);
  second.detach();
});

test('a stale socket does not stop a new host from starting', opts, async (t) => {
  const { writeFileSync, unlinkSync } = await import('node:fs');
  const host = new TerminalHost();
  t.after(() => host.detach());

  // What a killed host leaves behind: something at that path that nothing is
  // listening on. Connecting to it fails, and until it is removed no new host
  // can bind there either - which is how a machine ends up with no terminals
  // at all until someone deletes a file by hand.
  try { unlinkSync(SOCKET_PATH); } catch { /* nothing there */ }
  writeFileSync(SOCKET_PATH, '');
  assert.equal(await host.ensure(), true, 'the stale socket should be cleared and a host started');
  await host.open('t2', { cwd: dir });
  assert.equal(host.has('t2'), true);
  await host.close('t2');
});

// Leave nothing running: the host outlives this process by design.
test.after(async () => {
  const last = new TerminalHost();
  if (await last.ensure({ spawn: false }).catch(() => false)) {
    await last.shutdown();
  }
  rmSync(dir, { recursive: true, force: true });
});
