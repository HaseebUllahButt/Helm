import {
  accessSync, closeSync, constants as fsConstants, fstatSync, lstatSync,
  openSync, readSync, statSync,
} from 'node:fs';
import { open as aOpen, lstat as aLstat, readdir as aReaddir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { expand } from './paths.js';

const ENV_NAME = /^\.env(?:\..+)?$/i;
const RISKY_REASONS = new Set(['secret-name', 'secret-dir', 'symlink', 'special']);
const GENERATED_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', '.cache', '__pycache__',
  'target', 'dist', 'build', '.next', '.turbo', 'coverage', '.venv',
  '.idea', '.vscode', '.helm',
]);
const SECRET_DIR = /^(?:\.ssh|\.aws|\.azure|\.config|\.docker|\.kube|\.gnupg|\.terraform)$/i;
const GENERATED_MESSAGES = new Map([
  ['node_modules', 'dependencies are not transferred; install them on the target'],
  ['.venv', 'the python environment is not transferred; recreate it on the target'],
  ['build', 'build output is not transferred; rebuild it on the target'],
  ['dist', 'build output is not transferred; rebuild it on the target'],
  ['.next', 'build output is not transferred; rebuild it on the target'],
  ['target', 'build output is not transferred; rebuild it on the target'],
  ['.git', 'git history stays on the source; origin is configured on the target when available'],
]);

const MAX_WALK_ENTRIES = 20_000;
const MAX_MANIFESTS = 64;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_MARKER_BYTES = 64 * 1024;
const MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const LOCKFILES = new Map([
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
]);
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const MIN_NODE_MAJOR = /^>=(\d+)(?:\.0(?:\.0)?)?$/;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function transferPreflight(snapshot) {
  const files = Array.isArray(snapshot?.files) ? snapshot.files : [];
  const skippedEntries = Array.isArray(snapshot?.skippedEntries) ? snapshot.skippedEntries : [];
  const skipped = Number.isInteger(snapshot?.skipped) ? snapshot.skipped : skippedEntries.length;
  const omittedEntries = Math.max(0, skipped - skippedEntries.length);
  const envFiles = files
    .filter((f) => f && typeof f.path === 'string' && ENV_NAME.test(basename(f.path)))
    .map((f) => f.path);

  const warnings = [];
  for (const entry of skippedEntries) {
    const path = typeof entry?.path === 'string' ? entry.path : undefined;
    const name = basename(path ?? '');
    switch (entry?.reason) {
      case 'secret-name':
        warnings.push(ENV_NAME.test(name)
          ? { code: 'env-omitted', path, message: 'a .env file stayed on the source; re-run with --include-env to carry it' }
          : { code: 'secret-omitted', path, message: 'a sensitive-named file stayed on the source' });
        break;
      case 'secret-dir':
        warnings.push({
          code: 'secret-dir-omitted', path,
          message: "a sensitive directory's contents stayed on the source, except .env files explicitly included",
        });
        break;
      case 'symlink':
        warnings.push({ code: 'symlink-omitted', path, message: 'a symlink stayed on the source; its target was not followed' });
        break;
      case 'special':
        warnings.push({ code: 'special-omitted', path, message: 'a file that is not a regular file stayed on the source' });
        break;
      case 'generated':
        warnings.push(GENERATED_MESSAGES.has(name)
          ? { code: 'generated-setup', path, message: GENERATED_MESSAGES.get(name) }
          : { code: 'generated-omitted', path, message: 'a generated or tool directory stayed on the source' });
        break;
      default:
        break;
    }
  }
  if (omittedEntries > 0) {
    warnings.push({
      code: 'manifest-truncated',
      message: `${plural(omittedEntries, 'more omitted entry')} could not be listed`,
    });
  }
  warnings.push({
    code: 'filename-policy',
    message: 'what is left behind is decided by filename policy, not file contents; application dependencies and configuration are not validated',
  });

  return {
    files: files.length,
    bytes: Number.isFinite(snapshot?.bytes) ? snapshot.bytes : 0,
    envFiles,
    skipped,
    skippedEntries,
    omittedEntries,
    warnings,
    requiresAcknowledgement: omittedEntries > 0
      || skippedEntries.some((e) => RISKY_REASONS.has(e?.reason)),
  };
}

const onPath = (name, envPath) => {
  const dirs = String(envPath || '').split(process.platform === 'win32' ? ';' : ':');
  const names = process.platform === 'win32'
    ? [name, `${name}.exe`, `${name}.cmd`, `${name}.ps1`]
    : [name];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const candidate of names) {
      const file = join(dir, candidate);
      try {
        if (!statSync(file).isFile()) continue;
        accessSync(file, fsConstants.X_OK);
        return true;
      } catch {
      }
    }
  }
  return false;
};

const readBounded = async (file, max) => {
  let handle;
  try {
    handle = await aOpen(file, OPEN_FLAGS);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max) return null;
    const buffer = Buffer.alloc(max + 1);
    const { bytesRead } = await handle.read(buffer, 0, max + 1, 0);
    if (bytesRead > max) return null;
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
};

const readBoundedSync = (file, max) => {
  let fd;
  try {
    fd = openSync(file, OPEN_FLAGS);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > max) return null;
    const buffer = Buffer.alloc(max + 1);
    const read = readSync(fd, buffer, 0, max + 1, 0);
    if (read > max) return null;
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {
      }
    }
  }
};

const SETUP_CODES = new Set([
  'manifest-unreadable', 'manifest-config', 'missing-dependencies',
  'missing-package-manager', 'conflicting-lockfiles', 'conflicting-managers',
  'manager-lock-conflict', 'unsupported-manager', 'manager-version-unchecked',
  'setup-not-checked', 'skipped-sensitive', 'skipped-manifest-incomplete',
  'inspection-incomplete',
]);

export function readHandoffSkipped(folder) {
  try {
    const base = resolve(expand(String(folder || '')));
    if (lstatSync(join(base, '.helm')).isSymbolicLink()) return null;
    const text = readBoundedSync(join(base, '.helm', 'handoff.json'), MAX_MARKER_BYTES);
    if (text === null) return null;
    const marker = JSON.parse(text);
    if (!marker || typeof marker !== 'object') return { malformed: true };
    return {
      skipped: Number.isInteger(marker.skipped) ? marker.skipped : 0,
      skippedEntries: Array.isArray(marker.skippedEntries)
        ? marker.skippedEntries.filter(
          (e) => e && typeof e.path === 'string' && typeof e.reason === 'string')
        : [],
      malformed: false,
    };
  } catch (err) {
    return err?.code === 'ENOENT' ? null : { malformed: true };
  }
}

export async function inspectTransferReadiness(folder, {
  skippedEntries = [], skipped = 0, nodeVersion = process.versions.node,
  envPath = process.env.PATH,
} = {}) {
  const checks = [];
  const root = resolve(expand(String(folder || '')));
  const stat = await aLstat(root).catch(() => null);
  if (!stat) {
    return {
      status: 'needs-setup', verified: false,
      checks: [
        { code: 'folder-unreadable', status: 'fail', path: root, message: 'the folder could not be read' },
        RUNTIME_NOT_VERIFIED,
      ],
    };
  }
  if (stat.isSymbolicLink()) {
    return {
      status: 'needs-setup', verified: false,
      checks: [
        { code: 'folder-symlink', status: 'fail', path: root, message: 'the folder is a symlink; it was not inspected' },
        RUNTIME_NOT_VERIFIED,
      ],
    };
  }
  if (!stat.isDirectory()) {
    return {
      status: 'needs-setup', verified: false,
      checks: [
        { code: 'folder-not-directory', status: 'fail', path: root, message: 'the path is not a directory' },
        RUNTIME_NOT_VERIFIED,
      ],
    };
  }

  const manifests = [];
  const markers = new Set();
  const lockManagers = new Set();
  let walked = 0;
  let walkTruncated = false;
  let walkUnreadable = false;
  let manifestOverflow = false;
  const visit = async (dir) => {
    if (walked >= MAX_WALK_ENTRIES) { walkTruncated = true; return; }
    let dirents;
    try { dirents = await aReaddir(dir, { withFileTypes: true }); }
    catch { walkUnreadable = true; return; }
    for (const entry of dirents) {
      if (walked >= MAX_WALK_ENTRIES) { walkTruncated = true; return; }
      walked += 1;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (GENERATED_DIRS.has(entry.name) || SECRET_DIR.test(entry.name)) continue;
        await visit(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === 'package.json') {
        if (manifests.length < MAX_MANIFESTS) {
          manifests.push(join(dir, entry.name));
        } else {
          manifestOverflow = true;
        }
      } else if (dir === root && (entry.name === 'requirements.txt' || entry.name === 'pyproject.toml')) {
        markers.add('python');
      } else if (dir === root && entry.name === 'Cargo.toml') {
        markers.add('cargo');
      } else if (LOCKFILES.has(entry.name)) {
        lockManagers.add(LOCKFILES.get(entry.name));
      }
    }
  };
  await visit(root);
  if (walkUnreadable) {
    checks.push({ code: 'inspection-incomplete', status: 'warning', message: 'a directory could not be read; the inspection is incomplete' });
  }
  if (walkTruncated) {
    checks.push({ code: 'inspection-incomplete', status: 'warning', message: 'the folder has more entries than were inspected; the inspection is incomplete' });
  }
  if (manifestOverflow) {
    checks.push({ code: 'inspection-incomplete', status: 'warning', message: 'more package.json manifests exist than were inspected; the inspection is incomplete' });
  }

  manifests.sort((a, b) => (a === join(root, 'package.json') ? -1
    : b === join(root, 'package.json') ? 1
      : a.localeCompare(b)));

  let hasDependencies = false;
  let missingNodeModules = false;
  let rootDeclared = null;
  const declaredManagers = [];
  let unknownDeclared = false;
  let versionDeclared = false;
  for (const file of manifests) {
    const text = await readBounded(file, MAX_MANIFEST_BYTES);
    if (text === null) {
      checks.push({ code: 'manifest-unreadable', status: 'warning', path: file, message: 'a package.json could not be read' });
      continue;
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      checks.push({ code: 'manifest-unreadable', status: 'warning', path: file, message: 'a package.json could not be parsed' });
      continue;
    }
    let badDeclaration = false;
    let manifestDeps = false;
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      if (!Object.hasOwn(parsed, key)) continue;
      const value = parsed[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (Object.keys(value).length > 0) manifestDeps = true;
      } else {
        badDeclaration = true;
      }
    }
    if (badDeclaration) {
      checks.push({ code: 'manifest-config', status: 'warning', path: file, message: 'a dependency declaration in a manifest is not an object' });
    }
    if (manifestDeps) {
      hasDependencies = true;
      const here = await aLstat(join(dirname(file), 'node_modules')).catch(() => null);
      const atRoot = await aLstat(join(root, 'node_modules')).catch(() => null);
      if (!here?.isDirectory() && !atRoot?.isDirectory()) missingNodeModules = true;
    }
    const engines = parsed.engines;
    if (engines && typeof engines === 'object' && typeof engines.node === 'string') {
      const min = engines.node.trim().match(MIN_NODE_MAJOR);
      if (!min) {
        checks.push({ code: 'node-version-unverified', status: 'warning', path: file, message: 'the declared node version range is not a plain >= range; the node version was not verified' });
      } else {
        const need = Number(min[1]);
        const have = Number(String(nodeVersion).replace(/^v/, '').split('.')[0]);
        checks.push(need <= have
          ? { code: 'node-version', status: 'pass', path: file, message: `the declared node minimum is satisfied by node ${nodeVersion}` }
          : { code: 'node-version', status: 'fail', path: file, message: `this project needs a newer node than ${nodeVersion}` });
      }
    }
    if (typeof parsed.packageManager === 'string') {
      const name = parsed.packageManager.split('@')[0];
      if (MANAGERS.has(name)) {
        if (file === join(root, 'package.json')) rootDeclared = name;
        declaredManagers.push(name);
        if (parsed.packageManager.slice(name.length).startsWith('@')
            && parsed.packageManager.slice(name.length + 1).length > 0) {
          versionDeclared = true;
        }
      } else {
        unknownDeclared = true;
      }
    }
  }

  if (hasDependencies) {
    checks.push(missingNodeModules
      ? { code: 'missing-dependencies', status: 'warning', message: 'dependencies are declared but no node_modules exists; install them on the target' }
      : { code: 'dependencies-present', status: 'pass', message: 'a node_modules directory is present; its contents are not validated' });
  }
  if (new Set(declaredManagers).size > 1) {
    checks.push({ code: 'conflicting-managers', status: 'warning', message: 'manifests declare different package managers' });
  }
  const declared = rootDeclared ?? declaredManagers[0] ?? null;
  if (lockManagers.size > 1) {
    checks.push({ code: 'conflicting-lockfiles', status: 'warning', message: 'lockfiles for more than one package manager are present' });
  } else if (declared && lockManagers.size === 1 && !lockManagers.has(declared)) {
    checks.push({ code: 'manager-lock-conflict', status: 'warning', message: 'the declared package manager conflicts with the lockfile' });
  }
  if (unknownDeclared) {
    checks.push({ code: 'unsupported-manager', status: 'warning', message: 'a declared package manager is not supported; its availability was not checked' });
  }
  if (versionDeclared) {
    checks.push({ code: 'manager-version-unchecked', status: 'warning', message: 'the declared package manager version was not checked' });
  }
  const manager = declared ?? (lockManagers.size === 1 ? [...lockManagers][0] : null)
    ?? (unknownDeclared ? null : 'npm');
  if (manager && (hasDependencies || manifests.length)) {
    checks.push(onPath(manager, envPath)
      ? { code: 'package-manager', status: 'pass', message: `the package manager '${manager}' is on PATH` }
      : { code: 'missing-package-manager', status: 'warning', message: `the package manager '${manager}' is not on PATH; install it before installing dependencies` });
  }
  for (const marker of markers) {
    checks.push({
      code: 'setup-not-checked', status: 'warning',
      message: marker === 'python'
        ? 'a python project was found; its environment setup is not checked'
        : 'a rust project was found; its build setup is not checked',
    });
  }

  for (const entry of skippedEntries) {
    if (!RISKY_REASONS.has(entry?.reason)) continue;
    checks.push({
      code: 'skipped-sensitive', status: 'warning',
      path: typeof entry.path === 'string' ? entry.path : undefined,
      message: 'a file stayed on the source; whatever it configured is unresolved',
    });
  }
  if (skipped > skippedEntries.length) {
    checks.push({
      code: 'skipped-manifest-incomplete', status: 'warning',
      message: 'the skipped manifest was truncated; some omissions are not listed',
    });
  }
  checks.push(RUNTIME_NOT_VERIFIED);

  const needsSetup = checks.some((c) => c.status === 'fail'
    || (c.status === 'warning' && SETUP_CODES.has(c.code)));
  return { status: needsSetup ? 'needs-setup' : 'unverified', checks, verified: false };
}

const RUNTIME_NOT_VERIFIED = {
  code: 'runtime-not-verified', status: 'warning',
  message: 'nothing was executed; application runtime, databases, services and environment portability are not verified',
};

export function preflightLines(preflight) {
  const lines = [
    `  ${plural(preflight.files, 'file')} (${preflight.bytes} bytes)` +
      (preflight.envFiles.length ? `, ${plural(preflight.envFiles.length, '.env file')}` : '') +
      (preflight.skipped ? `, ${plural(preflight.skipped, 'entry')} stays behind` : ''),
  ];
  for (const w of preflight.warnings) {
    lines.push(`  - ${w.message}${w.path ? ` (${JSON.stringify(w.path)})` : ''}`);
  }
  return lines;
}

export function readinessLines(readiness) {
  const lines = [`  target readiness: ${readiness.status}`];
  for (const c of readiness.checks) {
    lines.push(`  [${c.status}] ${c.message}${c.path ? ` (${JSON.stringify(c.path)})` : ''}`);
  }
  return lines;
}
