import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
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

test('folders sharing the home prefix keep their absolute paths', async t => {
  const sibling = `${HOME}-neighbor`;
  mkdirSync(join(sibling, 'project'), { recursive: true });
  t.after(() => rmSync(sibling, { recursive: true, force: true }));
  const { list, projectPath } = await import('../packages/connect/src/fs.js');
  const { collapse, expand } = await import('../packages/connect/src/paths.js');
  const listing = await list(sibling);
  assert.equal(listing.path, sibling);
  assert.equal(listing.entries[0].path, join(sibling, 'project'));
  assert.equal(projectPath(join(sibling, 'project')), join(sibling, 'project'));
  for (const path of [HOME, join(HOME, 'dev'), sibling, join(sibling, 'project')]) {
    assert.equal(expand(collapse(path)), path);
  }
  assert.equal(collapse(HOME), '~');
  assert.equal(collapse(join(HOME, 'dev')), '~/dev');
});

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

test('a restarted index uses the persisted cache before walking', async () => {
  const cacheFile = join(process.env.HELM_DIR, 'folder-index.json');
  const cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
  assert.equal(cache.home, HOME);
  assert.ok(cache.dirs.some((d) => d.path === '~/dev/fresh'), 'picker additions survive restart');
  assert.equal(statSync(cacheFile).mode & 0o777, 0o600);
  rmSync(join(HOME, 'dev/fresh'), { recursive: true });
  const restarted = await import('../packages/connect/src/fs.js?restart');
  assert.deepEqual((await restarted.search('fresh')).results.map((d) => d.path), ['~/dev/fresh']);
});

test('a stale cache serves results while refreshing and removes deleted folders after the walk', async () => {
  const cacheFile = join(process.env.HELM_DIR, 'folder-index.json');
  const cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
  cache.at = Date.now() - 11 * 60_000;
  writeFileSync(cacheFile, JSON.stringify(cache));
  const restarted = await import('../packages/connect/src/fs.js?stale');
  assert.deepEqual((await restarted.search('fresh')).results.map((d) => d.path), ['~/dev/fresh']);
  await restarted.warmIndex();
  assert.deepEqual((await restarted.search('fresh')).results, []);
});

test('a corrupt or wrong-home cache is ignored and rebuilt', async () => {
  const cacheFile = join(process.env.HELM_DIR, 'folder-index.json');
  for (const [tag, data] of [['corrupt', '{'], ['wrong-home', JSON.stringify({ version: 1, home: '/other', at: Date.now(), dirs: [] })]]) {
    writeFileSync(cacheFile, data);
    const restarted = await import(`../packages/connect/src/fs.js?${tag}`);
    assert.ok((await restarted.search('dev helm')).results.some((d) => d.path === '~/dev/helm'));
    assert.equal(JSON.parse(readFileSync(cacheFile, 'utf8')).home, HOME);
  }
});

test('list counts ordinary and hidden files even though the picker lists only folders', async () => {
  const { list } = await import('../packages/connect/src/fs.js');
  const folder = join(HOME, 'occupied-transfer');
  mkdirSync(folder);
  writeFileSync(join(folder, 'app.txt'), 'keep me');
  writeFileSync(join(folder, '.env'), 'TEST=throwaway');
  const listing = await list(folder);
  assert.deepEqual(listing.entries, []);
  assert.equal(listing.entryCount, 2);
});

test('project copies Helm made for chats stay out of the picker; other worktrees stay in', async () => {
  // Fake linked worktrees: a `.git` file into the repo's .git/worktrees, with a HEAD there.
  const copy = (name, branch) => {
    const gitdir = join(HOME, 'dev/helm/.git/worktrees', name);
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, 'HEAD'), `ref: refs/heads/${branch}\n`);
    mkdirSync(join(HOME, 'dev', name, 'src'), { recursive: true });
    writeFileSync(join(HOME, 'dev', name, '.git'), `gitdir: ${gitdir}\n`);
  };
  copy('helm-chat-abc123', 'helm/chat-abc123');
  copy('helm-own-tree', 'experiment');
  const fsApi = await import('../packages/connect/src/fs.js?copies');
  const listed = (await fsApi.list(join(HOME, 'dev'))).entries.map((e) => e.name);
  assert.ok(listed.includes('helm') && listed.includes('helm-own-tree'));
  assert.ok(!listed.includes('helm-chat-abc123'));
  await fsApi.warmIndex({ force: true });
  const found = (await fsApi.search('helm')).results.map((d) => d.path);
  assert.ok(found.includes('~/dev/helm-own-tree'));
  assert.ok(!found.some((p) => p.startsWith('~/dev/helm-chat-abc123')), 'neither the copy nor its folders');
  rmSync(join(HOME, 'dev/helm-chat-abc123'), { recursive: true });
  rmSync(join(HOME, 'dev/helm-own-tree'), { recursive: true });
});

test('a device gets the whole index as a tree, and only again once it changes', async () => {
  mkdirSync(join(HOME, '.config/chromium/Default/IndexedDB/deep'), { recursive: true });
  const fsApi = await import('../packages/connect/src/fs.js?index');
  const paths = (r) => r.names.map((_, i) => { const out = []; for (let j = i; j >= 0; j = r.parents[j]) out.unshift(r.names[j]); return `~/${out.join('/')}`; });
  const first = await fsApi.folderIndex({ refresh: true });
  const all = paths(first);
  assert.ok(all.includes('~/dev/helm'));
  assert.ok(first.repos.map((i) => all[i]).includes('~/dev/helm'));
  assert.equal(first.count, all.length);
  // Browser profiles under ~/.config stop two levels down.
  assert.ok(all.includes('~/.config/chromium/Default'));
  assert.ok(!all.some((p) => p.startsWith('~/.config/chromium/Default/')));
  // Unchanged: just the stamp back.
  const again = await fsApi.folderIndex({ since: first.stamp });
  assert.equal(again.unchanged, true);
  assert.equal(again.names, undefined);

  // A folder made in a terminal shows once the machine looks again...
  mkdirSync(join(HOME, 'dev/made-outside'));
  const looked = await fsApi.folderIndex({ since: first.stamp, refresh: true });
  assert.notEqual(looked.stamp, first.stamp);
  assert.ok(paths(looked).includes('~/dev/made-outside'));
  // ...and browsing a folder notices what came and went there, at once.
  mkdirSync(join(HOME, 'dev/made-later'));
  rmSync(join(HOME, 'dev/made-outside'), { recursive: true });
  await fsApi.list(join(HOME, 'dev'));
  const browsed = paths(await fsApi.folderIndex({ since: looked.stamp }));
  assert.ok(browsed.includes('~/dev/made-later'));
  assert.ok(!browsed.includes('~/dev/made-outside'));
  assert.deepEqual((await fsApi.search('made-later')).results.map((d) => d.path), ['~/dev/made-later']);
});
