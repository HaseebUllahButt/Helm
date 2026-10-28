import { cpSync, lstatSync, realpathSync, readlinkSync, readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, sep, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const fail = message => { throw new Error(message); };
const run = (file, args, cwd) => execFileSync(file, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = (root, args) => run('git', ['-C', root, ...args]);
const inside = (root, path) => path === root || path.startsWith(root + sep);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function inventory(root, prefix = '') {
  const entries = {};
  for (const name of readdirSync(join(root, prefix)).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (path === 'artifact.json') continue;
    const full = join(root, path), stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(full);
      if (isAbsolute(link) || !inside(realpathSync(root), realpathSync(full))) fail(`Package links must stay inside the package: ${path} -> ${link}`);
      entries[path] = { link };
    } else if (stat.isDirectory()) Object.assign(entries, inventory(root, path));
    else if (stat.isFile()) entries[path] = { bytes: stat.size, sha256: digest(readFileSync(full)), mode: stat.mode & 0o777 };
    else fail('The package contains a special file.');
  }
  return entries;
}

export function checkLinuxPackage(folder) {
  folder = realpathSync(folder);
  const manifest = JSON.parse(readFileSync(join(folder, 'artifact.json'), 'utf8'));
  if (manifest.format !== 1 || manifest.kind !== 'linux-x64-source-runtime' || manifest.node !== 'v22.23.3'
    || !/^[0-9a-f]{40}$/.test(manifest.commit)) fail('The Linux package description is not supported.');
  const actual = inventory(folder);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) fail('The Linux package files changed.');
  for (const path of ['bin/node', 'bin/herdr', 'bin/helm', 'app/apps/web/dist/index.html', 'app/apps/web/dist/build.json', 'app/package-lock.json']) {
    if (!actual[path]?.sha256) fail('The Linux package is incomplete.');
  }
  const stamp = JSON.parse(readFileSync(join(folder, 'app/apps/web/dist/build.json'), 'utf8'));
  if (stamp.commit !== manifest.commit || stamp.dirty !== false) fail('The built app does not match the Linux package.');
  if (git(join(folder, 'app'), ['rev-parse', 'HEAD']) !== manifest.commit) fail('The Linux package source does not match.');
  return manifest;
}

function copyDependencies(source, target) {
  mkdirSync(target, { recursive: true });
  mkdirSync(join(target, '.bin'));
  const copy = (name) => {
    const from = realpathSync(join(source, name)), to = join(target, name);
    cpSync(from, to, { recursive: true, dereference: false, verbatimSymlinks: true });
    const pkg = JSON.parse(readFileSync(join(to, 'package.json'), 'utf8'));
    const bins = typeof pkg.bin === 'string' ? { [pkg.name.split('/').at(-1)]: pkg.bin } : pkg.bin ?? {};
    for (const [name, file] of Object.entries(bins)) {
      const link = join(target, '.bin', name);
      if (!existsSync(link)) symlinkSync(relative(dirname(link), resolve(to, file)), link);
    }
  };
  for (const name of readdirSync(source)) {
    if (name.startsWith('.')) continue;
    if (name === '@helm') {
      mkdirSync(join(target, name));
      for (const workspace of ['connect', 'protocol', 'usage']) symlinkSync(`../../packages/${workspace}`, join(target, name, workspace));
      for (const workspace of ['relay', 'web']) symlinkSync(`../../apps/${workspace}`, join(target, name, workspace));
    } else if (name.startsWith('@')) {
      mkdirSync(join(target, name));
      for (const child of readdirSync(join(source, name))) copy(`${name}/${child}`);
    } else copy(name);
  }
}

/** Use installed files only. Never install packages or build inside a project copy. */
export function createLinuxPackage({ source, destination, node, herdr }) {
  if (process.platform !== 'linux' || process.arch !== 'x64') fail('Build this package only on Linux x86_64.');
  source = realpathSync(source); destination = resolve(destination); node = realpathSync(node); herdr = realpathSync(herdr);
  if (inside(source, destination) || existsSync(destination)) fail('Choose a new package folder outside the checkout.');
  const version = run(node, ['--version']);
  if (version !== 'v22.23.3') fail('Use Node.js 22.23.3 for this Linux package.');
  const herdrVersion = run(herdr, ['--version']);
  if (herdrVersion !== 'herdr 0.9.1') fail('Use herdr 0.9.1 for this Linux package.');
  const nodeLicense = join(dirname(dirname(node)), 'LICENSE');
  if (!existsSync(nodeLicense)) fail('Keep the Node.js license beside its installed bin folder.');
  const commit = git(source, ['rev-parse', 'HEAD']);
  const stamp = JSON.parse(readFileSync(join(source, 'apps/web/dist/build.json'), 'utf8'));
  if (stamp.commit !== commit || stamp.dirty !== false) fail('Build the app from the current committed source first.');
  const stage = `${destination}.partial-${randomUUID()}`;
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  try {
    git(source, ['bundle', 'create', join(stage, 'source.bundle'), 'HEAD']);
    run('git', ['clone', '-q', join(stage, 'source.bundle'), join(stage, 'app')]);
    git(join(stage, 'app'), ['remote', 'remove', 'origin']);
    copyDependencies(realpathSync(join(source, 'node_modules')), join(stage, 'app/node_modules'));
    cpSync(join(source, 'apps/web/dist'), join(stage, 'app/apps/web/dist'), { recursive: true });
    mkdirSync(join(stage, 'licenses'));
    cpSync(nodeLicense, join(stage, 'licenses/node.txt'));
    mkdirSync(join(stage, 'bin'));
    cpSync(node, join(stage, 'bin/node')); cpSync(herdr, join(stage, 'bin/herdr'));
    writeFileSync(join(stage, 'bin/helm'), `#!/bin/sh\nset -eu\nPACKAGE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexport PATH="$PACKAGE_ROOT/bin:$PATH"\nexport HELM_HERDR_BIN="$PACKAGE_ROOT/bin/herdr"\nexec "$PACKAGE_ROOT/bin/node" "$PACKAGE_ROOT/app/packages/connect/bin/helm.js" "$@"\n`, { mode: 0o755 });
    run(join(stage, 'bin/node'), ['--input-type=module', '-e', `await import('@homebridge/node-pty-prebuilt-multiarch'); await import('node-datachannel');`], join(stage, 'app'));
    const host = JSON.parse(run(node, ['-p', 'JSON.stringify(process.report.getReport().header)']));
    const manifest = { format: 1, kind: 'linux-x64-source-runtime', commit, node: version,
      herdr: herdrVersion, system: { platform: 'linux', arch: 'x64', glibc: host.glibcVersionRuntime }, files: inventory(stage) };
    writeFileSync(join(stage, 'artifact.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    checkLinuxPackage(stage);
    renameSync(stage, destination);
    return manifest;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, folder, node, herdr] = process.argv.slice(2);
    if (action === 'check' && folder) checkLinuxPackage(folder);
    else if (action === 'send' && folder && node && herdr && !node.startsWith('-')) {
      checkLinuxPackage(folder);
      execFileSync('helm', ['copy', node, realpathSync(folder), '--target-folder', herdr], { stdio: 'inherit' });
    }
    else if (action === 'create' && folder && node && herdr) createLinuxPackage({ source: resolve(dirname(fileURLToPath(import.meta.url)), '..'), destination: folder, node, herdr });
    else fail('Use: node scripts/linux-package.mjs create <folder> <node-binary> <herdr-binary>, check <folder>, or send <folder> <machine> <destination>.');
    console.log('The Linux package check passed.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
