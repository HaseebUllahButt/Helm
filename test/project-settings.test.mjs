import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { M } from '@helm/protocol';

process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-projects-'));
test.after(() => rmSync(process.env.HELM_DIR, { recursive: true, force: true }));

test('a project with chats cannot be removed until they are gone', async () => {
  const { Daemon } = await import('../packages/connect/src/agent.js');
  const { saveProject, listProjects } = await import('../packages/connect/src/settings.js');
  const kept = mkdtempSync(join(tmpdir(), 'helm-kept-'));
  saveProject({ path: kept, title: 'Kept' });
  const daemon = Object.create(Daemon.prototype);
  daemon.sessions = { list: async () => [{ engine: 'claude', cwd: kept }] };
  await assert.rejects(
    daemon.dispatch(M.PROJECT_REMOVE, { path: kept }),
    /delete or move this project’s threads before removing it/
  );
  assert.ok(listProjects().find((p) => p.path === kept));
  daemon.sessions.list = async () => [{ engine: 'shell', cwd: kept }];
  assert.deepEqual(await daemon.dispatch(M.PROJECT_REMOVE, { path: kept }), { ok: true });
  assert.equal(listProjects().find((p) => p.path === kept), undefined);
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
