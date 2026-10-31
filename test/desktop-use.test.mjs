import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-desktop-use-'));
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));
const { DesktopManager, createDesktopRoutes, runTool, launchHints, desktopTool } = await import('../packages/connect/src/desktop-use.js');
const { runDesktopCommand } = await import('../packages/connect/src/desktop-use-cli.js');

// A stand-in for agent-desktop: it writes each call to a log and answers like the real program.
function fakeTool(dir, reply = 'reply') {
  const log = join(dir, 'calls.jsonl'), path = join(dir, 'agent-desktop');
  writeFileSync(path, `#!${process.execPath}
const fs = require('fs'); const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, home: process.env.AGENT_DESKTOP_HOME }) + '\\n');
const replies = fs.existsSync(${JSON.stringify(join(dir, reply))}) ? JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, reply))}, 'utf8')) : {};
const answer = replies[args[0]] || { version: '2.5', ok: true, command: args[0], data: {} };
process.stdout.write(JSON.stringify(answer) + '\\n'); process.exit(answer.ok ? 0 : 1);
`);
  chmodSync(path, 0o755);
  return { tool: () => ({ path, env: {} }), calls: () => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)), answer: replies => writeFileSync(join(dir, reply), JSON.stringify(replies)) };
}

function setup(t, opts = {}) {
  const dir = mkdtempSync(join(process.env.HELM_DIR, 'case-'));
  const fake = fakeTool(dir);
  const chats = new Set(['chat-a', 'chat-b']);
  const make = () => new DesktopManager({ directory: join(dir, 'desktop'), session: id => chats.has(id) ? { id } : null, tool: fake.tool, platform: 'linux', ...opts });
  return { dir, fake, chats, make, manager: make() };
}

test('each chat gets its own namespace and the program keeps its state in a private Helm folder', async t => {
  const { fake, manager, dir } = setup(t);
  await manager.look('chat-a', { app: 'gnome-calculator' });
  await manager.run('chat-b', { args: ['click', '@s1:e2'] });
  const [look, click] = fake.calls();
  assert.deepEqual(look.args, ['snapshot', '--app', 'gnome-calculator', '-i', '--compact', '--session', 'helm-chat-a']);
  assert.deepEqual(click.args, ['click', '@s1:e2', '--session', 'helm-chat-b']);
  assert.equal(look.home, join(dir, 'desktop', 'tool'));
  assert.equal(statSync(look.home).mode & 0o777, 0o700);
  await assert.rejects(manager.look('chat-gone', { app: 'x' }), /chat not found/);
});

test('open starts an app so that it shows its controls, and only browsers get the browser switch', async t => {
  const { fake, manager } = setup(t);
  fake.answer({ launch: { ok: true, command: 'launch', data: { app: 'brave', pid: 4242, window: { id: 'w1' } } } });
  await manager.open('chat-a', { app: 'brave-browser', args: ['https://example.com'] });
  await manager.open('chat-a', { app: 'gnome-calculator' });
  const [brave, calc] = fake.calls().map(call => call.args);
  for (const value of ['QT_ACCESSIBILITY=1', 'ACCESSIBILITY_ENABLED=1', 'GNOME_ACCESSIBILITY=1']) assert.ok(calc.includes(value) && brave.includes(value), value);
  assert.ok(brave.includes('--arg=--force-renderer-accessibility'));
  assert.ok(brave.includes('--arg=https://example.com'));
  assert.ok(!calc.includes('--arg=--force-renderer-accessibility'), 'other apps can refuse an option they do not know');
  assert.deepEqual(launchHints('Brave', 'darwin'), []);
});

test('a launch with no window tells the agent what to do next', async t => {
  const { fake, manager } = setup(t);
  fake.answer({ launch: { ok: true, command: 'launch', data: { app: 'brave', pid: 99 } } });
  const reply = await manager.open('chat-a', { app: 'brave' });
  assert.match(reply.helm, /ask the owner, then run helm desktop restart "brave"/);
  assert.match(reply.helm, /helm desktop switch on/);
});

test('a chat closes only the apps it opened, and never a new process that took an old number', async t => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  t.after(() => child.kill('SIGKILL'));
  const { fake, manager, make } = setup(t);
  fake.answer({ launch: { ok: true, command: 'launch', data: { app: 'helm-test-app', pid: child.pid, window: { id: 'w' } } } });
  await manager.open('chat-a', { app: 'helm-test-app' });
  const apps = { ok: true, command: 'list-apps', data: { apps: [{ name: 'helm-test-app', pid: child.pid }, { name: 'brave', pid: 1 }] } };
  fake.answer({ 'list-apps': apps });
  assert.deepEqual((await manager.apps('chat-a')).data.apps.map(app => !!app.openedByThisChat), [true, false]);
  assert.deepEqual((await manager.apps('chat-b')).data.apps.map(app => !!app.openedByThisChat), [false, false]);
  await assert.rejects(manager.close('chat-a', { app: 'brave' }), /This chat did not open brave. Ask the owner/);
  await assert.rejects(manager.close('chat-b', { app: 'helm-test-app' }), /did not open/);

  // A restart of Helm keeps the list. A stale record names a process that is not ours.
  const again = make();
  again.state.chats['chat-b'] = [{ app: 'other', pid: child.pid, stamp: 'not-this-process' }];
  assert.deepEqual(await again.close('chat-b', { app: 'other' }), { ok: true, closed: [] });
  assert.equal(child.exitCode, null);
  const exited = once(child, 'exit');
  assert.deepEqual(await again.close('chat-a', { app: 'helm-test-app' }), { ok: true, closed: [child.pid] });
  assert.deepEqual(await exited, [null, 'SIGTERM']);
  assert.deepEqual(make().opened('chat-a'), []);
});

test('a deleted chat closes its apps; a chat that only stopped keeps them', async t => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  t.after(() => child.kill('SIGKILL'));
  const { fake, manager, chats } = setup(t);
  fake.answer({ launch: { ok: true, command: 'launch', data: { app: 'helm-test-app', pid: child.pid, window: { id: 'w' } } } });
  await manager.open('chat-a', { app: 'helm-test-app' });
  const routes = createDesktopRoutes({ sessions: { get: id => { if (!chats.has(id)) throw new Error('not found'); return { id }; } }, manager });
  routes.sessionChanged({ id: 'chat-a', status: 'exited' });
  assert.equal(manager.opened('chat-a').length, 1, 'a settled chat can come back to its apps');
  const exited = once(child, 'exit');
  chats.delete('chat-a');
  routes.sessionChanged({ id: 'chat-a', status: 'exited' });
  await exited;
  assert.equal(manager.opened('chat-a').length, 0);
});

test('Helm routes its own words and refuses the program commands it replaces', async t => {
  const { manager } = setup(t);
  for (const word of ['launch', 'close-app', 'session']) await assert.rejects(manager.run('chat-a', { args: [word, 'x'] }), /Use (helm desktop|nothing)/);
  const routes = createDesktopRoutes({ sessions: { get: () => ({}) }, manager });
  await assert.rejects(routes.dispatch('desktop.forget', { id: 'chat-a' }), /unknown desktop method/);
});

test('restart closes the app first, and stops when the app does not close', async t => {
  const { fake, manager } = setup(t);
  fake.answer({ 'close-app': { ok: false, command: 'close-app', error: { code: 'ACTION_NOT_SUPPORTED' } } });
  const refused = await manager.restart('chat-a', { app: 'brave' });
  assert.match(refused.helm, /Ask the owner to close it/);
  assert.deepEqual(fake.calls().map(call => call.args[0]), ['close-app']);
  fake.answer({ 'close-app': { ok: true, command: 'close-app', data: {} }, launch: { ok: true, data: { pid: 5, window: {} } } });
  await manager.restart('chat-a', { app: 'brave' });
  assert.deepEqual(fake.calls().map(call => call.args[0]), ['close-app', 'close-app', 'launch']);
});

test('the guide is their guide, with the Helm words in front', async t => {
  const { fake, manager } = setup(t);
  fake.answer({ skills: { ok: true, command: 'skills', data: { content: '# agent-desktop\nThe loop.' } } });
  const reply = await manager.guide('chat-a', { topic: 'platform troubleshooting' });
  assert.match(reply.guide, /^In Helm, write helm desktop where this guide writes agent-desktop/);
  assert.match(reply.guide, /# agent-desktop\nThe loop\./);
  assert.deepEqual(fake.calls()[0].args, ['skills', 'get', 'platform', 'troubleshooting', '--session', 'helm-chat-a']);
});

test('Helm turns the screen-reader switch off after a quiet time, only when Helm turned it on', async t => {
  let on = false, now = 1000;
  const a11y = { get: async () => on, set: async value => { on = value; } };
  const { manager, make } = setup(t, { a11y, now: () => now, switchIdleMs: 600000 });
  assert.deepEqual(await manager.switch('chat-a', {}), { ok: true, on: false, helmTurnedOn: false });
  assert.equal((await manager.switch('chat-a', { on: true })).on, true);
  now += 300000; await manager.sweep(); assert.equal(on, true);
  assert.deepEqual(await manager.switch('chat-a', { on: false }), { ok: true, on: false }, 'Helm turned it on, so Helm turns it off');
  await manager.switch('chat-a', { on: true });
  await manager.look('chat-a', { app: 'x' });
  now += 400000; await manager.sweep(); assert.equal(on, true, 'desktop use keeps it on');
  // After a Helm restart the timer still knows Helm turned it on.
  now += 600001; await make().sweep(); assert.equal(on, false);
  on = true;
  const owner = make();
  assert.equal(owner.state.switchOn, false);
  assert.match((await owner.switch('chat-a', { on: false })).note, /did not turn this switch on/);
  assert.equal(on, true, 'the owner turned it on, so it stays on');
  now += 10 ** 9; await owner.sweep(); assert.equal(on, true);
});

test('the program reply is read also when it ends with an error code', async t => {
  const dir = mkdtempSync(join(process.env.HELM_DIR, 'run-'));
  const fake = fakeTool(dir);
  fake.answer({ click: { ok: false, command: 'click', error: { code: 'STALE_REF' } } });
  assert.equal((await runTool(fake.tool(), ['click'])).error.code, 'STALE_REF');
  writeFileSync(join(dir, 'bad'), '#!/bin/sh\necho broken >&2; exit 3\n'); chmodSync(join(dir, 'bad'), 0o755);
  await assert.rejects(runTool({ path: join(dir, 'bad'), env: {} }, []), /The desktop program failed. broken/);
  assert.deepEqual(desktopTool({ AGENT_DESKTOP_BINARY_PATH: '/x/agent-desktop' }), { path: '/x/agent-desktop', env: {} });
});

test('helm desktop sends Helm words as their own calls and every other command to the program', async () => {
  const sent = [];
  const rpc = async (env, method, params) => { sent.push([method, params]); return method === 'desktop.guide' ? { guide: 'text' } : { ok: true }; };
  const printed = [];
  const run = args => runDesktopCommand(args, { rpc, self: () => 'me', findSession: async id => ({ env: 'there', session: { id } }), env: { HELM_SESSION_ID: 'chat-a' }, print: line => printed.push(line) });
  await run(['open', 'Text Editor', '/tmp/note.txt']);
  await run(['look', 'brave', '--skeleton']);
  await run(['click', '@s1:e2', '--headed']);
  await run(['switch', 'on']);
  await run(['guide', 'platform']);
  await run(['apps', '--session', 'chat-b']);
  assert.deepEqual(sent, [
    ['desktop.open', { id: 'chat-a', app: 'Text Editor', args: ['/tmp/note.txt'] }],
    ['desktop.look', { id: 'chat-a', app: 'brave', args: ['--skeleton'] }],
    ['desktop.run', { id: 'chat-a', args: ['click', '@s1:e2', '--headed'] }],
    ['desktop.switch', { id: 'chat-a', on: true }],
    ['desktop.guide', { id: 'chat-a', topic: 'platform' }],
    ['desktop.apps', { id: 'chat-b' }],
  ]);
  assert.equal(printed[4], 'text');
  await assert.rejects(run(['open']), /open needs an app name/);
  await assert.rejects(runDesktopCommand(['apps'], { env: {} }), /run desktop commands in a Helm chat/);
});
