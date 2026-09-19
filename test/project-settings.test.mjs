import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { M } from '@helm/protocol';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-projects-'));
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));

test('projects save, list, rename and remove', async () => {
  const { listProjects, saveProject, removeProject } = await import('../packages/connect/src/settings.js');
  assert.deepEqual(listProjects(), []);
  saveProject({ path: '/tmp/one' });
  saveProject({ path: '/tmp/two', title: 'Two' });
  assert.deepEqual(listProjects(), [
    { path: '/tmp/one', title: 'one' },
    { path: '/tmp/two', title: 'Two' },
  ]);
  saveProject({ path: '/tmp/one', title: 'First' });
  assert.deepEqual(listProjects()[0], { path: '/tmp/one', title: 'First' });
  removeProject('/tmp/two');
  assert.deepEqual(listProjects(), [{ path: '/tmp/one', title: 'First' }]);
});

test('fs.project normalizes a directory and refuses a file', async () => {
  const { project, projectPath } = await import('../packages/connect/src/fs.js');
  const dir = mkdtempSync(join(tmpdir(), 'helm-proj-'));
  const found = await project(`${dir}/`);
  assert.equal(found.path, dir);
  assert.equal(found.title, dir.split('/').pop());
  const file = join(dir, 'f');
  writeFileSync(file, 'x');
  await assert.rejects(() => project(file), /a project must be a directory/);
  assert.equal(projectPath(dir), dir);
});

test('dispatch merges saved projects with session directories', async () => {
  const { Daemon } = await import('../packages/connect/src/agent.js');
  const { saveProject, listProjects } = await import('../packages/connect/src/settings.js');
  const live = mkdtempSync(join(tmpdir(), 'helm-live-'));
  const kept = mkdtempSync(join(tmpdir(), 'helm-kept-'));
  saveProject({ path: kept, title: 'Kept' });

  const daemon = Object.create(Daemon.prototype);
  daemon.sessions = {
    list: async () => [
      { engine: 'shell', cwd: '/tmp/shell' },
      { engine: 'claude', cwd: `${live}/` },
      { engine: 'claude', cwd: kept },
    ],
  };

  const { projects } = await daemon.dispatch(M.PROJECT_LIST, {});
  const byPath = new Map(projects.map((x) => [x.path, x]));
  assert.ok(byPath.has(kept));
  assert.ok(byPath.has(live), 'a session cwd becomes a project on its own');
  assert.equal(byPath.get(kept).title, 'Kept', 'a saved title wins over the folder name');
  assert.ok(!byPath.has('/tmp/shell'), 'shell sessions are not projects');
  assert.deepEqual(projects.map((x) => x.title), [...projects.map((x) => x.title)].sort((a, b) => a.localeCompare(b)));

  await assert.rejects(
    daemon.dispatch(M.PROJECT_REMOVE, { path: kept }),
    /delete or move this project’s threads before removing it/
  );
  daemon.sessions.list = async () => [{ engine: 'shell', cwd: kept }];
  assert.deepEqual(await daemon.dispatch(M.PROJECT_REMOVE, { path: kept }), { ok: true });
  assert.equal(listProjects().find((p) => p.path === kept), undefined);

  const saved = await daemon.dispatch(M.PROJECT_SAVE, { path: `${live}/`, title: '  named  ' });
  assert.deepEqual(saved.project, { path: live, title: 'named' });
  await assert.rejects(daemon.dispatch(M.PROJECT_SAVE, { path: join(live, 'missing') }));
});

test('a project whose directory vanished can still be removed', async () => {
  const { Daemon } = await import('../packages/connect/src/agent.js');
  const { saveProject, listProjects } = await import('../packages/connect/src/settings.js');
  const gone = mkdtempSync(join(tmpdir(), 'helm-gone-'));
  saveProject({ path: gone });
  rmSync(gone, { recursive: true, force: true });

  const daemon = Object.create(Daemon.prototype);
  daemon.sessions = { list: async () => [] };
  assert.deepEqual(await daemon.dispatch(M.PROJECT_REMOVE, { path: gone }), { ok: true });
  assert.equal(listProjects().find((p) => p.path === gone), undefined);
});
