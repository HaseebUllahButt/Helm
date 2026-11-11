import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// An agent that stops without Helm asking leaves a record: on 2026-11-10
// three Claude chats got a SIGTERM 20 s after a restart and nothing said
// who sent it. The process host writes the line; doctor and the lost-helper
// message read it back.
const dir = mkdtempSync(join(tmpdir(), 'helm-agent-stops-'));
process.env.HELM_DIR = dir;
delete process.env.HELM_TERMINALS_SOCKET;
delete process.env.HELM_PROCS_SOCKET;
process.env.HELM_NO_SERVICE = '1';
process.env.HELM_NO_SYSTEMD_RUN = '1';

const { recordStop, lastStop, describeStop, strayStops, STOPS_FILE } = await import('../packages/connect/src/agent-stops.js');
const { TerminalHost, PROC_SOCKET_PATH } = await import('../packages/connect/src/terminals.js');
const { diagnose } = await import('../packages/connect/src/doctor.js');

test.after(() => rmSync(dir, { recursive: true, force: true }));

async function until(fn, ms = 10_000) {
  const stop = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > stop) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('a stop is saved privately and read back in plain words', () => {
  const file = join(dir, 'unit.jsonl');
  const at = Date.parse('2026-11-10T17:34:23Z');
  recordStop({ at, id: 'abc', code: 143, signal: null, askedByHelm: false, daemonConnected: true, programs: [] }, file);
  recordStop({ at: at + 1000, id: 'other', code: 1, signal: null, askedByHelm: true, daemonConnected: true }, file);
  assert.equal(statSync(file).mode & 0o777, 0o600, 'command lines can hold secrets');
  const e = lastStop('abc', file);
  assert.equal(e.code, 143);
  assert.match(describeStop(e), /^Its process stopped at \d+ Nov \d\d:\d\d:\d\d with code 143\. Helm did not ask it to stop\.$/);
  assert.match(describeStop({ ...e, daemonConnected: false }), /Helm was restarting\.$/);
  assert.deepEqual(strayStops(0, file).map((s) => s.id), ['abc'], 'a stop Helm asked for is not a mystery');
  assert.equal(lastStop('missing', file), null);
});

test('the process host records who stopped an agent', async (t) => {
  const host = new TerminalHost({ socketPath: PROC_SOCKET_PATH, unit: 'helm-procs' });
  t.after(async () => { await host.shutdown?.().catch(() => {}); host.detach(); });
  // Agent processes need no terminal add-on; a host without one still holds them.
  await host.ensure();

  // Stopped from outside, as on 2026-11-10.
  const outside = await host.openProc('stray', { cmd: '/bin/sh', args: ['-c', 'sleep 30'], cwd: dir, env: {} });
  process.kill(outside.pid, 'SIGTERM');
  const stray = await until(() => lastStop('stray'));
  assert.equal(stray.askedByHelm, false);
  assert.equal(stray.signal, 'SIGTERM');
  assert.equal(stray.daemonConnected, true);
  assert.ok(Array.isArray(stray.programs));

  // Stopped by Helm itself.
  await host.openProc('asked', { cmd: '/bin/sh', args: ['-c', 'sleep 30'], cwd: dir, env: {} });
  host.procPipe('asked').kill('SIGTERM');
  const asked = await until(() => lastStop('asked'));
  assert.equal(asked.askedByHelm, true);

  // A clean exit is not recorded.
  await host.openProc('clean', { cmd: '/bin/sh', args: ['-c', 'exit 0'], cwd: dir, env: {} });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(lastStop('clean'), null);
});

test('doctor names stops Helm did not ask for', async () => {
  const report = await diagnose({
    network: async () => null, service: async () => ({ state: 'manual' }), web: () => '/x',
    stops: () => [{ at: Date.now(), id: 'abc', code: 143, askedByHelm: false, daemonConnected: false }],
  });
  const c = report.checks.find((x) => x.id === 'agent-stops' || /agent process/.test(x.message));
  assert.equal(c.state, 'warning');
  assert.match(c.message, /^1 agent process stopped in the last 7 days without Helm asking\. Newest: .*Helm was restarting\.$/);
  assert.ok(c.action.includes(STOPS_FILE()));
  const calm = await diagnose({ network: async () => null, service: async () => ({ state: 'manual' }), web: () => '/x', stops: () => [] });
  assert.ok(calm.checks.some((x) => x.state === 'ok' && /No agent process stopped/.test(x.message)));
});
