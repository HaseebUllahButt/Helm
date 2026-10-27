import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appRows, discoverApps, internalApp, procListeners } from '../packages/connect/src/browser-apps.js';
import { createBrowserRoutes } from '../packages/connect/src/browser-routes.js';

const processRow = (pid, ppid, cwd, argv, sockets = []) => ({ pid, ppid, cwd, argv, sockets: new Set(sockets) });
const listeners = [{ inode: '11', port: 5173 }, { inode: '12', port: 5174 }];

test('only descendants or project folders own apps; sibling folders and other chats stay out', () => {
  const processes = [processRow(1, 0, '/project', ['claude']), processRow(2, 1, '/elsewhere', ['node', '/bin/vite.js'], ['11']), processRow(3, 0, '/project-two', ['node'], ['12'])];
  assert.deepEqual(appRows(processes, listeners, { roots: [1] }), [{ name: 'vite', port: 5173, pid: 2 }]);
  assert.equal(appRows(processes, listeners, { cwd: '/project' }).length, 0);
  processes[1].cwd = '/project/sub';
  assert.equal(appRows(processes, listeners, { cwd: '/project' }).length, 1);
  assert.equal(appRows(processes, listeners, {}).length, 0);
});

test('Helm, agents, browsers, and agent helpers do not become apps', () => {
  for (const argv of [['node', '/bin/helm.js'], ['/bin/codex', 'app-server'], ['node', '/x/@anthropic-ai/cli.js'], ['node', '/tools/mcp-server.js'], ['/usr/bin/chromium'], ['claude']]) assert.equal(internalApp(argv), true, argv.join(' '));
  assert.equal(internalApp(['node', '/project/helm-website/server.js']), false);
  const processes = [processRow(1, 0, '/project', ['claude'], ['11']), processRow(2, 1, '/project', ['node', 'mcp-server'], ['12'])];
  assert.deepEqual(appRows(processes, listeners, { roots: [1], cwd: '/project' }), []);
});

test('read IPv4 and IPv6 wildcard and loopback listeners, never external addresses or non-listeners', () => {
  const row = (addr, state, inode) => `0: ${addr}:1435 00000000:0000 ${state} 0:0 0:0 0 1000 0 ${inode}`;
  const parsed = procListeners(['header', row('0100007F', '0A', 11), row('00000000000000000000000001000000', '0A', 12), row('00000000', '01', 13), row('0100000A', '0A', 14)].join('\n'));
  assert.deepEqual(parsed, [{ inode: '11', port: 5173 }, { inode: '12', port: 5173 }]);
});

test('Linux discovers new listeners and removes stopped apps without sending any traffic', { skip: process.platform !== 'linux' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helm-apps-'));
  const child = spawn(process.execPath, ['-e', `const s=require('net').createServer(()=>{console.error('UNEXPECTED REQUEST')});s.listen(0,'127.0.0.1',()=>console.log(s.address().port))`], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let traffic = ''; child.stderr.on('data', data => { traffic += data; });
  try {
    const [line] = await once(child.stdout, 'data'); const port = +line.toString().trim();
    assert.deepEqual(await discoverApps({ id: 'fake', cwd: dir }), [{ name: 'node', port, pid: child.pid }]);
    assert.equal(traffic, '');
    assert.deepEqual(await discoverApps({ id: 'fake', cwd: join(dir, 'other') }), []);
    assert.deepEqual(await discoverApps({ id: 'fake', cwd: dir, quick: true }), []);
    const gone = once(child, 'exit'); child.kill(); await gone;
    assert.deepEqual(await discoverApps({ id: 'fake', cwd: dir }), []);
  } finally { if (child.exitCode === null && child.signalCode === null) { const gone = once(child, 'exit'); child.kill(); await gone; } await rm(dir, { recursive: true, force: true }); }
});

test('Linux home and absent projects do not own listeners; agent descendants still do', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helm-apps-proc-'));
  try {
    const project = join(dir, 'home'); await mkdir(project);
    const proc = join(dir, 'proc'); await mkdir(join(proc, 'net'), { recursive: true });
    await writeFile(join(proc, 'net/tcp'), 'header\n0: 0100007F:1435 0:0 0A 0:0 0:0 0 1000 0 11\n');
    for (const [pid, ppid, cmd, env, socket] of [[1, 0, 'claude\0', 'HELM_SESSION_ID=fake\0', false], [2, 1, 'node\0server.js\0', 'HELM_SESSION_ID=fake\0', true]]) {
      const folder = join(proc, String(pid)); await mkdir(join(folder, 'fd'), { recursive: true });
      await writeFile(join(folder, 'stat'), `${pid} (name with spaces) S ${ppid} 0`);
      await writeFile(join(folder, 'cmdline'), cmd); await writeFile(join(folder, 'environ'), env);
      await symlink(project, join(folder, 'cwd')); if (socket) await symlink('socket:[11]', join(folder, 'fd/3'));
    }
    const options = { platform: 'linux', proc, home: project };
    assert.equal((await discoverApps({ id: 'fake', cwd: project }, options)).length, 1);
    assert.deepEqual(await discoverApps({ id: 'other', cwd: project }, options), []);
    assert.deepEqual(await discoverApps({ id: 'other' }, options), []);
    await writeFile(join(proc, '1/cmdline'), 'codex\0app-server\0');
    assert.deepEqual(await discoverApps({ id: 'fake' }, options), [], 'shared agent processes do not assign every app to their first chat');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('macOS uses lsof with process parents and folders; missing lsof and other systems show nothing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'helm-apps-mac-'));
  try {
    const exec = async (command, args) => ({ stdout: command === 'ps' ? '1 0 /bin/claude\n2 1 /bin/node\n3 0 /bin/node' : args.includes('-iTCP') ? 'p2\ncnode\nf3\nn127.0.0.1:5173\nTST=LISTEN\np3\ncnode\nf4\nn*:5174\nTST=LISTEN\n' : `p2\nn/elsewhere\np3\nn${dir}/sub\n` });
    assert.deepEqual((await discoverApps({ id: 'fake', cwd: dir }, { platform: 'darwin', roots: [1], exec })).map(app => app.port), [5173, 5174]);
    assert.deepEqual(await discoverApps({ id: 'fake' }, { platform: 'darwin', exec: async () => { throw new Error('ENOENT'); } }), []);
    assert.deepEqual(await discoverApps({ id: 'fake' }, { platform: 'win32', exec: () => { throw new Error('must not run'); } }), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('only a panel apps request scans; opening checks the port still belongs to that chat', async () => {
  const scans = [], opens = [], notices = [];
  const routes = createBrowserRoutes({ sessions: { get: id => ({ id }), appProcessRoots: () => [123] }, scanApps: async (session, options) => { scans.push([session.id, options]); return [{ name: 'vite', port: 5173, pid: 2 }]; }, manager: { list: () => ({ tabs: [] }), open: async (id, p) => { opens.push([id, p]); return { tab: { id: 'tab' } }; } }, onOpen: notice => notices.push(notice) });
  await routes.dispatch('browser.list', { id: 'fake' }); assert.equal(scans.length, 0);
  assert.equal((await routes.dispatch('browser.apps', { id: 'fake' })).apps[0].port, 5173);
  assert.deepEqual(scans[0], ['fake', { roots: [123] }]);
  await assert.rejects(routes.dispatch('browser.openApp', { id: 'fake', url: 'http://localhost:5174' }), /stopped/);
  await assert.rejects(routes.dispatch('browser.openApp', { id: 'fake', url: 'http://example.com:5173' }), /stopped/);
  assert.equal(opens.length, 0);
  await routes.dispatch('browser.openApp', { id: 'fake', url: 'http://127.0.0.1:5173/path?q=1' });
  assert.equal(opens[0][0], 'fake'); assert.equal(opens[0][1].url, 'http://127.0.0.1:5173/path?q=1'); assert.equal(notices[0].tabId, 'tab');
});
