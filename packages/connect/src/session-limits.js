import { usageResetAt, recoveryDue } from './usage-recovery.js';
import { createHash } from 'node:crypto';
import { wire } from './session-wire.js';

/**
 * Usage limits: what each account has left, and continuing the work a
 * limit stopped once that limit resets.
 */
export class LimitRecovery {
  #sessions;
  #core;
  constructor(sessions, core) {
    this.#sessions = sessions;
    this.#core = core;
  }

  async accountLimits(profiles) {
    this.#sessions.limitsSeed ??= this.#sessions.limits.seed(this.#core.index.values(), profiles, this.#sessions.events.dir)
      .catch(err => this.#sessions.log(`account limits: ${err.message}`));
    await this.#sessions.limitsSeed;
    const nativeProfiles = new Set([...this.#core.index.values()]
      .filter(s => s.nativeCli && s.engine === 'claude' && this.#sessions.nativeTerminals.has(s.id)).map(s => s.profileId));
    await this.#sessions.limits.refreshClaude(profiles.filter(p => nativeProfiles.has(p.id)));
    return this.#sessions.limits.report(profiles);
  }

  setAutoResumeLimited(id, on) {
    const s = this.#sessions.get(id);
    if (!s.driver || s.external || s.delegation || s.nativeChat || s.nativeCli) throw new Error('choose a Helm thread');
    if (typeof on !== 'boolean') throw new Error('on must be true or false');
    s.autoResumeLimited = on;
    if (!on) this.#sessions.cancelLimitContinuation(s);
    if (s.recovery) {
      if (on && s.recovery.kind === 'limited' && !s.recovery.resetAt) s.recovery.resetAt = usageResetAt({ error: s.recovery.message }, s.lastLimits, s.recovery.at);
      delete s.recovery.autoResumeError; delete s.recovery.autoResumeCancelled;
    }
    this.#core.save(); this.#sessions.emit('session', s);
    return { ok: true, session: wire(s) };
  }

  cancelLimitContinuation(session) {
    const r = session.recovery;
    if (r?.kind !== 'limited' || !r.resetAt) return;
    const identity = `${session.id}:${r.turnId || r.at}:${r.resetAt}`;
    const turnId = `local-limit-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
    if (this.#core.outbox.get(session.id)?.some(item => item.turnId === turnId)) this.#sessions.dequeue(session.id, turnId);
  }

  startLimitRecovery() {
    if (this.#sessions.limitRecoveryTimer) return;
    this.#sessions.limitRecoveryTimer = setInterval(() => void this.#sessions.tickLimitRecovery().catch(error => this.#sessions.log(`usage-limit recovery: ${error.message}`)), 15000);
    this.#sessions.limitRecoveryTimer.unref?.();
    void this.#sessions.tickLimitRecovery().catch(error => this.#sessions.log(`usage-limit recovery: ${error.message}`));
  }

  async tickLimitRecovery(now = Date.now()) {
    if (this.#sessions.limitRecoveryBusy) return;
    this.#sessions.limitRecoveryBusy = true;
    try {
      for (const s of this.#core.index.values()) {
        if (!recoveryDue(s, now)) continue;
        if (!['idle', 'done', 'error'].includes(s.status) || this.#sessions.events.pending(s.id).length
          || this.#sessions.events.activeTurn(s.id) || this.#core.sending.has(s.id) || this.#core.settling.has(s.id) || this.#sessions.hasActiveDelegations(s.id)) continue;
        try { await this.#sessions.recover(s.id, { automatic: true, now }); }
        catch (error) {
          if (s.recovery?.kind === 'limited') {
            s.recovery.autoResumeError = error.message;
            this.#core.save(); this.#sessions.emit('session', s);
          }
        }
      }
    } finally { this.#sessions.limitRecoveryBusy = false; }
  }

  async recover(id, { automatic = false, now = Date.now() } = {}) {
    const session = this.#sessions.get(id);
    if (!session.driver || ['working', 'blocked', 'starting'].includes(session.status)
      || this.#sessions.events.pending(id).length || this.#sessions.hasActiveDelegations(id)) throw new Error('this thread is still active or awaiting approval');
    const recovery = session.recovery;
    if (automatic && !recoveryDue(session, now)) return { skipped: true };
    const generation = session.stopGeneration ?? 0;
    const queued = this.#core.outbox.get(id)?.length;
    // Leave the durable failure in place until the continuation ticket exists.
    // Retrying after a crash uses the same ticket, never a second prompt.
    if (automatic && (!queued || recovery.retryTurnId)) {
      const identity = `${id}:${recovery.turnId || recovery.at}:${recovery.resetAt}`;
      const turnId = `local-limit-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
      let prompt = 'Continue the previous task from the saved conversation. Check what already finished before taking further action.';
      let attachments = [];
      if (recovery.retryTurnId) {
        const failed = this.#sessions.events.tail(id, 0).findLast(e => e.type === 'turn.start' && e.turnId === recovery.retryTurnId);
        if (!failed) throw new Error('The refused message is no longer available. Resume manually.');
        prompt = `${failed.text}${failed.referenceContext ? `\n\n${failed.referenceContext}` : ''}`;
        attachments = (failed.attachments || []).map(a => ({ mime: a.mime, filename: a.filename, data: a.data || this.#sessions.events.attachment(id, a.ref) }));
        if (attachments.some(a => !a.data)) throw new Error('A refused attachment is no longer available. Resume manually.');
      }
      await this.#sessions.input(id, prompt, { turnId, attachments, delivery: 'queue', source: 'usage-reset' });
      if (recovery.retryTurnId && this.#core.outbox.get(id)?.some(item => item.turnId === turnId)) {
        this.#sessions.reorderQueue(id, [turnId, ...this.#core.outbox.get(id).filter(item => item.turnId !== turnId).map(item => item.turnId)]);
      }
      if (!recoveryDue(session, now) || session.stoppedAt || generation !== (session.stopGeneration ?? 0) || session.recovery !== recovery) {
        this.#sessions.dequeue(id, turnId);
        return { skipped: true };
      }
    }
    delete session.stoppedAt;
    delete session.recovery;
    session.queuePaused = false;
    this.#core.save(); this.#sessions.emit('session', session);
    if (this.#core.outbox.get(id)?.length) this.#core.delivery.pump(session);
    else if (!automatic) await this.#sessions.input(id, 'Continue the previous task from the saved conversation. Check what already finished before taking further action.');
    return { ok: true, session: wire(session) };
  }
}
