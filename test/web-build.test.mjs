import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { webBuild } from '../packages/connect/src/web-build.js';
import { stampBuild } from '../apps/web/stampBuild.mjs';

const root = mkdtempSync(join(tmpdir(), 'helm-web-build-'));
test.after(() => rmSync(root, { recursive: true, force: true }));
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();

test('the app build names the commit it was built from', async () => {
  git('init', '-q');
  mkdirSync(join(root, 'apps/web/src'), { recursive: true });
  writeFileSync(join(root, 'apps/web/src/a.ts'), 'one');
  writeFileSync(join(root, '.gitignore'), 'dist/\n');
  git('add', '.');
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-qm', 'base');
  const dist = join(root, 'apps/web/dist');
  mkdirSync(dist);
  const plugin = stampBuild({ cwd: join(root, 'apps/web'), now: () => 5 });
  assert.equal(webBuild(dist), null, 'no stamp yet');

  const build = async () => { plugin.buildStart(); await plugin.writeBundle({ dir: dist }); };
  plugin.buildStart();
  const head = git('rev-parse', 'HEAD');
  // A commit made while the build runs does not stamp the older output.
  git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'during');
  await plugin.writeBundle({ dir: dist });
  assert.deepEqual(webBuild(dist), { commit: head, dirty: false, builtAt: 5 });

  // Edits outside the app do not make the build differ from its commit.
  writeFileSync(join(root, 'notes.md'), 'x');
  await build();
  assert.equal(webBuild(dist).dirty, false);
  writeFileSync(join(root, 'apps/web/src/a.ts'), 'two');
  await build();
  assert.equal(webBuild(dist).dirty, true);
});

test('a missing or broken stamp reads as no stamp', () => {
  const dir = join(root, 'broken');
  mkdirSync(dir);
  writeFileSync(join(dir, 'build.json'), '{');
  assert.equal(webBuild(dir), null);
  assert.equal(webBuild(null), null);
});
