import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
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
  return (args, input, stdin = 'pipe') => execFileSync('git', args, {
    env: environment, input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60_000,
    stdio: [stdin, 'pipe', 'pipe'],
  }).trimEnd();
}

export function taskCheckpoint(directory, snapshot, parent = null) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const git = gitAt(directory);
  if (!existsSync(join(directory, 'repo.git'))) git(['init', '--bare', '--quiet', '--object-format=sha1', join(directory, 'repo.git')]);
  const ancestor = parent ? git(['rev-parse', '--verify', '--end-of-options', `${parent}^{commit}`]) : null;
  const working = mkdtempSync(join(directory, 'input-'));
  let fd;
  try {
    const files = [...snapshot.files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const paths = new Set();
    for (const file of files) {
      const path = resolve(working, file.path);
      if (!path.startsWith(`${working}${sep}`)) throw new Error('checkpoint path escaped its workspace');
      if (paths.has(path)) throw new Error('Checkpoint repeats a file path.');
      paths.add(path);
    }
    for (const path of paths) {
      for (let parent = dirname(path); parent !== working; parent = dirname(parent)) {
        if (paths.has(parent)) throw new Error('Checkpoint uses one path as a file and a folder.');
      }
    }
    // One private input file replaces thousands of temporary project files.
    // Its descriptor lets Git read large snapshots without another whole copy
    // in JavaScript memory. Git still writes every object and commit itself.
    const input = join(working, 'commands');
    fd = openSync(input, 'wx', 0o600);
    const write = value => {
      const bytes = typeof value === 'string' ? Buffer.from(value) : value;
      for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset);
    };
    write('feature done\n');
    for (let index = 0; index < files.length; index++) {
      const bytes = Buffer.from(files[index].data, 'base64url');
      write(`blob\nmark :${index + 1}\ndata ${bytes.length}\n`);
      write(bytes); write('\n');
    }
    const mark = files.length + 1;
    // These bytes match commit-tree's fixed identity, date and message.
    write(`commit refs/heads/task\nmark :${mark}\nauthor Helm <task@helm.local> 946684800 +0000\ncommitter Helm <task@helm.local> 946684800 +0000\ndata 21\nHelm task checkpoint\n`);
    if (ancestor) write(`from ${ancestor}\n`);
    write('deleteall\n');
    files.forEach((file, index) => write(`M ${file.mode === 0o755 ? '100755' : '100644'} :${index + 1} ${JSON.stringify(file.path)}\n`));
    write(`\nget-mark :${mark}\ndone\n`);
    closeSync(fd); fd = undefined;
    fd = openSync(input, 'r');
    return git(['fast-import', '--quiet', '--force'], undefined, fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(working, { recursive: true, force: true });
  }
}

export function checkpointChanges(directory, before, after) {
  return gitAt(directory)(['diff', '--name-only', '--no-renames', '-z', before, after, '--']).split('\0').filter(Boolean);
}
