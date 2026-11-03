import './automation-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Schedules } from '../packages/connect/src/schedules.js';
import { runScheduleCommand, describeTrigger } from '../packages/connect/src/schedule-cli.js';

const { Daemon } = await import('../packages/connect/src/agent.js');

/** Two machines. Each answers through the daemon's real RPC switch and its own saved schedules. */
function fixture(t) {
  const dirs = [];
  const machine = (id, name) => {
    const directory = mkdtempSync(join(tmpdir(), 'helm-schedule-cli-')); dirs.push(directory);
    const chat = { id: `chat-${id}`, driver: 'claude' };
    const sessions = { get(sid) { if (sid !== chat.id) throw new Error('missing session'); return chat; }, canReturnTask: () => true, async input() {} };
    return { id, name, chat, schedules: new Schedules({ sessions, directory }) };
  };
  t.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
  const laptop = machine('aa11', 'Laptop'), vm = machine('bb22', 'VM');
  const net = { self: 'aa11', machines: { aa11: { id: 'aa11', name: 'Laptop' }, bb22: { id: 'bb22', name: 'VM' }, cc33: { id: 'cc33', name: 'Off' } } };
  const byId = { aa11: laptop, bb22: vm };
  const calls = [];
  const rpc = async (env, method, params) => {
    calls.push({ env, method, params });
    if (!byId[env]) throw new Error('machine is offline');
    return Daemon.prototype.dispatch.call({ schedules: byId[env].schedules }, method, params);
  };
  const lines = [];
  const run = (...args) => runScheduleCommand(args, { net, rpc, machineId: (n) => Object.values(net.machines).find((m) => m.name === n).id, write: (l) => lines.push(l) });
  return { laptop, vm, run, lines, calls, text: () => lines.join('\n') };
}

test('helm schedule lists every machine and names one it cannot reach', async (t) => {
  const f = fixture(t);
  const review = f.laptop.schedules.save({ sessionId: f.laptop.chat.id, name: 'Review', prompt: 'Review changes', intervalMinutes: 120 }).schedule;
  f.vm.schedules.save({ sessionId: f.vm.chat.id, name: 'Hook', prompt: '{{body}}', type: 'webhook' });
  await f.run('list');
  assert.match(f.text(), /Laptop\n {4}[a-f0-9]{8} {2}Review {2}every 2 hours {2}next run: /);
  assert.match(f.text(), /VM\n {4}[a-f0-9]{8} {2}Hook {2}when its webhook gets a POST {2}waits for a POST/);
  assert.match(f.text(), /Could not reach: Off\./);
  f.lines.length = 0;
  await f.run('list', '--on', 'Laptop', '--json');
  const rows = JSON.parse(f.lines[0]);
  assert.deepEqual(rows.map((r) => r.machine), ['Laptop']);
  assert.equal(rows[0].schedules[0].id, review.id);
});

test('helm schedule show hides the webhook password unless asked', async (t) => {
  const f = fixture(t);
  const hook = f.vm.schedules.save({ sessionId: f.vm.chat.id, name: 'Hook', prompt: 'Look at {{body}}', type: 'webhook', hmacSecret: 'a-long-enough-secret' }).schedule;
  const token = hook.webhook.path.split('/').at(-1);
  await f.run('show', hook.id.slice(0, 6));
  assert.match(f.text(), /Hook {2}\([a-f0-9]{16} on VM\)/);
  assert.match(f.text(), /Signature: {2}required/);
  assert.match(f.text(), /Task:\n {4}Look at \{\{body\}\}/);
  assert.ok(!f.text().includes(token));
  await f.run('show', hook.id, '--json');
  assert.ok(!f.lines.at(-1).includes(token));
  await f.run('list', '--json');
  assert.ok(!f.lines.at(-1).includes(token));
  f.lines.length = 0;
  await f.run('show', hook.id, '--link');
  assert.ok(f.text().includes(token));
});

test('helm schedule pause works for a chat that is gone, and resume checks the chat', async (t) => {
  const f = fixture(t);
  const review = f.laptop.schedules.save({ sessionId: f.laptop.chat.id, name: 'Review', prompt: 'Review', intervalMinutes: 5 }).schedule;
  f.laptop.chat.archived = true;
  await f.run('pause', review.id.slice(0, 8));
  assert.equal(f.laptop.schedules.list().schedules[0].enabled, false);
  assert.match(f.text(), /Paused "Review" on Laptop\. It does not run until you resume it\.\n {2}Resume it with: helm schedule resume [a-f0-9]{8}/);
  await assert.rejects(f.run('resume', review.id), /active Helm thread/);
  delete f.laptop.chat.archived;
  await f.run('resume', review.id);
  assert.equal(f.laptop.schedules.list().schedules[0].enabled, true);
  assert.match(f.text(), /Resumed "Review" on Laptop\. It runs next: /);
});

test('helm schedule remove deletes for good and says what stops', async (t) => {
  const f = fixture(t);
  const hook = f.vm.schedules.save({ sessionId: f.vm.chat.id, name: 'Hook', prompt: '{{body}}', type: 'webhook' }).schedule;
  await f.run('remove', hook.id);
  assert.equal(f.vm.schedules.list().schedules.length, 0);
  assert.match(f.text(), /Removed "Hook" from VM for good\. It does not run again, and Helm cannot bring it back\./);
  assert.match(f.text(), /webhook link stops for good/);
  await assert.rejects(f.run('remove', hook.id), /No schedule ".*" found\. Could not reach: Off\./);
});

test('helm schedule refuses a short or shared id instead of guessing', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run('pause'), /Give the schedule id/);
  await assert.rejects(f.run('pause', 'abc'), /Give the schedule id/);
  const a = f.laptop.schedules.save({ sessionId: f.laptop.chat.id, prompt: 'A', intervalMinutes: 5 }).schedule;
  const b = f.vm.schedules.save({ sessionId: f.vm.chat.id, prompt: 'B', intervalMinutes: 5 }).schedule;
  // Give both the same start, as two machines could.
  f.vm.schedules.records[0].id = `${a.id.slice(0, 4)}${b.id.slice(4)}`;
  await assert.rejects(f.run('pause', a.id.slice(0, 4)), /matches 2 schedules/);
  assert.ok(!f.calls.some((c) => c.method === 'schedule.save'));
  await assert.rejects(f.run('stop', a.id), /helm schedule list \| show/);
});

test('trigger words cover each kind of schedule', () => {
  assert.equal(describeTrigger({ type: 'interval', intervalMinutes: 45 }), 'every 45 min');
  assert.equal(describeTrigger({ type: 'interval', intervalMinutes: 2880 }), 'every 2 days');
  assert.equal(describeTrigger({ type: 'fixed_time', timeOfDay: '09:00', timeZone: 'Europe/London', weekdays: [5, 1] }), 'daily at 09:00 (Europe/London) on Mon, Fri');
});
