import { existsSync, lstatSync, mkdirSync, renameSync, writeFileSync, copyFileSync, constants, realpathSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { HELM_DIR } from './paths.js';
import { records, saveRecord, syncDirectory } from './send-journal.js';
import { createHash } from 'node:crypto';

const ID = /^[a-f0-9]{24}$/;
const digest = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
export const sendReceiptDigest = receipt => digest({ jobId: receipt.jobId, folder: receipt.folder, at: receipt.at, sourceMachineId: receipt.sourceMachineId, intentDigest: receipt.intentDigest });
const present = path => { try { lstatSync(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };

/** Receiver reservation/publication is part of the existing signed copy handshake. */
export class SendReceiver {
  constructor({ directory = join(HELM_DIR, 'received-sends'), home = homedir() } = {}) {
    this.directory = directory; this.home = home; this.active = new Map();
    this.jobs = new Map(records(directory).map(r => [r.id, r]));
    // Complete a rename whose receipt write was interrupted, without re-copying.
    for (const r of this.jobs.values()) {
      if (r.phase === 'publishing' && present(r.destination) && ((r.meta.kind === 'folder' && r.meta.again) || !present(r.meta.kind === 'file' ? join(r.stage, r.meta.name) : r.stage))) { r.phase = 'done'; saveRecord(this.file(r.id), r); }
    }
  }
  file(id) { return join(this.directory, `${id}.json`); }
  path(path) {
    if (typeof path !== 'string' || !path || /[\x00-\x1f\x7f]/.test(path)) throw new Error('invalid send destination');
    if (path === '~' || path.startsWith('~/')) path = join(this.home, path.slice(1));
    if (!path.startsWith('/')) throw new Error('send destination must start with / or ~/');
    path = resolve(path);
    if (path === '/' || path === this.home) throw new Error('choose a folder or file below home, not home itself');
    mkdirSync(dirname(path), { recursive: true });
    // Resolve parent aliases before reserving; never follow a destination symlink.
    return join(realpathSync(dirname(path)), basename(path));
  }
  begin(meta, caller, copyFolder) {
    if (!ID.test(meta?.id ?? '') || !['folder', 'file'].includes(meta.kind) || typeof meta.again !== 'boolean') throw new Error('invalid send intent');
    if (meta.marker && (!ID.test(meta.marker.handoffId ?? '') || typeof meta.marker.body !== 'string' || Buffer.byteLength(meta.marker.body) > 4096)) throw new Error('invalid task marker');
    if (typeof meta.name !== 'string' || !meta.name || basename(meta.name) !== meta.name || ['.', '..'].includes(meta.name)) throw new Error('invalid source name');
    const fingerprint = digest({ ...meta, source: caller });
    let r = this.jobs.get(meta.id);
    if (r && r.fingerprint !== fingerprint) throw new Error('send retry does not match its original intent');
    if (this.active.has(meta.id)) throw new Error('this send is already active');
    if (!r) {
      let destination = this.path(meta.destination);
      const stage = this.path(copyFolder);
      const expected = meta.kind === 'folder' && meta.again ? destination : `${destination}.helm-partial-${meta.id}`;
      if (stage !== expected) throw new Error('send staging path does not match its intent');
      if (!meta.again && present(destination)) {
        if (!meta.defaultDestination) throw new Error('destination already exists; choose another path');
        destination += `-${meta.id.slice(0, 8)}`;
        if (present(destination)) throw new Error('destination already exists; choose another path');
      }
      if (meta.again && (!present(destination) || lstatSync(destination).isSymbolicLink())) throw new Error('previous send destination is missing or is a symlink');
      r = { id: meta.id, source: caller, fingerprint, destination, stage, meta, phase: 'receiving', receipt: null };
    }
    for (const [id, active] of this.active) if (id !== meta.id && active.destination === r.destination) throw new Error('another send is using this destination; retry when it finishes');
    // Interrupted jobs own their private stage, but not the destination lock.
    if (present(r.stage) && lstatSync(r.stage).isSymbolicLink()) throw new Error('send staging path is a symlink');
    if (r.phase === 'done') throw new Error('send already committed; request its receipt');
    mkdirSync(r.stage, { recursive: true, mode: 0o700 });
    if (meta.kind === 'file' && meta.again && !present(join(r.stage, meta.name))) copyFileSync(r.destination, join(r.stage, meta.name), constants.COPYFILE_FICLONE);
    this.jobs.set(meta.id, r); this.active.set(meta.id, r); saveRecord(this.file(r.id), r);
    return { destination: r.destination, id: r.id };
  }
  commit(id, signer) {
    const r = this.active.get(id);
    if (!r) throw new Error('send reservation is missing');
    const { meta } = r;
    if (meta.marker) {
      const parent = meta.marker.git ? '.git' : '.helm';
      const dir = join(r.stage, parent, meta.marker.git ? 'helm-handoff' : 'handoff');
      // Do not write a marker through a copied symlink.
      for (const path of [join(r.stage, parent), dir]) if (present(path) && lstatSync(path).isSymbolicLink()) throw new Error('task marker directory is a symlink');
      mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `${meta.marker.handoffId}.json`), meta.marker.body, { mode: 0o600 });
    }
    r.receipt = { jobId: id, folder: r.destination, at: Date.now(), sourceMachineId: r.source, intentDigest: r.fingerprint };
    if (signer) r.receipt.signature = signer(sendReceiptDigest(r.receipt));
    r.phase = 'publishing'; saveRecord(this.file(id), r);
    if (!meta.again && present(r.destination)) throw new Error('destination appeared during send; refusing to overwrite it');
    if (!(meta.kind === 'folder' && meta.again)) {
      renameSync(meta.kind === 'file' ? join(r.stage, meta.name) : r.stage, r.destination);
      syncDirectory(dirname(r.destination));
      if (meta.kind === 'file') rmSync(r.stage, { recursive: true, force: true });
    }
    r.phase = 'done'; saveRecord(this.file(id), r); this.active.delete(id);
    return r.receipt;
  }
  release(id) { this.active.delete(id); }
  status(id, caller) {
    const r = this.jobs.get(id);
    if (!r || r.source !== caller) throw new Error('no send receipt for this source');
    return { receipt: r.phase === 'done' ? r.receipt : null };
  }
}
