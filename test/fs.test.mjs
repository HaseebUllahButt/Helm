import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The index walks $HOME, so give it a throwaway one: a few folders, a git
// repo among them, and the things the walk is meant to skip. Setting the
// env before `fs.js` is imported is what makes the walk hermetic rather
// than a crawl of whoever runs the suite.
const HOME = mkdtempSync(join(tmpdir(), 'helm-home-'));
mkdirSync(join(HOME, 'dev/helm/.git'), { recursive: true });
mkdirSync(join(HOME, 'dev/site/node_modules/dep'), { recursive: true });
mkdirSync(join(HOME, 'docs/helm-notes'), { recursive: true });
mkdirSync(join(HOME, '.hidden/secret'), { recursive: true });
mkdirSync(join(HOME, '.config/helm'), { recursive: true });
process.env.HOME = HOME;
process.env.HELM_DIR = mkdtempSync(join(tmpdir(), 'helm-test-'));

test('the index is walked once, searched in memory, and skips what list() skips', async () => {
  const { search } = await import('../packages/connect/src/fs.js');

  const all = await search('helm');
  assert.ok(all.indexed >= 6, 'dev, helm, site, docs, helm-notes, .config, .config/helm - at least');

  // A repo with the exact name outranks a dotfile and a partial match.
  const paths = all.results.map((r) => r.path);
  assert.equal(paths[0], '~/dev/helm');
  assert.equal(all.results[0].repo, true);
  assert.ok(paths.includes('~/.config/helm'));
  assert.ok(paths.includes('~/docs/helm-notes'));

  // Every word must match the path, so "dev helm" is helm-in-dev alone.
  const dev = await search('dev helm');
  assert.deepEqual(dev.results.map((r) => r.path), ['~/dev/helm']);

  // The pruning did its job: no node_modules, nothing hidden.
  assert.deepEqual((await search('node_modules')).results, []);
  assert.deepEqual((await search('secret')).results, []);
});

test('list() shows repos first and a search finds what it lists', async () => {
  const { list, roots } = await import('../packages/connect/src/fs.js');

  const dev = await list('~/dev');
  assert.deepEqual(dev.entries.map((e) => e.name), ['helm', 'site']);
  assert.equal(dev.entries[0].isRepo, true);

  const site = await list('~/dev/site');
  assert.equal(site.entries[0].name, 'node_modules');
  assert.equal(site.entries[0].skip, true, 'node_modules is listed but flagged');

  const home = await list('~');
  const names = home.entries.map((e) => e.name);
  assert.ok(names.includes('dev') && names.includes('.config'));
  assert.ok(!names.includes('.hidden'), 'hidden stays hidden');

  const r = await roots();
  assert.ok(r.roots.some((x) => x.path === '~') && r.roots.some((x) => x.path === '~/dev'));
});

test('a folder made through mkdir is searchable at once, and bad names are refused', async () => {
  const { makeDir, search, list } = await import('../packages/connect/src/fs.js');

  const made = await makeDir({ path: '~/dev', name: 'fresh' });
  assert.equal(made.path, '~/dev/fresh');
  const hit = await search('fresh');
  assert.deepEqual(hit.results.map((r) => r.path), ['~/dev/fresh']);
  assert.ok((await list('~/dev')).entries.some((e) => e.name === 'fresh'));

  await assert.rejects(() => makeDir({ path: '~/dev', name: '../escape' }), /path separator/);
  await assert.rejects(() => makeDir({ path: '~/dev', name: '..' }), /invalid/);
});
