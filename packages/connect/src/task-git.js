import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

function gitAt(directory) {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  Object.assign(environment, {
    GIT_DIR: join(directory, 'repo.git'), GIT_INDEX_FILE: join(directory, 'index'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Helm', GIT_AUTHOR_EMAIL: 'task@helm.local',
    GIT_COMMITTER_NAME: 'Helm', GIT_COMMITTER_EMAIL: 'task@helm.local',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  });
  return (args, input) => execFileSync('git', args, {
    env: environment, input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trimEnd();
}

export function taskCheckpoint(directory, snapshot, parent = null) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const git = gitAt(directory);
  if (!existsSync(join(directory, 'repo.git'))) git(['init', '--bare', '--quiet', '--object-format=sha1', join(directory, 'repo.git')]);
  const working = mkdtempSync(join(directory, 'tree-'));
  try {
    const files = [...snapshot.files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const paths = files.map((file) => {
      const path = resolve(working, file.path);
      if (!path.startsWith(`${working}${sep}`)) throw new Error('checkpoint path escaped its workspace');
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, Buffer.from(file.data, 'base64url'), { mode: 0o600, flag: 'wx' });
      return JSON.stringify(path);
    });
    const hashes = files.length ? git(['hash-object', '-w', '--stdin-paths', '--no-filters'], `${paths.join('\n')}\n`).split('\n') : [];
    git(['read-tree', '--empty']);
    if (files.length) git(['update-index', '-z', '--index-info'], files.map((file, index) =>
      `${file.mode === 0o755 ? '100755' : '100644'} ${hashes[index]}\t${file.path}\0`).join(''));
    const tree = git(['write-tree']);
    const commit = git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'Helm task checkpoint']);
    git(['update-ref', 'refs/heads/task', commit]);
    return commit;
  } finally { rmSync(working, { recursive: true, force: true }); }
}

export function checkpointChanges(directory, before, after) {
  return gitAt(directory)(['diff', '--name-only', '--no-renames', '-z', before, after, '--']).split('\0').filter(Boolean);
}
