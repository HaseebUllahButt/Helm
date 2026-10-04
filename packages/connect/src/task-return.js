import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const hash = (data) => createHash('sha256').update(data).digest('hex');
const fingerprint = (data, mode) => `${hash(data)}:${mode === 0o755 ? 'x' : '-'}`;

export const snapshotBaseline = (snapshot) => Object.assign(Object.create(null), Object.fromEntries(snapshot.files.map((file) => [
  file.path, fingerprint(Buffer.from(file.data, 'base64url'), file.mode),
])));

export const taskReturnDigest = (request) => hash(JSON.stringify({
  handoffId: request.handoffId, returnId: request.returnId,
  sourceMachineId: request.sourceMachineId, targetMachineId: request.targetMachineId,
  originalDigest: request.originalDigest, snapshotDigest: request.snapshotDigest,
  sessionId: request.sessionId, promptEnvelope: request.promptEnvelope,
  baseCommit: request.baseCommit, commit: request.commit,
}));

export function applyReturnedSnapshot(folder, baseline, snapshot, returnId, keepLocal = []) {
  const root = resolve(folder);
  baseline = Object.assign(Object.create(null), baseline);
  try {
    if (!lstatSync(root).isDirectory()) return { status: 'conflict', conflicts: ['.'], changed: 0 };
  } catch { return { status: 'conflict', conflicts: ['.'], changed: 0 }; }
  const returned = snapshotBaseline(snapshot);
  const files = new Map(snapshot.files.map((file) => [file.path, file]));
  const changes = [...new Set([...Object.keys(baseline), ...Object.keys(returned)])]
    .filter((path) => baseline[path] !== returned[path] && !keepLocal.includes(path));
  const localFile = (path) => {
    const absolute = resolve(root, path);
    if (!absolute.startsWith(`${root}${sep}`)) throw new Error('return path escaped the project');
    let parent = dirname(absolute);
    while (true) {
      try {
        const info = lstatSync(parent);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('return path has an unsafe parent');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    try {
      const info = lstatSync(absolute);
      if (!info.isFile() || info.isSymbolicLink()) return { absolute, fingerprint: 'non-regular' };
      if (info.size > 16 * 1024 * 1024) return { absolute, fingerprint: 'oversized' };
      return { absolute, fingerprint: fingerprint(readFileSync(absolute), info.mode & 0o111 ? 0o755 : 0o644) };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { absolute, fingerprint: undefined };
    }
  };
  const conflicts = [];
  for (const path of changes) {
    try {
      const local = localFile(path);
      if (local.fingerprint !== baseline[path] && local.fingerprint !== returned[path]) conflicts.push(path);
    } catch { conflicts.push(path); }
  }
  if (conflicts.length) return { status: 'conflict', conflicts, changed: 0 };
  let changed = 0;
  for (const path of changes) {
    const local = localFile(path);
    if (local.fingerprint === returned[path]) continue;
    if (local.fingerprint !== baseline[path]) return { status: 'conflict', conflicts: [path], changed };
    const file = files.get(path);
    if (file) {
      mkdirSync(dirname(local.absolute), { recursive: true });
      const temporary = join(dirname(local.absolute), `.helm-return-${returnId}-${randomBytes(6).toString('hex')}`);
      writeFileSync(temporary, Buffer.from(file.data, 'base64url'), {
        mode: file.secret ? 0o600 : file.mode === 0o755 ? 0o755 : 0o644, flag: 'wx',
      });
      try {
        if (localFile(path).fingerprint !== baseline[path]) return { status: 'conflict', conflicts: [path], changed };
        renameSync(temporary, local.absolute);
      } finally {
        try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    } else unlinkSync(local.absolute);
    changed++;
  }
  return { status: 'returned', conflicts: [], changed };
}
