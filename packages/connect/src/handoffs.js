/**
 * Handoffs this machine has accepted, as a target.
 *
 * Accepting a handoff is three steps - materialize the folder, start the
 * session, send the first prompt - and the old wire shape made the caller
 * drive them as three RPCs, so a dropped connection partway left a folder
 * nobody would start and a session nobody would prompt. Here it is one
 * operation: the record in ~/.helm/handoffs.json is written after each step,
 * so a retry (or a daemon restart mid-handoff) resumes from what already
 * happened instead of doing it twice. The first prompt carries a
 * deterministic turn id, which is what makes the last step idempotent too -
 * `Sessions.input` answers a turn the log already holds without sending it
 * again.
 *
 * The file is private (0600): receipts carry folder paths and session ids.
 * A corrupt file reads as an empty store rather than crashing the daemon;
 * it is left on disk so the damage is visible instead of silently wiped.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HELM_DIR } from './paths.js';
import { materializeCode, restoreGitMetadata, verifyHandoffSignature } from './code-transfer.js';
import { getProfiles } from './profiles.js';
import { defaultMode } from './modes.js';

const HANDOFFS_FILE = join(HELM_DIR, 'handoffs.json');
const HANDOFF_ID = /^[a-f0-9]{24}$/;
const MACHINE_ID = /^[a-f0-9]{1,64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_LINE = 256;
const MAX_FOLDER = 1024;
const MAX_PROMPT = 64_000;
const MAX_ERROR = 500;
// An Ed25519 signature is 86 base64url chars; bound it the way the roster
// bounds the keys it signs for.
const SOURCE_SIG = /^[A-Za-z0-9_-]{40,512}$/;
// A prompt id that failed walks to the next attempt; twenty failures in a
// single accept is a wedged session, not something a retry will fix.
const MAX_PROMPT_SKIPS = 20;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * The fingerprint of what an accept asked for. A retry repeats the handoff
 * id, so the request itself must repeat too - a reused id carrying a
 * different prompt, snapshot or profile is a different operation wearing
 * the same name, not a retry. The snapshot digest is the plaintext
 * contents, not the ciphertext: sealing randomizes the envelope every
 * time, so the same code must still read as the same request. The source
 * computes this over its own request and signs it with its pinned Ed25519
 * identity (`sourceSignature`); the digest rides inside the request, so a
 * hub can bind a stored payload to it without being able to recompute the
 * fields itself.
 */
export const handoffRequestDigest = (p) => sha256(JSON.stringify({
  sourceMachineId: p.sourceMachineId,
  targetMachineId: p.targetMachineId,
  folder: p.folder ?? null,
  snapshotDigest: p.snapshotDigest,
  profileId: p.profileId,
  model: p.model ?? null,
  mode: p.mode ?? null,
  title: p.title ?? null,
  parent: p.parent ?? null,
  prompt: p.prompt,
}));

/** One line of printable text, or null. Same bar the roster holds. */
const line = (v, max = MAX_LINE) =>
  typeof v === 'string' && v.length > 0 && v.length <= max
    && !/[\u0000-\u001f\u007f]/.test(v) ? v : null;

export class Handoffs {
  /**
   * @param {object} opts
   * @param {import('./sessions.js').Sessions} opts.sessions
   * @param {Function|object} opts.network  current network state, or a getter
   *   returning it - a thunk, so a revocation gossiped in mid-day is honoured
   *   by the next call rather than at restart.
   * @param {Function} [opts.profiles]  returns this machine's agent profiles;
   *   injectable so the safe-default-mode rule is testable.
   */
  constructor({ sessions, network, file = HANDOFFS_FILE, profiles = getProfiles } = {}) {
    this.sessions = sessions;
    this.network = network;
    this.file = file;
    this.profiles = profiles;
    this.records = this.#load().handoffs;
    /** handoffId -> in-flight accept promise; the second caller joins it. */
    this.inflight = new Map();
  }

  #net() {
    return typeof this.network === 'function' ? this.network() : this.network;
  }

  #load() {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (parsed && parsed.version === 1 && parsed.handoffs && typeof parsed.handoffs === 'object') {
        return parsed;
      }
    } catch { /* missing or corrupt: an empty store, the file left alone */ }
    return { version: 1, handoffs: {} };
  }

  /** Atomic: a torn write must never leave half a receipt behind. */
  #save() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, handoffs: this.records }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  #put(record) {
    record.updatedAt = Date.now();
    this.records[record.handoffId] = record;
    this.#save();
  }

  /** A machine id in good standing on the current roster, or null. */
  #machine(id) {
    const net = this.#net();
    return id && net?.machines?.[id] && !net?.revoked?.[id] ? net.machines[id] : null;
  }

  #validate(params, caller) {
    if (!params || typeof params !== 'object') throw new Error('invalid handoff request');
    const p = params;
    if (!HANDOFF_ID.test(p.handoffId ?? '')) throw new Error('invalid handoff id');
    // Only a machine holds a code handoff: devices drive sessions but never
    // author one, and the declared source has to be who actually called.
    if (!caller || !this.#machine(caller)) {
      throw new Error('a code handoff is accepted from a machine of this network only');
    }
    if (!MACHINE_ID.test(p.sourceMachineId ?? '') || !this.#machine(p.sourceMachineId)) {
      throw new Error('handoff source is not a machine in this network');
    }
    if (p.sourceMachineId !== caller) {
      throw new Error('handoff source does not match the calling machine');
    }
    // The work runs here, so the declared target must be this machine: a
    // queued job replayed by a hub against the wrong host is refused rather
    // than materializing someone else's code.
    if (!MACHINE_ID.test(p.targetMachineId ?? '') || p.targetMachineId !== this.#net()?.self) {
      throw new Error('the handoff target is not this machine');
    }
    const out = {
      handoffId: p.handoffId,
      sourceMachineId: p.sourceMachineId,
      targetMachineId: p.targetMachineId,
      folder: p.folder === undefined ? undefined : line(p.folder, MAX_FOLDER),
      snapshotDigest: DIGEST.test(p.snapshotDigest ?? '') ? p.snapshotDigest : null,
      profileId: line(p.profileId),
      prompt: typeof p.prompt === 'string' && p.prompt.length > 0 && p.prompt.length <= MAX_PROMPT
        ? p.prompt : null,
      title: p.title === undefined ? undefined : line(p.title),
      model: p.model === undefined ? undefined : line(p.model),
      mode: p.mode === undefined ? undefined : line(p.mode),
      parent: p.parent,
      envelope: p.envelope,
      requestDigest: DIGEST.test(p.requestDigest ?? '') ? p.requestDigest : null,
      sourceSignature: SOURCE_SIG.test(p.sourceSignature ?? '') ? p.sourceSignature : null,
    };
    if (p.folder !== undefined && out.folder === null) throw new Error('invalid handoff folder');
    if (!out.snapshotDigest) throw new Error('invalid handoff snapshot digest');
    if (!out.profileId) throw new Error('invalid handoff profileId');
    if (!out.prompt) throw new Error('invalid handoff prompt');
    if (!out.requestDigest) throw new Error('invalid handoff request digest');
    if (p.title !== undefined && out.title === null) throw new Error('invalid handoff title');
    if (p.model !== undefined && out.model === null) throw new Error('invalid handoff model');
    if (p.mode !== undefined && out.mode === null) throw new Error('invalid handoff mode');
    if (!out.envelope || typeof out.envelope !== 'object') throw new Error('invalid handoff envelope');
    if (out.parent != null) {
      // The parent link is how the two ends point at each other afterwards;
      // a parent claiming another handoff, source or snapshot is a lie we
      // would be writing into the session record.
      if (typeof out.parent !== 'object'
          || out.parent.handoffId !== out.handoffId
          || out.parent.machineId !== out.sourceMachineId
          || out.parent.digest !== out.snapshotDigest) {
        throw new Error('handoff parent must name this handoff, its source machine, and its snapshot');
      }
    }
    // The digest is part of the request, so it has to be honest about it:
    // every field the record binds must be what the digest covers.
    if (out.requestDigest !== handoffRequestDigest(out)) {
      throw new Error('handoff request digest does not match its contents');
    }
    // And the digest is what the source signs: the roster-pinned key of
    // the machine that claims to have sent this is the authority on whether
    // it really did. The relay's caller check is only depth beneath this.
    const source = this.#machine(out.sourceMachineId);
    if (!source?.codeSignPubkey) throw new Error('handoff source has no pinned signing key');
    if (!out.sourceSignature
        || !verifyHandoffSignature(source.codeSignPubkey, out.requestDigest, out.sourceSignature)) {
      throw new Error('invalid handoff source signature');
    }
    return out;
  }

  /**
   * The one operation a source machine calls: materialize, start, prompt.
   *
   * Each completed step is persisted before the next runs, so calling again
   * with the same handoffId continues rather than repeats. `caller` is the
   * authenticated member id - it must be the declared source machine.
   */
  async accept(params, caller) {
    const p = this.#validate(params, caller);
    const existing = this.records[p.handoffId];
    // A stored record belongs to the machine that first presented this id.
    if (existing && existing.sourceMachineId !== p.sourceMachineId) {
      throw new Error('a handoff with this id came from another machine');
    }
    const digest = p.requestDigest;
    // The mismatch check runs before joining: a concurrent caller reusing
    // the id for a different request is refused, not folded into the one
    // already running.
    if (existing && existing.requestDigest !== digest) {
      throw new Error('handoff retry does not match its original request');
    }
    // The same job can arrive from several hubs at once; the second
    // identical accept waits on the first rather than racing the record.
    const running = this.inflight.get(p.handoffId);
    if (running) return running;
    const work = this.#run(p, existing, digest)
      .finally(() => this.inflight.delete(p.handoffId));
    this.inflight.set(p.handoffId, work);
    return work;
  }

  async #run(p, existing, digest) {
    const record = existing ?? {
      handoffId: p.handoffId,
      sourceMachineId: p.sourceMachineId,
      targetMachineId: p.targetMachineId,
      requestDigest: digest,
      promptAttempt: 1,
      folder: null, digest: null, files: 0, bytes: 0, skipped: 0,
      sessionId: null, status: 'accepted', error: null,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    if (!existing) this.#put(record);
    try {
      if (!record.folder) {
        // A retried request may carry a freshly sealed envelope over the
        // same snapshot - the digest check is what ties the ciphertext we
        // just decrypted to the code this handoff claims to carry.
        const receipt = await materializeCode(p.envelope, p.handoffId, p.folder);
        if (receipt.digest !== p.snapshotDigest) {
          throw new Error('handoff snapshot digest does not match the request');
        }
        record.folder = receipt.folder;
        record.digest = receipt.digest;
        record.files = receipt.files;
        record.bytes = receipt.bytes;
        record.skipped = receipt.skipped;
        record.skippedEntries = receipt.skippedEntries;
        record.git = receipt.git ?? null;
        record.status = 'materialized';
        this.#put(record);
      }
      // Git provenance is restored once, on the folder this handoff
      // materialized - that is the only folder restoreGitMetadata is safe
      // to clear a crashed attempt's .git from. A failed restore is a
      // detail on the receipt, not a reason the task must not start.
      if (record.git && record.gitRestoredAt == null) {
        record.gitRestore = await restoreGitMetadata(record.folder, record.git)
          .catch((err) => ({ restored: false, error: String(err?.message || err).slice(0, MAX_ERROR) }));
        record.gitRestoredAt = Date.now();
        this.#put(record);
      }
      if (!record.sessionId) {
        // A crash between the session starting and this record landing
        // leaves a session whose parent link still names the handoff -
        // adopt it rather than starting a twin.
        let session = this.sessions.handoffSession?.(p.handoffId);
        if (!session) {
          // The named profile must exist here - the source may have picked
          // it while we were offline. And when the request does not name a
          // mode the session gets the engine's safe default, never whatever
          // the profile's saved startPrefs happen to say: a queued job must
          // not quietly run with permissions nobody asked for this time.
          const profile = (await this.profiles()).find((x) => x.id === p.profileId);
          if (!profile) {
            throw new Error(`there is no agent profile ${p.profileId} on this machine`);
          }
          const mode = p.mode ?? defaultMode(profile.engine);
          session = await this.sessions.start({
            cwd: record.folder,
            profileId: p.profileId,
            model: p.model,
            mode,
            title: p.title,
            parent: p.parent,
            originHandoffId: p.handoffId,
          });
          record.mode = mode;
        }
        record.sessionId = session.id;
        record.status = 'started';
        this.#put(record);
      }
      record.promptAttempt ??= 1;
      // A turn the log already failed is not a delivered prompt: step past
      // the dead ids instead of answering success for one. An open or done
      // turn id is the no-op a real retry wants.
      for (let skips = 0; ; skips += 1) {
        const turnId = `handoff-${p.handoffId}-${record.promptAttempt}`;
        const state = this.sessions.turnState?.(record.sessionId, turnId) ?? null;
        if (state !== 'failed' && state !== 'removed') {
          await this.sessions.input(record.sessionId, p.prompt, { turnId });
          break;
        }
        if (skips >= MAX_PROMPT_SKIPS) {
          throw new Error('the handoff prompt has failed too many times to retry');
        }
        record.promptAttempt += 1;
        this.#put(record);
      }
      record.status = 'running';
      record.error = null;
      this.#put(record);
      return { ...record };
    } catch (err) {
      // The record keeps whatever completed; a retry resumes from there.
      if (this.records[p.handoffId]) {
        record.status = 'failed';
        record.error = String(err?.message || err).slice(0, MAX_ERROR);
        this.#put(record);
      }
      throw err;
    }
  }

  /**
   * The receipt for a handoff id. The caller must be the machine that
   * sourced it - this store lives on the target, so that is also the only
   * machine with a reason to ask.
   */
  status(handoffId, caller) {
    if (!HANDOFF_ID.test(handoffId ?? '')) throw new Error('invalid handoff id');
    if (!caller || !this.#machine(caller)) {
      throw new Error('handoff status is answered for machines of this network only');
    }
    const record = this.records[handoffId];
    if (!record || record.sourceMachineId !== caller) throw new Error('unknown handoff');
    return { ...record };
  }
}
