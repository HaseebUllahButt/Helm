import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = mkdtempSync(join(tmpdir(), 'helm-release-'));
process.env.HELM_DIR = join(root, 'state');
mkdirSync(process.env.HELM_DIR);
const { prepareRelease, publishRelease } = await import('../packages/connect/src/release.js');
const { watchRelease, confirmRelease } = await import('../packages/connect/src/update.js');
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], {encoding:'utf8', stdio:'pipe'}).trim();
const put = (dir, path, value) => { mkdirSync(join(dir, path, '..'), {recursive:true}); writeFileSync(join(dir, path), value); };
test.after(() => rmSync(root, {recursive:true, force:true}));
function fixture(t) {
  const dir = mkdtempSync(join(root, 'case-'));
  git(dir, 'init', '-qb', 'main');
  git(dir, 'config', 'user.name', 'test'); git(dir, 'config', 'user.email', 'test@example.invalid');
  put(dir, '.gitignore', 'node_modules/\ndist/\n'); put(dir, 'source', 'old');
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'old');
  const previousHead = git(dir, 'rev-parse', 'HEAD');
  put(dir, 'source', 'new'); git(dir, 'commit', '-qam', 'new');
  const targetHead = git(dir, 'rev-parse', 'HEAD');
  const bin = join(dir, 'bin'); mkdirSync(bin);
  put(bin, 'systemctl', '#!/bin/sh\nexit 1\n');
  execFileSync('chmod', ['+x', join(bin, 'systemctl')]);
  const path = process.env.PATH; process.env.PATH = `${bin}:${path}`;
  t.after(() => { process.env.PATH = path; rmSync(join(process.env.HELM_DIR, 'update-state.json'), {force:true}); });
  const state = { version:1, id:'private', dir, previousHead, targetHead, phase:'starting', deadline:0 };
  const save = () => put(process.env.HELM_DIR, 'update-state.json', JSON.stringify(state));
  // The fake service tool is untracked; keep it outside the installed checkout.
  put(dir, '.git/info/exclude', 'bin/\n');
  return {dir, previousHead, targetHead, state, save};
}
test('preparation leaves the live source and app readable and rejects a missing app', async t => {
  const f = fixture(t);
  put(f.dir, 'apps/web/dist/index.html', 'working');
  await assert.rejects(prepareRelease(f.dir, f.targetHead, async folder => {
    assert.notEqual(folder, f.dir);
    assert.equal(readFileSync(join(f.dir, 'apps/web/dist/index.html'), 'utf8'), 'working');
  }), /new app is missing/);
  assert.equal(git(f.dir, 'rev-parse', 'HEAD'), f.targetHead);
  assert.deepEqual((await import('node:fs')).readdirSync(process.env.HELM_DIR), []);
});
test('a wrong build version cannot replace the working app', async t => {
  const f = fixture(t);
  await assert.rejects(prepareRelease(f.dir, f.targetHead, async folder => {
    put(folder, 'apps/web/dist/index.html', 'new');
    put(folder, 'apps/web/dist/build.json', JSON.stringify({commit:f.previousHead}));
  }), /wrong version/);
});
test('published workspace links survive removal of the preparation folder', async t => {
  const f = fixture(t);
  const folder = await prepareRelease(f.dir, f.targetHead, async stage => {
    put(stage, 'apps/web/dist/index.html', 'new');
    put(stage, 'node_modules/example/index.js', 'works');
    symlinkSync(join(stage, 'node_modules/example'), join(stage, 'node_modules/linked'));
  });
  await publishRelease(folder, f.dir, ['apps/web/dist', 'node_modules']);
  rmSync(folder, {recursive:true, force:true});
  assert.equal(readFileSync(join(f.dir, 'node_modules/linked/index.js'), 'utf8'), 'works');
  assert.equal(readlinkSync(join(f.dir, 'node_modules/linked')), join(f.dir, 'node_modules/example'));
});
test('failed startup returns to the prior source without a live service manager', async t => {
  const f = fixture(t); f.save();
  await watchRelease();
  assert.equal(git(f.dir, 'rev-parse', 'HEAD'), f.previousHead);
  assert.equal(existsSync(join(process.env.HELM_DIR, 'update-state.json')), false);
});
test('failed startup keeps owner edits and recovery records', async t => {
  const f = fixture(t); f.save(); put(f.dir, 'source', 'owner edit');
  await watchRelease();
  assert.equal(readFileSync(join(f.dir, 'source'), 'utf8'), 'owner edit');
  assert.equal(JSON.parse(readFileSync(join(process.env.HELM_DIR, 'update-state.json'))).phase, 'built');
});
test('only a matching started release can confirm startup', async t => {
  const f = fixture(t); f.save();
  await confirmRelease(f.dir);
  const state = JSON.parse(readFileSync(join(process.env.HELM_DIR, 'update-state.json')));
  assert.equal(state.readyPid, process.pid);
  await watchRelease({now: () => Date.now()+6000});
  assert.equal(existsSync(join(process.env.HELM_DIR, 'update-state.json')), false);
});

test('startup recovery restores the old app and dependencies together', async t => {
  const f = fixture(t);
  f.state.artifacts = {id:'update-backup-1234', paths:[
    {path:'apps/web/dist', existed:true}, {path:'node_modules', existed:true},
  ]};
  const backup = join(process.env.HELM_DIR, f.state.artifacts.id);
  put(backup, '0/index.html', 'old app'); put(backup, '1/example/index.js', 'old dependency');
  put(f.dir, 'apps/web/dist/index.html', 'failed app'); put(f.dir, 'node_modules/example/index.js', 'failed dependency');
  f.save(); await watchRelease();
  assert.equal(readFileSync(join(f.dir, 'apps/web/dist/index.html'), 'utf8'), 'old app');
  assert.equal(readFileSync(join(f.dir, 'node_modules/example/index.js'), 'utf8'), 'old dependency');
  assert.equal(existsSync(backup), false);
});
