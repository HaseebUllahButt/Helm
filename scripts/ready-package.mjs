import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const fail = message => { throw new Error(message); };
const hash = data => createHash('sha256').update(data).digest('hex');
function files(root, prefix = '') {
  const result = {};
  for (const name of readdirSync(join(root, prefix))) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const path = join(root, rel), stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail('Package files must not be links.');
    if (stat.isDirectory()) Object.assign(result, files(root, rel));
    else if (stat.isFile()) result[rel] = { bytes: stat.size, sha256: hash(readFileSync(path)) };
    else fail('Package files must be regular files.');
  }
  return result;
}
const inside = (parent, child) => child === parent || child.startsWith(`${parent}${sep}`);

/** No dependencies, account files, or native binaries travel in this package. */
export function pack(root, destination) {
  root = resolve(root); destination = resolve(destination);
  if (inside(root, destination)) fail('Save the package outside the source checkout.');
  if (existsSync(destination)) fail('Choose an empty package destination.');
  if (git(root, ['status', '--porcelain'])) fail('Commit or remove local changes before making a package.');
  const commit = git(root, ['rev-parse', 'HEAD']);
  const stamp = JSON.parse(readFileSync(join(root, 'apps/web/dist/build.json'), 'utf8'));
  if (stamp.commit !== commit || stamp.dirty !== false) fail('Build the app from the current clean commit first.');
  const stage = `${destination}.partial-${randomUUID()}`;
  mkdirSync(stage, { recursive: true });
  try {
    cpSync(join(root, 'apps/web/dist'), join(stage, 'web'), { recursive: true, dereference: false });
    git(root, ['bundle', 'create', join(stage, 'source.bundle'), 'HEAD']);
    const manifest = { format: 1, commit, node: '>=22', files: files(stage) };
    writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    validate(stage, root);
    renameSync(stage, destination);
    return manifest;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

/** Hashes detect damage, not an untrusted sender. Only accept an owner's package. */
export function validate(directory, root) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Choose a regular package folder.');
  const actual = files(directory);
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  if (manifest.format !== 1 || !/^[0-9a-f]{40}$/.test(manifest.commit) || manifest.node !== '>=22'
    || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) fail('The package description is not supported.');
  delete actual['package.json'];
  const expected = Object.keys(manifest.files).sort();
  if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(expected)) fail('The package file list does not match.');
  if (!actual['source.bundle'] || !actual['web/index.html'] || !actual['web/build.json']) fail('The package is incomplete.');
  for (const name of expected) {
    if (name !== 'source.bundle' && !name.startsWith('web/')) fail('The package contains an unexpected file.');
    const entry = manifest.files[name];
    if (actual[name].bytes !== entry?.bytes || actual[name].sha256 !== entry?.sha256) fail(`The package file changed: ${name}`);
  }
  const html = readFileSync(join(directory, 'web/index.html'), 'utf8');
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    const url = new URL(match[1], 'https://package.invalid/');
    if (url.origin !== 'https://package.invalid' || !url.pathname.startsWith('/assets/')) continue;
    if (!actual[`web${decodeURIComponent(url.pathname)}`]) fail('The built app refers to a missing asset.');
  }
  const stamp = JSON.parse(readFileSync(join(directory, 'web/build.json'), 'utf8'));
  if (stamp.commit !== manifest.commit || stamp.dirty !== false) fail('The built app does not match the package source.');
  const bundle = resolve(directory, 'source.bundle');
  git(root, ['bundle', 'verify', bundle]);
  if (git(root, ['bundle', 'list-heads', bundle]) !== `${manifest.commit} HEAD`) fail('The source version does not match the package.');
  return manifest;
}

/** Replace only the built app. Keep source, dependencies and machine state local. */
export function receive(directory, root) {
  root = resolve(root); directory = resolve(directory);
  if (inside(join(root, 'apps/web/dist'), directory)) fail('Keep the package outside the built app folder.');
  if (Number(process.versions.node.split('.')[0]) < 22) fail('Use Node.js 22 or newer.');
  const manifest = validate(directory, root);
  if (git(root, ['status', '--porcelain'])) fail('Save local changes before receiving a built app.');
  if (git(root, ['rev-parse', 'HEAD']) !== manifest.commit) fail('Update the source to the package commit through Helm first.');
  const target = join(root, 'apps/web/dist');
  const stage = `${target}.partial-${randomUUID()}`, backup = `${target}.backup-${randomUUID()}`;
  mkdirSync(dirname(target), { recursive: true });
  try {
    cpSync(join(directory, 'web'), stage, { recursive: true });
    // Recheck the staged bytes, so a changed copy cannot reach the served app.
    const staged = files(stage);
    for (const [name, entry] of Object.entries(manifest.files).filter(([name]) => name.startsWith('web/'))) {
      const got = staged[name.slice(4)];
      if (got?.sha256 !== entry.sha256 || got?.bytes !== entry.bytes) fail('The package changed while it was copied.');
      delete staged[name.slice(4)];
    }
    if (Object.keys(staged).length) fail('The package changed while it was copied.');
    if (existsSync(target)) renameSync(target, backup);
    try { renameSync(stage, target); }
    catch (error) { if (existsSync(backup)) renameSync(backup, target); throw error; }
    rmSync(backup, { recursive: true, force: true });
    return manifest;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, folder, machine, target] = process.argv.slice(2);
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    if (!folder || !['pack', 'check', 'receive', 'send'].includes(action)) fail('Use: node scripts/ready-package.mjs pack|check|receive <folder>, or send <folder> <machine> <destination>.');
    if (action === 'pack') pack(root, folder);
    else if (action === 'receive') receive(folder, root);
    else {
      validate(folder, root);
      if (action === 'send') {
        if (!machine || !target || machine.startsWith('-')) fail('Name the machine and destination folder.');
        const result = spawnSync('helm', ['copy', machine, resolve(folder), '--target-folder', target], { stdio: 'inherit' });
        if (result.error || result.status !== 0) fail('Helm could not complete the package copy. Check its transfer before trying again.');
      }
    }
    console.log(action === 'receive' ? 'The checked app is ready. Reload Helm.' : 'The package check passed.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
