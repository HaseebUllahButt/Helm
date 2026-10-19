import { readFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { expand } from './paths.js';
import { overlaps, workspace, validateRestore, readSnapshot } from './checkpoints/files.js';
import { getProfiles, materialize } from './profiles.js';
import { pathWithShim } from './brain.js';
import { DRIVERS, wire } from './session-wire.js';

/**
 * Rewind and fork: put a conversation back to an earlier turn, with its
 * files when they were checkpointed, or start a new chat from that turn.
 * Also the lock that keeps other changes off a conversation, and off its
 * workspace, while that happens.
 */
export class SessionRewind {
  #sessions;
  #core;
  constructor(sessions, core) {
    this.#sessions = sessions;
    this.#core = core;
  }

  rewinding = new Set();
  #restoreRoots = new Set();
  captureRoots = new Map();
  providerRevisions = new Map();

  assertRewindUnlocked(id, cwd = this.#core.index.get(id)?.cwd) {
    if (this.#core.index.get(id)?.rewindFailure) throw new Error('Rewind recovery must finish before this conversation can change.');
    if (this.rewinding.has(id)) throw new Error('This conversation is being rewound.');
    if (cwd && (this.#restoreRoots.size || this.captureRoots.size)) {
      const path = realpathSync(expand(cwd));
      if ([...this.#restoreRoots].some(root => overlaps(root, path))) throw new Error('This workspace is being restored.');
      if ([...this.captureRoots].some(([root, owner]) => owner !== id && overlaps(root, path))) throw new Error('This workspace is being checkpointed.');
    }
  }

  captureWorkspace(s) {
    const root = realpathSync(s.cwd);
    const dotGit = join(root, '.git');
    if (!existsSync(dotGit)) throw new Error('File restore requires an isolated Git worktree at its root.');
    if (lstatSync(dotGit).isDirectory()) throw new Error('File restore requires an isolated Git worktree; the main checkout cannot be restored.');
    if (!lstatSync(dotGit).isFile()) throw new Error('File restore requires an isolated Git worktree.');
    if (this.#sessions.hasActiveDelegations(s.id)) throw new Error('Descendants are still using this workspace.');
    for (const other of this.#core.index.values()) {
      if (other.id === s.id || !other.cwd || !(other.driver || other.nativeCli || other.externalActive || ['working', 'blocked', 'starting', 'shell'].includes(other.status))) continue;
      let path;
      try { path = realpathSync(expand(other.cwd)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (overlaps(root, path)) throw new Error('This workspace is shared with another session; file capture is unavailable.');
    }
    return root;
  }

  #rewindTarget(id, turnId) {
    const s = this.#core.index.get(id);
    if (!s?.driver) throw new Error('No such driven conversation.');
    if (!DRIVERS[s.driver]?.canRewind || s.external || s.nativeSocket || s.nativeCli || s.shared) throw new Error('This provider does not support safe rewind in Helm.');
    if (!['idle', 'done', 'exited'].includes(s.status) || this.#core.sending.has(id) || this.#core.settling.has(id)
      || this.#core.driverStarts.has(id) || this.#core.outbox.get(id)?.length || this.#core.steered.get(id)?.length
      || this.#sessions.events.pending(id).length || this.#sessions.hasActiveDelegations(id)) throw new Error('Wait for this conversation, queued messages, and descendants to finish before rewinding.');
    const events = this.#sessions.events.tail(id, 0);
    const turn = events.find(e => e.type === 'turn.start' && e.turnId === turnId && !e.local && !e.wake && !e.queued);
    const checkpointId = turn?.checkpoint ?? events.find(e => e.type === 'turn.checkpoint' && e.turnId === turnId)?.checkpoint;
    if (!turn || !checkpointId) throw new Error('This message has no saved rewind checkpoint.');
    return { s, turn, checkpoint: this.#sessions.checkpoints.get(checkpointId, id) };
  }

  #restoreSafety(s, checkpoint, detected = []) {
    if (!checkpoint.files) throw new Error(checkpoint.filesReason || 'No file checkpoint is available.');
    const { root } = workspace(s.cwd);
    for (const other of [...this.#core.index.values(), ...detected]) {
      if (other.id === s.id || !other.cwd) continue;
      // An idle conversation can start a new turn at any time. Require an
      // exclusive workspace even for idle/archived conversations still owned.
      const active = other.driver || other.nativeCli || other.externalActive || ['working', 'blocked', 'starting', 'shell'].includes(other.status);
      if (!active) continue;
      let path;
      try { path = realpathSync(expand(other.cwd)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (overlaps(root, path)) throw new Error('This worktree is shared with another session. Rewind without restoring files.');
    }
    if (this.#sessions.hasActiveDelegations(s.id)) throw new Error('Descendants are still using this workspace.');
    validateRestore(s.cwd, join(this.#sessions.checkpoints.path(checkpoint.id), 'files'));
    return root;
  }

  async rewindCheck(id, turnId) {
    const { s, checkpoint } = this.#rewindTarget(id, turnId);
    try { this.#restoreSafety(s, checkpoint, await this.#sessions.list({ includeDetected: true, includeDelegations: true })); return { restoreFiles: true }; }
    catch (error) { return { restoreFiles: false, reason: error.message }; }
  }

  async rewind(id, turnId, { restoreFiles: restore = false } = {}) {
    if (typeof restore !== 'boolean') throw new Error('restoreFiles must be a boolean.');
    this.assertRewindUnlocked(id);
    const { s, turn, checkpoint } = this.#rewindTarget(id, turnId);
    const root = restore ? this.#restoreSafety(s, checkpoint) : null;
    this.rewinding.add(id);
    if (root) this.#restoreRoots.add(root);
    let candidate = null, recoveryId = null, recovery = null, original = null, committed = false, applying = false;
    try {
      // Validate the draft before making any provider or workspace changes.
      const attachments = checkpoint.attachments.map(a => {
        const data = a.data ?? this.#sessions.events.attachment(id, a.ref);
        if (!data) throw new Error('An attachment is no longer stored; rewind cannot restore this draft safely.');
        return { filename: a.filename, mime: a.mime, data };
      });
      original = await this.#core.driver(s);
      if (typeof original.prepareRewind !== 'function') throw new Error('This provider cannot prepare a safe rewind.');
      recoveryId = await this.#sessions.checkpoints.archive(s, this.#sessions.events, false);
      recovery = JSON.parse(readFileSync(join(this.#sessions.checkpoints.path(recoveryId), 'recovery.json'), 'utf8'));
      recovery.restore = restore;
      if (restore) recovery.owned = readSnapshot(join(this.#sessions.checkpoints.path(checkpoint.id), 'files')).files.map(file => file.name);
      const options = await original.prepareRewind({ ...checkpoint, turnId: turn.turnId });
      const profile = (await getProfiles()).find(p => p.id === s.profileId);
      if (!profile) throw new Error('The account for this conversation is no longer available.');
      const spec = materialize(profile);
      const procId = `${id}-rewind-${recoveryId}`;
      candidate = this.#sessions.makeDriver(s.driver, { cmd: spec.cmd, env: { ...spec.env, PATH: pathWithShim(spec.env?.PATH), HELM_SESSION_ID: id,
        HELM_PROFILE_ID: s.profileId, HELM_ENGINE: s.engine, HELM_CWD: s.cwd }, args: spec.args,
        cwd: s.cwd, model: s.model, effort: s.effort, mode: s.mode, speed: s.speed,
        instructions: original.instructions, delegated: !!s.delegation, procHost: this.#sessions.procs, procId, ...options });
      await candidate.validateRewind();
      if (['working', 'blocked', 'exited'].includes(candidate.status)) throw new Error('The provider did not prepare an idle rewind.');
      if (!candidate.engineSessionId || candidate.engineSessionId === recovery.session.engineSessionId) throw new Error('The provider did not confirm a separate rewind conversation.');
      if (root) this.#restoreSafety(s, checkpoint, await this.#sessions.list({ includeDetected: true, includeDelegations: true }));
      this.#rewindTarget(id, turnId);
      if (this.#sessions.events.last(id) !== recovery.events.at(-1)?.seq || s.engineSessionId !== recovery.session.engineSessionId) throw new Error('The conversation changed while rewind was being prepared; try again after it settles.');
      if (restore) {
        await this.#sessions.checkpoints.captureRecoveryFiles(recoveryId, s.cwd);
        this.#restoreSafety(s, checkpoint, await this.#sessions.list({ includeDetected: true, includeDelegations: true }));
        this.#rewindTarget(id, turnId);
        if (this.#sessions.events.last(id) !== recovery.events.at(-1)?.seq || s.engineSessionId !== recovery.session.engineSessionId) throw new Error('The conversation changed while rewind was being prepared; try again after it settles.');
      }
      // No await from the journal through the commit: a new Helm turn cannot
      // enter this workspace between the final safety check and publication.
      this.#sessions.checkpoints.write(recoveryId, 'recovery.json', { ...recovery, phase: 'applying' });
      applying = true;
      if (restore) this.#sessions.checkpoints.restore(s.cwd, join(this.#sessions.checkpoints.path(checkpoint.id), 'files'), { lockToken: recoveryId });
      Object.assign(s, options, { engineSessionId: candidate.engineSessionId, rewindProcId: procId, status: 'idle', updatedAt: Date.now(), queuePaused: false });
      for (const key of ['context', 'lastUsage', 'recovery', 'nativeAgents', 'nativeCards', 'team', 'stoppedAt', 'externalSource', 'costTotalUsd']) delete s[key];
      const next = this.#sessions.events.rewind(id, checkpoint.history);
      s.lastSeq = next.at(-1).seq;
      this.#core.save(); this.#core.flush();
      this.#sessions.checkpoints.write(recoveryId, 'recovery.json', { ...recovery, phase: 'committed', newEngineSessionId: s.engineSessionId });
      committed = true;
      this.#core.bindDriver(s, candidate, profile);
      this.#core.awaitingEcho.delete(id); this.#core.closedTurns.delete(id);
      this.#sessions.emit('session', s);
      // The reset event also invalidates every connected device's old history.
      for (const event of next) this.#sessions.emit('event', { id, event });
      return { session: { ...wire(s) }, draft: { text: checkpoint.text, attachments, references: checkpoint.references }, recoveryId };
    } catch (error) {
      if (recovery && applying && !committed) {
        try {
          if (restore) this.#sessions.checkpoints.restore(recovery.session.cwd, join(this.#sessions.checkpoints.path(recoveryId), 'recovery-files'), { owned: recovery.owned, lockToken: recoveryId });
          this.#sessions.events.replace(id, recovery.events);
          for (const key of Object.keys(s)) delete s[key];
          Object.assign(s, recovery.session);
          this.#core.save(); this.#core.flush();
          this.#sessions.checkpoints.write(recoveryId, 'recovery.json', { ...recovery, phase: 'rolled-back', error: error.message });
        } catch (rollbackError) {
          // Keep the applying journal for startup recovery and block sends.
          s.rewindFailure = recoveryId;
          throw new Error(`Rewind recovery is required (${recoveryId}): ${rollbackError.message}`, { cause: error });
        }
      }
      throw error;
    } finally {
      if (!committed && candidate) await candidate.kill().catch(error => this.#sessions.log(`rewind candidate cleanup: ${error.message}`));
      if (committed && original) await original.kill().catch(error => this.#sessions.log(`rewind old provider cleanup: ${error.message}`));
      if (!committed && s.rewindFailure && original) {
        // A failed compensation must not leave an agent able to write into
        // partially restored files while startup recovery is still required.
        original.removeAllListeners?.('event');
        this.#core.drivers.delete(id);
        await original.kill().catch(error => this.#sessions.log(`rewind recovery provider cleanup: ${error.message}`));
      }
      this.rewinding.delete(id);
      if (root && !s.rewindFailure) this.#restoreRoots.delete(root);
    }
  }

  /**
   * Branch a conversation: a new thread that starts as this one was just
   * before `turnId`, so the same question can be put differently.
   *
   * Only the conversation is rewound, and only in the copy. This thread is
   * left exactly as it is, and the files in the folder are not touched - the
   * branch sees them as they are now, which is the point of keeping them.
   * Claude Code only: it is the CLI that can cut a conversation at a message.
   */
  async fork(id, turnId) {
    const s = this.#core.index.get(id);
    if (!s?.driver) throw new Error('no such thread');
    if (s.engine !== 'claude') throw new Error('only Claude Code threads can be branched so far');
    let at = null;
    let seen = false;
    for (const e of this.#sessions.events.tail(id, 100_000)) {
      if (e.type === 'turn.start' && e.turnId === turnId) { seen = true; break; }
      if (e.type === 'turn.done' && e.resumeAt) at = e.resumeAt;
    }
    if (!seen) throw new Error('that message is not in this conversation');
    if (!at) throw new Error('nothing comes before that message, so there is nothing to branch from');
    if (!s.engineSessionId) throw new Error('this thread has no conversation to branch yet');
    const profile = (await getProfiles()).find((p) => p.id === s.profileId);
    if (!profile) throw new Error(`unknown profile: ${s.profileId}`);
    return this.#core.startDriven({
      cwd: s.cwd, quick: !!s.quick, profile, title: `${s.title} (branch)`,
      model: s.model, effort: s.effort, mode: s.mode, speed: s.speed,
      forkFrom: { sessionId: s.engineSessionId, at },
      // Same folder, so the same worktree: kept, rebuilt and removed together.
      chatWorktree: s.chatWorktree ? { ...s.chatWorktree, setup: undefined } : null,
    });
  }
}
