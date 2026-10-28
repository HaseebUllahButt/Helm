import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, symlinkSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const installer = fileURLToPath(new URL('../install.sh', import.meta.url));
const tool = (name) => execFileSync('/bin/bash', ['-c', 'command -v "$1"', 'tools', name], { encoding: 'utf8' }).trim();
const gitBin = tool('git');
const bashBin = tool('bash');

// Run the real installer. Only Git and basic file tools are real. All installs,
// builds and starts are fake. PATH cannot reach the owner's installed software;
// Git can use only local files. Each test owns its home and its repositories.
function machine(t, { unusualPaths = false, herdr = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'helm-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const suffix = unusualPaths ? ' space\'"$HOME`touch INJECTED`$(touch INJECTED)' : '';
  const home = join(root, `home${suffix}`);
  const bin = join(root, `tools${suffix}`);
  const source = join(root, 'source');
  const remote = join(root, 'remote.git');
  const dir = join(root, `install${suffix}`);
  const log = join(root, 'calls.jsonl');
  for (const folder of [home, bin, source]) mkdirSync(folder, { recursive: true });
  writeFileSync(log, '');
  const env = {
    HOME: home, PATH: bin, LANG: 'C', LC_ALL: 'C', TMPDIR: root,
    HELM_DIR: join(root, 'state'), HELM_INSTALL_DIR: dir,
    HELM_REPO: pathToFileURL(remote).href, HELM_BRANCH: 'main',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Installer test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Installer test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    INSTALL_CALLS: log,
  };
  const git = (cwd, ...args) => execFileSync(gitBin, ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const executable = (name, body) => {
    const file = join(bin, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  };
  for (const name of ['sh', 'bash', 'env', 'mkdir', 'cat', 'chmod', 'ls', 'cp', 'mv', 'rm', 'dirname', 'ln', 'readlink']) symlinkSync(tool(name), join(bin, name));
  symlinkSync(gitBin, join(bin, 'git'));
  const fakeHeader = `#!${process.execPath}\nimport { appendFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';\nimport { join } from 'node:path';\nconst args = process.argv.slice(2);\nappendFileSync(process.env.INSTALL_CALLS, JSON.stringify({ tool: process.argv[1].split('/').at(-1), args, cwd: process.cwd() }) + '\\n');\n`;
  executable('node', fakeHeader + `
if (args[0] === '-p') console.log(process.env.FAKE_NODE_MAJOR || '26');
else if (args[0] === '-v') console.log('v26.0.0');
else if (args[0] === '--input-type=module') {
  if (process.env.FAKE_NO_FEATURES) process.exit(1);
  // Exercise the feature probe on the test runner's real Node. No files or
  // network connections are needed for its in-memory database.
  await import('node:child_process').then(({ spawnSync }) => {
    const result = spawnSync(process.execPath, args, { env: process.env, stdio: 'ignore' });
    process.exit(result.status ?? 1);
  });
} else if (args[0] === '-e') process.exit(process.env.FAKE_NO_PTY ? 1 : 0);
else if (args[0] === 'scripts/build-log-reader.mjs') {
  if (process.env.FAKE_READER_OUTPUT) { mkdirSync('native/log-index', {recursive:true}); writeFileSync('native/log-index/log-index.test.node', 'new reader'); }
  process.exit(process.env.FAKE_READER_FAIL ? 1 : 0);
}
else if (args[0]?.endsWith('/packages/connect/bin/helm.js')) process.exit(process.env.FAKE_START_FAIL ? 1 : 0);
else process.exit(90);
`);
  executable('npm', fakeHeader + `
if (args[0] === '--version') {
  console.log('11.0.0');
  process.exit(process.env.FAKE_NPM_BROKEN ? 1 : 0);
}
if (args[0] === 'ci') { mkdirSync('node_modules/example', {recursive:true}); writeFileSync('node_modules/example/index.js', 'new dependency'); process.exit(process.env.FAKE_CI_FAIL ? 1 : 0); }
if (args[0] === '--workspace') { mkdirSync('apps/web/dist', {recursive:true}); writeFileSync('apps/web/dist/index.html', 'app'); process.exit(process.env.FAKE_BUILD_FAIL ? 1 : 0); }
process.exit(91);
`);
  executable('curl', fakeHeader + `
if (process.env.FAKE_CURL_FAIL) process.exit(1);
if (!process.env.FAKE_CURL_EMPTY) console.log(\`mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/herdr" <<'HERDR'
#!/bin/sh
echo herdr-test
HERDR
chmod +x "$HOME/.local/bin/herdr"\`);
`);
  executable('npx', fakeHeader + 'process.exit(92);\n');
  if (herdr) executable('herdr', fakeHeader + "console.log('herdr-test');\n");
  git(source, 'init', '--quiet', '--initial-branch=main');
  const put = (cwd, file, content) => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), content);
  };
  put(source, 'package.json', '{"name":"private-installer-fixture","version":"1.0.0"}\n');
  put(source, 'package-lock.json', '{"name":"private-installer-fixture","lockfileVersion":3,"packages":{}}\n');
  put(source, 'tracked.txt', 'saved\n');
  put(source, '.gitignore', 'node_modules/\napps/web/dist/\nnative/log-index/*.node\nignored.txt\n');
  put(source, 'scripts/build-log-reader.mjs', '// fake build\n');
  put(source, 'packages/connect/bin/helm.js', '// fake start\n');
  git(source, 'add', '.');
  git(source, 'commit', '--quiet', '-m', 'Create private fixture');
  git(root, 'clone', '--quiet', '--bare', source, remote);
  git(source, 'remote', 'add', 'origin', env.HELM_REPO);
  const clone = () => git(root, 'clone', '--quiet', env.HELM_REPO, dir);
  const run = (overrides = {}) => spawnSync(bashBin, [installer], {
    cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 15_000,
  });
  const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const publish = (file = 'remote.txt', text = 'remote update\n') => {
    put(source, file, text);
    git(source, 'add', file);
    git(source, 'commit', '--quiet', '-m', 'Update private fixture');
    git(source, 'push', '--quiet', 'origin', 'main');
    return git(source, 'rev-parse', 'HEAD');
  };
  return { root, home, bin, source, remote, dir, env, log, git, put, clone, run, calls, publish };
}

function passed(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
function refused(m, result, message) {
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, message);
  assert.equal(m.calls().some(({ tool, args }) => tool === 'curl' || tool === 'herdr'
    || tool === 'npm' && args[0] !== '--version'
    || tool === 'node' && (args[0] === 'scripts/build-log-reader.mjs' || args[0]?.endsWith('/helm.js'))), false);
  assert.equal(existsSync(join(m.home, '.local/bin/helm')), false);
}

test('fresh install uses the saved dependency list and starts the quoted launcher', (t) => {
  const m = machine(t);
  passed(m.run());
  assert.deepEqual(m.calls().filter((c) => c.tool === 'npm' && c.args[0] !== '--version').map((c) => c.args), [
    ['ci', '--include=dev', '--silent', '--no-fund', '--no-audit'],
    ['--workspace', '@helm/web', 'run', 'build', '--silent'],
  ]);
  assert.equal(readFileSync(join(m.dir, 'package-lock.json'), 'utf8'), readFileSync(join(m.source, 'package-lock.json'), 'utf8'));
  assert.deepEqual(m.calls().at(-1).args, [join(m.dir, 'packages/connect/bin/helm.js'), 'start']);
});

for (const kind of ['unstaged', 'staged', 'deleted', 'untracked']) {
  test(`refuses ${kind} files before installing terminal software or dependencies`, (t) => {
    const m = machine(t, { herdr: false });
    m.clone();
    const before = m.git(m.dir, 'rev-parse', 'HEAD');
    m.publish();
    if (kind === 'deleted') rmSync(join(m.dir, 'tracked.txt'));
    else m.put(m.dir, kind === 'untracked' ? 'notes.txt' : 'tracked.txt', 'keep this\n');
    if (kind === 'staged') m.git(m.dir, 'add', 'tracked.txt');
    const status = m.git(m.dir, 'status', '--porcelain', '--untracked-files=all');
    refused(m, m.run(), /Save your edits/);
    assert.equal(m.git(m.dir, 'rev-parse', 'HEAD'), before);
    assert.equal(m.git(m.dir, 'status', '--porcelain', '--untracked-files=all'), status);
    assert.equal(existsSync(join(m.dir, '.git/FETCH_HEAD')), false);
    if (kind !== 'deleted') assert.equal(readFileSync(join(m.dir, kind === 'untracked' ? 'notes.txt' : 'tracked.txt'), 'utf8'), 'keep this\n');
  });
}

test('updates a clean checkout only by fast forward and leaves other worktrees alone', (t) => {
  const m = machine(t);
  m.clone();
  const other = join(m.root, 'other-worktree');
  m.git(m.dir, 'worktree', 'add', '--quiet', '-b', 'other', other);
  m.put(other, 'tracked.txt', 'other unsaved edits\n');
  const otherHead = m.git(other, 'rev-parse', 'HEAD');
  const worktrees = m.git(m.dir, 'worktree', 'list', '--porcelain');
  const target = m.publish();
  passed(m.run());
  assert.equal(m.git(m.dir, 'rev-parse', 'HEAD'), target);
  assert.equal(m.git(m.dir, 'branch', '--show-current'), 'main');
  assert.equal(m.git(other, 'rev-parse', 'HEAD'), otherHead);
  assert.equal(readFileSync(join(other, 'tracked.txt'), 'utf8'), 'other unsaved edits\n');
  assert.equal(m.git(m.dir, 'worktree', 'list', '--porcelain').replace(target, otherHead), worktrees);
});

test('a second run updates the shallow checkout from the first install', (t) => {
  const m = machine(t);
  passed(m.run());
  assert.equal(m.git(m.dir, 'rev-parse', '--is-shallow-repository'), 'true');
  const unchanged = m.run();
  passed(unchanged);
  assert.match(unchanged.stdout, /already current/);
  const target = m.publish();
  passed(m.run());
  assert.equal(m.git(m.dir, 'rev-parse', 'HEAD'), target);
  assert.equal(m.git(m.dir, 'status', '--porcelain'), '');
});

test('keeps local commits which are ahead of the remote', (t) => {
  const m = machine(t);
  m.clone();
  m.put(m.dir, 'local.txt', 'keep local commit\n');
  m.git(m.dir, 'add', 'local.txt');
  m.git(m.dir, 'commit', '--quiet', '-m', 'Keep local work');
  const head = m.git(m.dir, 'rev-parse', 'HEAD');
  passed(m.run());
  assert.equal(m.git(m.dir, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(join(m.dir, 'local.txt'), 'utf8'), 'keep local commit\n');
});

test('refuses divergent commits without merging or losing local commits', (t) => {
  const m = machine(t, { herdr: false });
  m.clone();
  m.put(m.dir, 'local.txt', 'local commit\n');
  m.git(m.dir, 'add', 'local.txt');
  m.git(m.dir, 'commit', '--quiet', '-m', 'Local commit');
  const head = m.git(m.dir, 'rev-parse', 'HEAD');
  m.publish();
  refused(m, m.run(), /Local and remote commits differ/);
  assert.equal(m.git(m.dir, 'rev-parse', 'HEAD'), head);
  assert.equal(m.git(m.dir, 'status', '--porcelain'), '');
});

test('refuses a different branch and preserves its selection', (t) => {
  const m = machine(t, { herdr: false });
  m.clone();
  m.git(m.dir, 'checkout', '--quiet', '-b', 'chosen');
  refused(m, m.run(), /Keep branch chosen/);
  assert.equal(m.git(m.dir, 'branch', '--show-current'), 'chosen');
});

test('accepts an explicitly selected branch in a linked worktree', (t) => {
  const m = machine(t);
  m.git(m.source, 'branch', 'chosen');
  m.git(m.source, 'push', '--quiet', 'origin', 'chosen');
  m.git(m.source, 'worktree', 'add', '--quiet', m.dir, 'chosen');
  const head = m.git(m.dir, 'rev-parse', 'HEAD');
  passed(m.run({ HELM_BRANCH: 'chosen' }));
  assert.equal(m.git(m.dir, 'branch', '--show-current'), 'chosen');
  assert.equal(m.git(m.dir, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(join(m.dir, '.git'), 'utf8').startsWith('gitdir: '), true);
  assert.equal(m.git(m.source, 'branch', '--show-current'), 'main');
});

test('fast forwards a linked worktree without changing the primary checkout', (t) => {
  const m = machine(t);
  m.clone();
  m.git(m.dir, 'checkout', '--quiet', '-b', 'keep-primary');
  const primaryHead = m.git(m.dir, 'rev-parse', 'HEAD');
  const linked = join(m.root, 'linked');
  m.git(m.dir, 'worktree', 'add', '--quiet', linked, 'main');
  const target = m.publish();
  passed(m.run({ HELM_INSTALL_DIR: linked }));
  assert.equal(m.git(linked, 'rev-parse', 'HEAD'), target);
  assert.equal(m.git(m.dir, 'rev-parse', 'HEAD'), primaryHead);
  assert.equal(m.git(m.dir, 'branch', '--show-current'), 'keep-primary');
});

for (const state of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer', 'BISECT_LOG']) {
  test(`refuses an unfinished Git operation (${state})`, (t) => {
    const m = machine(t, { herdr: false });
    m.clone();
    const marker = join(m.dir, '.git', state);
    if (state === 'rebase-merge' || state === 'rebase-apply' || state === 'sequencer') mkdirSync(marker);
    else writeFileSync(marker, m.git(m.dir, 'rev-parse', 'HEAD') + '\n');
    refused(m, m.run(), /Finish the Git operation/);
    assert.equal(existsSync(marker), true);
  });
}

test('refuses a detached checkout', (t) => {
  const m = machine(t, { herdr: false });
  m.clone();
  m.git(m.dir, 'checkout', '--quiet', '--detach');
  const head = m.git(m.dir, 'rev-parse', 'HEAD');
  refused(m, m.run(), /Choose a branch/);
  assert.equal(m.git(m.dir, 'rev-parse', 'HEAD'), head);
});

test('refuses a checkout from another source before fetching', (t) => {
  const m = machine(t, { herdr: false });
  m.clone();
  m.git(m.dir, 'remote', 'set-url', 'origin', 'file:///not-the-requested-repository');
  refused(m, m.run(), /checkout uses another source/);
  assert.equal(existsSync(join(m.dir, '.git/FETCH_HEAD')), false);
});

for (const kind of ['nonempty', 'nested', 'file', 'broken-link']) {
  test(`refuses an unsafe existing install path (${kind})`, (t) => {
    const m = machine(t, { herdr: false });
    let dir = m.dir;
    if (kind === 'file') writeFileSync(dir, 'keep file');
    else if (kind === 'broken-link') symlinkSync(join(m.root, 'missing'), dir);
    else if (kind === 'nested') {
      dir = join(m.source, 'nested');
      mkdirSync(dir);
      writeFileSync(join(dir, 'note'), 'keep note');
    } else {
      mkdirSync(dir);
      writeFileSync(join(dir, 'note'), 'keep note');
    }
    refused(m, m.run({ HELM_INSTALL_DIR: dir }), /not a folder|not an empty folder/);
    if (kind === 'file') assert.equal(readFileSync(dir, 'utf8'), 'keep file');
    else if (kind !== 'broken-link') assert.equal(readFileSync(join(dir, 'note'), 'utf8'), 'keep note');
  });
}

test('allows an existing empty folder', (t) => {
  const m = machine(t);
  mkdirSync(m.dir);
  passed(m.run());
});

test('does not overwrite ignored files when a remote commit tracks their paths', (t) => {
  const m = machine(t, { herdr: false });
  m.clone();
  m.put(m.dir, 'ignored.txt', 'keep ignored file\n');
  m.put(m.source, 'ignored.txt', 'remote tracked file\n');
  m.git(m.source, 'add', '--force', 'ignored.txt');
  m.git(m.source, 'commit', '--quiet', '-m', 'Track ignored path');
  m.git(m.source, 'push', '--quiet', 'origin', 'main');
  const head = m.git(m.dir, 'rev-parse', 'HEAD');
  refused(m, m.run(), /Cannot update/);
  assert.equal(m.git(m.dir, 'rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(join(m.dir, 'ignored.txt'), 'utf8'), 'keep ignored file\n');
});

for (const problem of ['old-node', 'no-features', 'missing-npm', 'broken-npm', 'bad-version', 'missing-curl', 'missing-node', 'missing-git']) {
  test(`checks runtime requirements before changing files (${problem})`, (t) => {
    const m = machine(t, { herdr: false });
    m.clone();
    m.publish();
    const head = m.git(m.dir, 'rev-parse', 'HEAD');
    const overrides = {};
    if (problem === 'old-node') overrides.FAKE_NODE_MAJOR = '20';
    if (problem === 'no-features') overrides.FAKE_NO_FEATURES = '1';
    if (problem === 'missing-npm') rmSync(join(m.bin, 'npm'));
    if (problem === 'broken-npm') overrides.FAKE_NPM_BROKEN = '1';
    if (problem === 'bad-version') overrides.FAKE_NODE_MAJOR = 'unknown';
    if (problem === 'missing-curl') rmSync(join(m.bin, 'curl'));
    if (problem === 'missing-node') rmSync(join(m.bin, 'node'));
    if (problem === 'missing-git') rmSync(join(m.bin, 'git'));
    refused(m, m.run(overrides), /Node|node|npm|curl|git/);
    assert.equal(m.git(m.dir, 'rev-parse', 'HEAD'), head);
    assert.equal(existsSync(join(m.dir, '.git/FETCH_HEAD')), false);
  });
}

test('installs missing terminal software only after the safe update', (t) => {
  const m = machine(t, { herdr: false });
  m.clone();
  const target = m.publish();
  passed(m.run());
  assert.equal(m.git(m.dir, 'rev-parse', 'HEAD'), target);
  assert.equal(existsSync(join(m.home, '.local/bin/herdr')), true);
  assert.equal(m.calls().filter((c) => c.tool === 'curl').length, 1);
});

for (const problem of ['FAKE_CURL_FAIL', 'FAKE_CURL_EMPTY']) {
  test(`stops when terminal software installation fails (${problem})`, (t) => {
    const m = machine(t, { herdr: false });
    const result = m.run({ [problem]: '1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cannot install herdr|Cannot find herdr/);
    assert.equal(m.calls().some((c) => c.tool === 'npm' && c.args[0] === 'ci'), false);
  });
}

for (const problem of ['FAKE_CI_FAIL', 'FAKE_READER_FAIL', 'FAKE_BUILD_FAIL', 'FAKE_START_FAIL']) {
  test(`reports an installation failure (${problem})`, (t) => {
    const m = machine(t);
    const result = m.run({ [problem]: '1' });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /Helm is installed and active/);
    if (problem !== 'FAKE_START_FAIL') assert.equal(m.calls().some((c) => c.tool === 'node' && c.args[1] === 'start'), false);
  });
}

test('launcher preserves unusual paths and arguments without running path text', (t) => {
  const m = machine(t, { unusualPaths: true });
  passed(m.run());
  const args = ['status', 'space value', '\'"$HOME`touch INJECTED`$(touch INJECTED)'];
  const result = spawnSync(join(m.home, '.local/bin/helm'), args, { cwd: m.root, env: m.env, encoding: 'utf8' });
  passed(result);
  assert.deepEqual(m.calls().at(-1).args, [join(m.dir, 'packages/connect/bin/helm.js'), ...args]);
  assert.equal(existsSync(join(m.root, 'INJECTED')), false);
  assert.equal(readdirSync(m.root).some((name) => name.startsWith('INJECTED')), false);
});

test('launcher finds Node on PATH after the original Node moves', (t) => {
  const m = machine(t, { unusualPaths: true });
  passed(m.run());
  const replacement = join(m.root, 'replacement');
  mkdirSync(replacement);
  writeFileSync(join(replacement, 'node'), readFileSync(join(m.bin, 'node')));
  chmodSync(join(replacement, 'node'), 0o755);
  symlinkSync(bashBin, join(replacement, 'bash'));
  rmSync(join(m.bin, 'node'));
  const result = spawnSync(join(m.home, '.local/bin/helm'), ['status'], { cwd: m.root, env: { ...m.env, PATH: replacement }, encoding: 'utf8' });
  passed(result);
  assert.deepEqual(m.calls().at(-1).args, [join(m.dir, 'packages/connect/bin/helm.js'), 'status']);
});

test('relative install paths remain valid when the launcher runs elsewhere', (t) => {
  const m = machine(t);
  passed(m.run({ HELM_INSTALL_DIR: 'relative-install' }));
  const result = spawnSync(join(m.home, '.local/bin/helm'), ['status'], { cwd: m.home, env: m.env, encoding: 'utf8' });
  passed(result);
  assert.deepEqual(m.calls().at(-1).args, [resolve(m.root, 'relative-install/packages/connect/bin/helm.js'), 'status']);
});

for (const flag of ['--assume-unchanged', '--skip-worktree']) {
  test(`refuses tracked files hidden from Git status (${flag})`, (t) => {
    const m = machine(t, { herdr: false });
    m.clone();
    m.git(m.dir, 'update-index', flag, 'tracked.txt');
    m.put(m.dir, 'tracked.txt', 'keep hidden edit\n');
    const head = m.git(m.dir, 'rev-parse', 'HEAD');
    refused(m, m.run(), /hidden from Git status/);
    assert.equal(existsSync(join(m.dir, '.git/FETCH_HEAD')), false);
    assert.equal(m.git(m.dir, 'rev-parse', 'HEAD'), head);
    assert.equal(readFileSync(join(m.dir, 'tracked.txt'), 'utf8'), 'keep hidden edit\n');
  });
}


test('refuses a missing saved dependency list before installing software', (t) => {
  const m = machine(t, { herdr: false });
  m.git(m.source, 'rm', 'package-lock.json');
  m.git(m.source, 'commit', '--quiet', '-m', 'Remove dependency list');
  m.git(m.source, 'push', '--quiet', 'origin', 'main');
  refused(m, m.run(), /needs package.json and package-lock.json/);
});

test('stops a failed fetch before installing software', (t) => {
  const m = machine(t, { herdr: false });
  m.clone();
  const head = m.git(m.dir, 'rev-parse', 'HEAD');
  rmSync(m.remote, { recursive: true });
  refused(m, m.run(), /Cannot fetch branch/);
  assert.equal(m.git(m.dir, 'rev-parse', 'HEAD'), head);
});

test('refuses unsaved submodule edits even when local settings hide them', (t) => {
  const m = machine(t, { herdr: false });
  m.clone();
  const nested = join(m.dir, 'nested-repo');
  m.git(m.root, 'clone', '--quiet', m.env.HELM_REPO, nested);
  m.put(m.dir, '.gitmodules', `[submodule \"nested-repo\"]\n\tpath = nested-repo\n\turl = ${m.env.HELM_REPO}\n`);
  m.git(m.dir, 'add', '.gitmodules');
  m.git(m.dir, 'update-index', '--add', '--cacheinfo', `160000,${m.git(nested, 'rev-parse', 'HEAD')},nested-repo`);
  m.git(m.dir, 'commit', '--quiet', '-m', 'Add submodule');
  m.git(m.dir, 'config', 'submodule.nested-repo.ignore', 'all');
  m.put(join(m.dir, 'nested-repo'), 'tracked.txt', 'keep submodule edit\n');
  refused(m, m.run(), /Save your edits/);
  assert.equal(readFileSync(join(m.dir, 'nested-repo/tracked.txt'), 'utf8'), 'keep submodule edit\n');
});

test('failed update build leaves the working source and app unchanged', t => {
  const m = machine(t); m.clone();
  m.put(m.dir, 'apps/web/dist/index.html', 'working app');
  const before = m.git(m.dir, 'rev-parse', 'HEAD'); m.publish();
  const result = m.run({FAKE_BUILD_FAIL:'1'});
  assert.notEqual(result.status, 0);
  assert.equal(m.git(m.dir, 'rev-parse', 'HEAD'), before);
  assert.equal(readFileSync(join(m.dir, 'apps/web/dist/index.html'), 'utf8'), 'working app');
});
test('failed startup restores the previous source, app and launcher', t => {
  const m = machine(t); passed(m.run());
  const before = m.git(m.dir, 'rev-parse', 'HEAD');
  const launcher = readFileSync(join(m.home, '.local/bin/helm'), 'utf8');
  m.put(m.dir, 'apps/web/dist/index.html', 'working app'); m.publish();
  assert.notEqual(m.run({FAKE_START_FAIL:'1'}).status, 0);
  assert.equal(m.git(m.dir, 'rev-parse', 'HEAD'), before);
  assert.equal(readFileSync(join(m.dir, 'apps/web/dist/index.html'), 'utf8'), 'working app');
  assert.equal(readFileSync(join(m.home, '.local/bin/helm'), 'utf8'), launcher);
});


// Every wrapper forwards only to a real local file tool. No service command
// can escape the fixture PATH. Kill the installer after a completed file step.
function interruptTool(m, name, condition, { signal = true, edit = false } = {}) {
  const real = tool(name);
  rmSync(join(m.bin, name));
  writeFileSync(join(m.bin, name), `#!${process.execPath}
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
const hit = ${condition};
if (hit && process.env.INTERRUPT_INSTALL) {
  if (${!signal}) process.exit(74);
  const result = spawnSync(${JSON.stringify(real)}, args, {stdio:'inherit'});
  if (result.status !== 0) process.exit(result.status ?? 1);
  ${edit ? `fs.writeFileSync(${JSON.stringify(join(m.dir, 'tracked.txt'))}, 'owner edit after interruption');` : ''}
  process.kill(process.ppid, 'SIGKILL');
  process.exit(0);
}
const result = spawnSync(${JSON.stringify(real)}, args, {stdio:'inherit'});
process.exit(result.status ?? 1);
`);
  chmodSync(join(m.bin, name), 0o755);
}
function oldInstallation(m) {
  m.clone();
  m.put(m.dir, 'node_modules/example/index.js', 'old dependency');
  m.put(m.dir, 'apps/web/node_modules/keep/index.js', 'old workspace dependency');
  m.put(m.dir, 'apps/web/dist/index.html', 'old app');
  m.put(m.dir, 'native/log-index/log-index.old.node', 'old reader');
  return m.git(m.dir, 'rev-parse', 'HEAD');
}
function oldFiles(m) {
  assert.equal(readFileSync(join(m.dir, 'node_modules/example/index.js'), 'utf8'), 'old dependency');
  assert.equal(readFileSync(join(m.dir, 'apps/web/node_modules/keep/index.js'), 'utf8'), 'old workspace dependency');
  assert.equal(readFileSync(join(m.dir, 'apps/web/dist/index.html'), 'utf8'), 'old app');
  assert.equal(readFileSync(join(m.dir, 'native/log-index/log-index.old.node'), 'utf8'), 'old reader');
  assert.equal(existsSync(join(m.dir, 'native/log-index/log-index.test.node')), false);
}
for (const point of ['source', 'dependencies', 'app']) {
  test(`SIGKILL after ${point} publication recovers before another fetch or build`, t => {
    const m = machine(t); const before = oldInstallation(m); m.publish();
    if (point === 'source') interruptTool(m, 'git', `args.includes('merge') && args.includes(${JSON.stringify(m.dir)})`);
    else interruptTool(m, 'cp', `args.some(a => a.includes('.release.') && a.endsWith(${JSON.stringify(point === 'app' ? '/apps/web/dist' : '/node_modules')}))`);
    const killed = m.run({INTERRUPT_INSTALL:'1', FAKE_READER_OUTPUT:'1'});
    assert.equal(killed.signal, 'SIGKILL', killed.stdout + killed.stderr);
    assert.equal(existsSync(m.dir + '.install-state'), true);
    const callsBefore = m.calls().length;
    // Break the remote: recovery must happen before the next fetch fails.
    rmSync(m.remote, {recursive:true});
    const retry = m.run();
    assert.notEqual(retry.status, 0); assert.match(retry.stderr, /Cannot fetch/);
    assert.equal(m.git(m.dir, 'rev-parse', 'HEAD'), before); oldFiles(m);
    assert.equal(existsSync(m.dir + '.install-state'), false);
    assert.equal(m.calls().slice(callsBefore).some(c => c.tool === 'npm' && c.args[0] === 'ci'), false);
  });
}
test('SIGKILL recovery keeps owner edits and does not start another install', t => {
  const m = machine(t); const before = oldInstallation(m); const target = m.publish();
  interruptTool(m, 'cp', `args.some(a => a.includes('.release.') && a.endsWith('/apps/web/dist'))`, {edit:true});
  assert.equal(m.run({INTERRUPT_INSTALL:'1', FAKE_READER_OUTPUT:'1'}).signal, 'SIGKILL');
  const callsBefore = m.calls().length;
  const retry = m.run();
  assert.notEqual(retry.status, 0); assert.match(retry.stdout, /Kept your edits/);
  assert.equal(readFileSync(join(m.dir, 'tracked.txt'), 'utf8'), 'owner edit after interruption');
  assert.equal(m.git(m.dir, 'rev-parse', 'HEAD'), target);
  assert.notEqual(target, before); oldFiles(m);
  assert.equal(existsSync(m.dir + '.install-state'), true);
  assert.equal(m.calls().slice(callsBefore).some(c => c.tool === 'npm' && c.args[0] === 'ci'), false);
  // A second recovery attempt must retain the same files and edit.
  assert.notEqual(m.run().status, 0); oldFiles(m);
  assert.equal(readFileSync(join(m.dir, 'tracked.txt'), 'utf8'), 'owner edit after interruption');
});
test('a failed app copy preserves untouched workspace dependencies', t => {
  const m = machine(t); const before = oldInstallation(m); m.publish();
  interruptTool(m, 'cp', `args.some(a => a.includes('.release.') && a.endsWith('/apps/web/dist'))`, {signal:false});
  assert.notEqual(m.run({INTERRUPT_INSTALL:'1'}).status, 0);
  assert.equal(m.git(m.dir, 'rev-parse', 'HEAD'), before); oldFiles(m);
});
test('successful installation keeps the built chat reader', t => {
  const m = machine(t); passed(m.run({FAKE_READER_OUTPUT:'1'}));
  assert.equal(readFileSync(join(m.dir, 'native/log-index/log-index.test.node'), 'utf8'), 'new reader');
});

test('a failed backup copy leaves every installed file unchanged', t => {
  const m = machine(t); const before = oldInstallation(m); m.publish();
  interruptTool(m, 'cp', `args.some(a => a.endsWith('.install-state/files/1'))`, {signal:false});
  assert.notEqual(m.run({INTERRUPT_INSTALL:'1'}).status, 0);
  assert.equal(m.git(m.dir, 'rev-parse', 'HEAD'), before); oldFiles(m);
  assert.equal(existsSync(m.dir + '.install-state'), false);
});
test('SIGKILL during recovery keeps complete copies for a second recovery', t => {
  const m = machine(t); const before = oldInstallation(m); m.publish();
  interruptTool(m, 'cp', `args.some(a => a.includes('.release.') && a.endsWith('/apps/web/dist'))`);
  assert.equal(m.run({INTERRUPT_INSTALL:'1'}).signal, 'SIGKILL');
  interruptTool(m, 'cp', `args.some(a => a.endsWith('.install-state/files/1'))`);
  assert.equal(m.run({INTERRUPT_INSTALL:'1'}).signal, 'SIGKILL');
  assert.equal(existsSync(m.dir + '.install-state/files/1/index.html'), true);
  rmSync(m.remote, {recursive:true});
  assert.notEqual(m.run().status, 0);
  assert.equal(m.git(m.dir, 'rev-parse', 'HEAD'), before); oldFiles(m);
  assert.equal(existsSync(m.dir + '.install-state'), false);
});
for (const edit of ['staged', 'hidden']) {
  test(`SIGKILL recovery preserves ${edit} owner edits and their index state`, t => {
    const m = machine(t); oldInstallation(m); const target = m.publish();
    interruptTool(m, 'cp', `args.some(a => a.includes('.release.') && a.endsWith('/apps/web/dist'))`);
    assert.equal(m.run({INTERRUPT_INSTALL:'1'}).signal, 'SIGKILL');
    m.put(m.dir, 'tracked.txt', 'keep owner changes');
    if (edit === 'staged') m.git(m.dir, 'add', 'tracked.txt');
    else m.git(m.dir, 'update-index', '--assume-unchanged', 'tracked.txt');
    const status = m.git(m.dir, 'status', '--porcelain');
    const index = m.git(m.dir, 'ls-files', '-v');
    assert.notEqual(m.run().status, 0);
    assert.equal(readFileSync(join(m.dir, 'tracked.txt'), 'utf8'), 'keep owner changes');
    assert.equal(m.git(m.dir, 'rev-parse', 'HEAD'), target);
    assert.equal(m.git(m.dir, 'status', '--porcelain'), status);
    assert.equal(m.git(m.dir, 'ls-files', '-v'), index); oldFiles(m);
  });
}

test('interrupted installation never rewinds a branch the owner selected afterward', t => {
  const m = machine(t); oldInstallation(m); const target = m.publish();
  interruptTool(m, 'cp', `args.some(a => a.includes('.release.') && a.endsWith('/apps/web/dist'))`);
  assert.equal(m.run({INTERRUPT_INSTALL:'1'}).signal, 'SIGKILL');
  m.git(m.dir, 'checkout', '-qb', 'owner-choice');
  assert.notEqual(m.run().status, 0);
  assert.equal(m.git(m.dir, 'branch', '--show-current'), 'owner-choice');
  assert.equal(m.git(m.dir, 'rev-parse', 'HEAD'), target);
  assert.equal(existsSync(m.dir + '.install-state'), true);
});

test('the standalone installer retains a previous release that the updater can restore', t => {
  const m = machine(t);
  for (const name of ['update.js','release.js','service.js','network-recovery.js','paths.js','web-build.js']) {
    m.put(m.source, 'packages/connect/src/' + name, readFileSync(new URL('../packages/connect/src/' + name, import.meta.url)));
  }
  m.put(m.source, 'package.json', '{"name":"private-installer-fixture","type":"module"}');
  m.git(m.source, 'add', '.'); m.git(m.source, 'commit', '-qm', 'Include private updater'); m.git(m.source, 'push', '-q', 'origin', 'main');
  const before = oldInstallation(m); m.publish();
  passed(m.run({FAKE_READER_OUTPUT:'1'}));
  const saved = JSON.parse(readFileSync(join(m.env.HELM_DIR, 'previous-release.json')));
  assert.equal(saved.previousHead, before);
  assert.equal(m.git(m.dir, 'rev-parse', saved.ref), before);
  assert.equal(existsSync(m.dir + '.install-state'), false);
  const result = spawnSync(process.execPath, ['--input-type=module','-e',
    'const m=await import(process.argv[1]); await m.rollbackPreviousRelease(process.argv[2],{restart:false});',
    pathToFileURL(join(m.dir,'packages/connect/src/update.js')).href, m.dir], {env:m.env,encoding:'utf8'});
  passed(result); assert.equal(m.git(m.dir, 'rev-parse', 'HEAD'), before); oldFiles(m);
});
