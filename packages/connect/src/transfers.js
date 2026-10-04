import { createHash, randomBytes } from 'node:crypto';
import { M } from '@helm/protocol';
import { beginTransferActivity } from '@helm/protocol/transfer-activity';
import {
  createCodeSnapshot, createEphemeralCodeKey, materializeCode, sealCodeSnapshot, configureGitOrigin,
  signHandoffDigest, verifyHandoffSignature,
} from './code-transfer.js';
import {
  inspectTransferReadiness, readHandoffSkipped, transferPreflight,
} from './transfer-check.js';

const TRANSFER_ID = /^[a-f0-9]{24}$/;
const MACHINE_ID = /^[a-f0-9]{1,64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const SOURCE_SIG = /^[A-Za-z0-9_-]{40,512}$/;
const SECRET = /^[A-Za-z0-9_-]{20,128}$/;
const MAX_TOKEN = 4096;
const MAX_FOLDER = 1024;
const MAX_GRANTS = 32;
const MIN_TTL_MS = 60_000;
const DEFAULT_TTL_MS = 10 * 60_000;
const MAX_TTL_MS = 15 * 60_000;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const b64url = (value, min, max) =>
  typeof value === 'string' && value.length >= min && value.length <= max
    && /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
const line = (v, max = MAX_FOLDER) =>
  typeof v === 'string' && v.length > 0 && v.length <= max
    && !/[\u0000-\u001f\u007f]/.test(v) ? v : null;

export const transferGrantDigest = (grant) => sha256(JSON.stringify({
  v: grant?.v,
  targetMachineId: grant?.targetMachineId,
  sourceMachineId: grant?.sourceMachineId,
  transferPubkey: grant?.transferPubkey,
  secret: grant?.secret,
  expiresAt: grant?.expiresAt,
}));

export const transferRequestDigest = (p) => sha256(JSON.stringify({
  transferId: p.transferId,
  sourceMachineId: p.sourceMachineId,
  targetMachineId: p.targetMachineId,
  folder: p.folder ?? null,
  snapshotDigest: p.snapshotDigest,
  grantSecret: p.grantSecret,
}));

export const encodeTransferGrant = (grant) =>
  Buffer.from(JSON.stringify(grant)).toString('base64url');

export const decodeTransferGrant = (token) => {
  if (typeof token !== 'string' || !token.length || token.length > MAX_TOKEN) {
    throw new Error('invalid transfer grant');
  }
  let grant;
  try {
    grant = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new Error('invalid transfer grant');
  }
  if (!grant || grant.v !== 1) throw new Error('invalid transfer grant');
  if (!MACHINE_ID.test(grant.targetMachineId ?? '')) throw new Error('invalid transfer grant target');
  if (!MACHINE_ID.test(grant.sourceMachineId ?? '')) throw new Error('invalid transfer grant source');
  if (!b64url(grant.transferPubkey, 40, 512)) throw new Error('invalid transfer grant key');
  if (!b64url(grant.secret, 20, 128)) throw new Error('invalid transfer grant secret');
  if (!Number.isInteger(grant.expiresAt) || grant.expiresAt <= 0) {
    throw new Error('invalid transfer grant expiry');
  }
  if (!b64url(grant.signature, 40, 512)) throw new Error('invalid transfer grant signature');
  return grant;
};

export class Transfers {
  constructor({ network, now = Date.now, rpc = null } = {}) {
    this.network = network;
    this.now = now;
    this.rpc = rpc;
    this.grants = new Map();
  }

  #net() {
    return typeof this.network === 'function' ? this.network() : this.network;
  }

  /**
   * The person driving the app is allowed to ask a machine about its own
   * folders and to carry a grant between two machines. Other machines are not:
   * machine-to-machine calls stay on the signed accept boundary below.
   */
  #controller(caller, what) {
    const net = this.#net();
    if (!caller || net?.revoked?.[caller]
        || !(caller === net?.self || net?.devices?.[caller])) {
      throw new Error(`${what} is for this machine or a paired device only`);
    }
    return net;
  }

  #sweep() {
    const t = this.now();
    for (const [secret, grant] of this.grants) {
      if (grant.expiresAt <= t) this.grants.delete(secret);
    }
  }

  preview(params = {}, caller) {
    const net = this.#controller(caller, 'a transfer preview');
    const folder = line(params?.folder);
    if (!folder) throw new Error('a transfer preview needs a folder');
    const snapshot = createCodeSnapshot(folder, { includeEnv: params?.includeEnv === true });
    return {
      sourceMachineId: net.self,
      rootName: snapshot.rootName,
      digest: snapshot.digest,
      git: snapshot.git ?? null,
      preflight: transferPreflight(snapshot),
    };
  }

  invite(params = {}, caller) {
    const net = this.#controller(caller, 'a transfer invitation');
    // The grant remains the target's own signed object - an invite only lets
    // the paired controller ask this machine to mint one for the send it is
    // about to drive.
    return this.receive(params, net.self);
  }

  async send(params = {}, caller) {
    const net = this.#controller(caller, 'a transfer send');
    if (typeof this.rpc !== 'function') throw new Error('this machine cannot send transfers');
    const folder = line(params?.folder);
    if (!folder) throw new Error('a transfer send needs a source folder');
    const target = params?.targetMachineId;
    if (!MACHINE_ID.test(target ?? '') || !net.machines?.[target] || net.revoked?.[target]
        || target === net.self) {
      throw new Error('a transfer send names another machine of this network');
    }

    const includeEnv = params?.includeEnv === true;
    const snapshot = createCodeSnapshot(folder, { includeEnv });
    const preflight = transferPreflight(snapshot);
    if (preflight.requiresAcknowledgement && params?.allowSkipped !== true) {
      return { sent: false, requiresAcknowledgement: true, preflight };
    }

    const grant = decodeTransferGrant(line(params?.grant, MAX_TOKEN) ?? '');
    if (grant.targetMachineId !== target) {
      throw new Error('that grant is for a different machine');
    }
    if (grant.sourceMachineId !== net.self) {
      throw new Error('that grant is for a different source machine');
    }
    if (grant.expiresAt <= this.now()) {
      throw new Error('that grant has expired; ask for a fresh invitation');
    }
    const signPubkey = net.machines[target]?.codeSignPubkey;
    if (!signPubkey) throw new Error('the target has no pinned signing key yet');
    if (!verifyHandoffSignature(signPubkey, transferGrantDigest(grant), grant.signature)) {
      throw new Error('the transfer invitation did not verify against the target');
    }

    const transferId = randomBytes(12).toString('hex');
    const requested = params?.targetFolder === undefined ? null : line(params.targetFolder);
    if (params?.targetFolder !== undefined && requested === null) {
      throw new Error('invalid target folder');
    }
    const targetFolder = requested
      || `~/.helm/transfers/${snapshot.rootName}-${transferId.slice(0, 8)}`;
    const request = {
      transferId,
      sourceMachineId: net.self,
      targetMachineId: target,
      folder: targetFolder,
      envelope: sealCodeSnapshot(snapshot, grant.transferPubkey, transferId),
      snapshotDigest: snapshot.digest,
      grantSecret: grant.secret,
    };
    request.requestDigest = transferRequestDigest(request);
    request.sourceSignature = signHandoffDigest(request.requestDigest);
    const receipt = await this.rpc(target, M.TRANSFER_ACCEPT, request, { timeout: 240_000, direct: true });
    return {
      sent: true,
      transferId,
      sourceMachineId: net.self,
      targetMachineId: target,
      targetName: net.machines[target]?.name ?? target,
      preflight,
      receipt,
    };
  }

  async verify(params = {}, caller) {
    this.#controller(caller, 'transfer verification');
    const folder = line(params?.folder);
    if (!folder) throw new Error('transfer verification needs a folder');
    const skipped = readHandoffSkipped(folder);
    return inspectTransferReadiness(folder, {
      skippedEntries: skipped?.skippedEntries ?? [],
      skipped: skipped?.skipped ?? 0,
    });
  }

  receive(params = {}, caller) {
    const net = this.#net();
    if (!caller || caller !== net?.self || !net.machines?.[caller] || net.revoked?.[caller]) {
      throw new Error('a transfer grant is issued by this machine only');
    }
    const sourceMachineId = params?.sourceMachineId;
    if (!MACHINE_ID.test(sourceMachineId ?? '') || !net.machines[sourceMachineId]
        || net.revoked?.[sourceMachineId]) {
      throw new Error('a transfer grant names a machine of this network');
    }
    this.#sweep();
    if (this.grants.size >= MAX_GRANTS) throw new Error('too many live transfer grants');
    const asked = Number(params?.ttlMs);
    const ttlMs = Number.isFinite(asked) && asked > 0
      ? Math.min(Math.max(asked, MIN_TTL_MS), MAX_TTL_MS)
      : DEFAULT_TTL_MS;
    const { privateKey, codePubkey } = createEphemeralCodeKey();
    const secret = randomBytes(16).toString('base64url');
    const expiresAt = this.now() + ttlMs;
    const unsigned = {
      v: 1, targetMachineId: net.self, sourceMachineId,
      transferPubkey: codePubkey, secret, expiresAt,
    };
    const grant = { ...unsigned, signature: signHandoffDigest(transferGrantDigest(unsigned)) };
    this.grants.set(secret, {
      sourceMachineId,
      privateKey, expiresAt, transferId: null, requestDigest: null, inflight: null, result: null,
    });
    return { grant: encodeTransferGrant(grant), expiresAt };
  }

  #validate(params, caller) {
    if (!params || typeof params !== 'object') throw new Error('invalid transfer request');
    const net = this.#net();
    if (!TRANSFER_ID.test(params.transferId ?? '')) throw new Error('invalid transfer id');
    if (!caller || !net?.machines?.[caller] || net?.revoked?.[caller]) {
      throw new Error('a transfer is accepted from a machine of this network only');
    }
    if (!MACHINE_ID.test(params.sourceMachineId ?? '') || params.sourceMachineId !== caller) {
      throw new Error('transfer source does not match the calling machine');
    }
    if (params.targetMachineId !== net.self) {
      throw new Error('the transfer target is not this machine');
    }
    const out = {
      transferId: params.transferId,
      sourceMachineId: params.sourceMachineId,
      targetMachineId: params.targetMachineId,
      folder: params.folder === undefined ? undefined : line(params.folder),
      envelope: params.envelope,
      snapshotDigest: DIGEST.test(params.snapshotDigest ?? '') ? params.snapshotDigest : null,
      grantSecret: SECRET.test(params.grantSecret ?? '') ? params.grantSecret : null,
      requestDigest: DIGEST.test(params.requestDigest ?? '') ? params.requestDigest : null,
      sourceSignature: SOURCE_SIG.test(params.sourceSignature ?? '') ? params.sourceSignature : null,
    };
    if (params.folder !== undefined && out.folder === null) throw new Error('invalid transfer folder');
    if (!out.envelope || typeof out.envelope !== 'object') throw new Error('invalid transfer envelope');
    if (!out.snapshotDigest) throw new Error('invalid transfer snapshot digest');
    if (!out.grantSecret) throw new Error('invalid transfer grant secret');
    if (!out.requestDigest) throw new Error('invalid transfer request digest');
    if (out.requestDigest !== transferRequestDigest(out)) {
      throw new Error('transfer request digest does not match its contents');
    }
    const source = net.machines[caller];
    if (!source?.codeSignPubkey) throw new Error('transfer source has no pinned signing key');
    if (!out.sourceSignature
        || !verifyHandoffSignature(source.codeSignPubkey, out.requestDigest, out.sourceSignature)) {
      throw new Error('invalid transfer source signature');
    }
    return out;
  }

  async accept(params, caller) {
    const p = this.#validate(params, caller);
    this.#sweep();
    const grant = this.grants.get(p.grantSecret);
    if (!grant) throw new Error('unknown or expired transfer grant');
    if (grant.sourceMachineId !== p.sourceMachineId) {
      throw new Error('this transfer grant was not issued for this source machine');
    }
    if (grant.transferId !== null
        && (grant.transferId !== p.transferId || grant.requestDigest !== p.requestDigest)) {
      throw new Error('this transfer grant is bound to a different request');
    }
    if (grant.result) return { ...grant.result };
    if (grant.inflight) return grant.inflight;
    grant.transferId = p.transferId;
    grant.requestDigest = p.requestDigest;
    const endActivity = beginTransferActivity();
    const work = this.#materialize(grant, p).finally(endActivity);
    grant.inflight = work;
    const done = () => { if (grant.inflight === work) grant.inflight = null; };
    void work.then(done, done);
    return work;
  }

  async #materialize(grant, p) {
    try {
      const receipt = await materializeCode(p.envelope, p.transferId, p.folder, {
        privateKey: grant.privateKey,
        expectedDigest: p.snapshotDigest,
      });
      const repository = await configureGitOrigin(receipt.folder, receipt.git);
      const readiness = await inspectTransferReadiness(receipt.folder, {
        skippedEntries: receipt.skippedEntries,
        skipped: receipt.skipped,
      }).catch(() => ({
        status: 'unverified',
        verified: false,
        checks: [{
          code: 'inspection-failed',
          status: 'warning',
          message: 'Readiness inspection failed; run helm verify on the target.',
        }],
      }));
      const result = {
        folder: receipt.folder,
        files: receipt.files,
        bytes: receipt.bytes,
        skipped: receipt.skipped,
        skippedEntries: receipt.skippedEntries,
        digest: receipt.digest,
        readiness,
        ...(repository ? { repository } : {}),
      };
      grant.result = result;
      grant.privateKey = null;
      return { ...result };
    } catch (err) {
      if (grant.transferId === p.transferId) {
        grant.transferId = null;
        grant.requestDigest = null;
      }
      throw err;
    }
  }
}
