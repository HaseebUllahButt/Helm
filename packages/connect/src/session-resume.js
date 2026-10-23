import { loadProfiles, materialize } from './profiles.js';
import { activeTurnFromEvents } from './events.js';
import { hostedProcId } from './hosted-process.js';

/** How a recovery note says the agent's state could not be checked. */
const RECONNECT_FAILED = 'Helm did not reconnect to the agent:';

/** Run async jobs at most `n` at a time: `slot(() => work())` returns the job's promise. */
const limiter = (n) => {
  let running = 0;
  const waiting = [];
  const next = () => { running--; waiting.shift()?.(); };
  return (job) => new Promise((resolve, reject) => {
    const run = () => { running++; Promise.resolve().then(job).then(resolve, reject).finally(next); };
    if (running < n) run(); else waiting.push(run);
  });
};

/** A helper's newest finished turn, from its recent events; local status cards do not count. */
const lastTaskResult = (tail) => {
  const cards = new Set(tail.filter((event) => event.type === 'turn.start' && event.local === true).map((event) => event.turnId));
  return tail.findLast((event) => event.type === 'turn.done' && !String(event.turnId).startsWith('local-') && !cards.has(event.turnId)) ?? null;
};

/**
 * After a daemon restart: find which terminals and agent processes
 * survived, listen to them again, and settle the work that cannot finish.
 */
export class SessionResume {
  #sessions;
  #core;
  constructor(sessions, core) {
    this.#sessions = sessions;
    this.#core = core;
  }

  /**
   * Find out which terminals outlived this daemon.
   *
   * The host holds them, so an upgrade or a crash leaves them running - but
   * not forever, and not if the host itself was stopped. Anything the host
   * does not have is genuinely gone, and its record goes with it rather than
   * offering a phone a terminal that no longer exists.
   */
  async adoptTerminals() {
    const ok = await this.#sessions.terminals.ensure({ spawn: false }).catch(() => false);
    await this.#sessions.nativeTerminals.ensure({ spawn: false }).catch(() => false);
    // The proc host's hello carries which agent processes survived; resume()
    // reads that list to leave their open turns and questions standing.
    await this.#sessions.procs.ensure({ spawn: false }).catch(() => false);
    let changed = false;
    for (const s of [...this.#core.index.values()]) {
      if (!s.pty) continue;
      if (this.#core.terminal(s).has(s.id)) continue;
      this.#core.index.delete(s.id);
      changed = true;
      this.#sessions.emit('session', { ...s, status: 'exited', alive: false });
    }
    if (changed) this.#core.save();
    return ok;
  }

  /**
   * A hosted agent process died while detached, or with no driver ever
   * bound after a restart. The turns and questions it left open are
   * unanswerable now - close them the way `resume` does for a dead process.
   */
  procGone(id) {
    const s = this.#core.index.get(id);
    if (!s?.driver || this.#core.drivers.has(id)) return;
    const tail = this.#sessions.events.tail(id, 0);
    const closed = new Set(tail.filter((e) => ['turn.done', 'turn.remove'].includes(e.type)).map((e) => e.turnId));
    // A message still waiting in the queue never reached the dead process:
    // it stays queued, and goes to the next one.
    const waiting = new Set((this.#core.outbox.get(id) ?? []).map((item) => item.turnId));
    for (const e of tail) {
      if (e.type !== 'turn.start' || closed.has(e.turnId) || waiting.has(e.turnId)) continue;
      closed.add(e.turnId);
      this.#sessions.events.append(id, { type: 'turn.done', turnId: e.turnId, status: 'interrupted', error: 'agent exited' });
    }
    for (const p of this.#sessions.events.pending(id)) {
      this.#sessions.events.append(id, { type: 'permission.resolved', requestId: p.requestId, decision: 'cancelled' });
    }
    this.#core.settled(id);
    if (s.status !== 'idle') {
      s.status = 'idle';
      s.updatedAt = Date.now();
      const event = this.#sessions.events.append(id, { type: 'status', status: 'idle' });
      s.lastSeq = event.seq;
      this.#sessions.emit('event', { id, event });
      this.#sessions.emit('session', s);
      this.#core.save();
    }
    this.#core.delivery.pump(s);
  }

  /** Whether the record is holding work because its agent could not be checked. */
  unreachable(s) {
    return s.recovery?.kind === 'error' && [RECONNECT_FAILED, 'Could not reconnect to the agent:']
      .some(prefix => s.recovery.message?.startsWith(prefix));
  }

  /** A failed reattach that has since succeeded no longer needs attention. */
  reconnected(s) {
    if (!this.unreachable(s)) return;
    delete s.recovery;
    s.queuePaused = false;
    this.#core.save();
    this.#sessions.emit('session', s);
  }

  /** Rebuild unsent tickets from the log and settle turns that cannot resume. */
  #restoreOpenTurns(s, tail, processAlive) {
    const edits = new Map(tail.filter((event) => event.type === 'turn.edit').map((event) => [event.turnId, event]));
    tail = tail.map((event) => {
      const edit = event.type === 'turn.start' && edits.get(event.turnId);
      return edit ? { ...event, text: edit.text, ...(edit.attachments ? { attachments: edit.attachments } : {}) } : event;
    });
    const closed = new Set(tail.filter((e) => e.type === 'turn.done').map((e) => e.turnId));
    const removed = new Set(tail.filter((e) => e.type === 'turn.remove').map((e) => e.turnId));
    const accepted = new Set(tail.filter((e) => e.type === 'turn.accept').map((e) => e.turnId));
    const delivered = new Set(tail.filter((e) => e.type === 'turn.deliver').map((e) => e.turnId));
    const echoes = tail.filter((e) => e.type === 'turn.start'
      && !e.wake && !String(e.turnId).startsWith('local-') && e.queued !== true);
    const open = tail.filter((e) => e.type === 'turn.start'
      && !closed.has(e.turnId) && !removed.has(e.turnId));
    // A hosted process may still be in its current real turn. Queued local
    // turns can follow it in the log, so use the last real turn, not simply
    // the last open turn, as the one to leave running.
    const active = processAlive ? activeTurnFromEvents(tail) : null;
    // The provider moved past any of its turns older than its newest one;
    // those finished with the run that followed, whatever became of it.
    const latest = echoes.findLast((e) => !e.local);
    const revive = [];
    // A delegated task finishes with its newest work, not with whichever
    // old card happens to be tidied first - and not at all while its live
    // turn is being kept.
    let finished = null;
    const settle = (turnId, status, error, { ends = true } = {}) => {
      if (ends) finished = status;
      const event = this.#sessions.events.append(s.id, { type: 'turn.done', turnId, status, ...(error ? { error } : {}) });
      s.lastSeq = event.seq;
      this.#sessions.emit('event', { id: s.id, event });
    };

    for (const e of open) {
      // A local status card is not work held by the surviving CLI. Older
      // logs can contain an unfinished card; settle it without manufacturing
      // either an active provider turn or a restart recovery warning.
      if (e.local === true) { settle(e.turnId, 'ok', null, { ends: false }); continue; }
      // A queued ticket under a caller-chosen id is still a ticket.
      const local = String(e.turnId).startsWith('local-') || e.queued === true;
      const mine = (e.text ?? '').trim();
      const echoIndex = local ? echoes.findIndex((x) => x.seq > e.seq && (x.inputId != null
        ? x.inputId === e.turnId
        : (x.text ?? '').trim() === mine || (mine && (x.text ?? '').trim().startsWith(mine + '\n'))
      )) : -1;
      const echoed = echoIndex >= 0;
      if (echoed) echoes.splice(echoIndex, 1);

      if (local && (accepted.has(e.turnId) || delivered.has(e.turnId))) {
        // `turn.accept` records a successful steer into a live turn; never
        // send that ticket again if the daemon restarted before its echo.
        // A ticket handed over but not yet used went to the CLI all the same.
        if (!accepted.has(e.turnId)) {
          const event = this.#sessions.events.append(s.id, { type: 'turn.accept', turnId: e.turnId });
          s.lastSeq = event.seq;
          this.#sessions.emit('event', { id: s.id, event });
        }
        settle(e.turnId, 'ok', null, { ends: false });
        continue;
      }
      if (local && e.queued === true && !echoed) {
        if (this.#core.delegation.discardConsumedResult(s, e.turnId)) continue;
        // The event log is the queue. Recover the text, compact command, and
        // image bytes from it in sequence order; the small attachment refs
        // themselves are deliberately not enough to send to a driver.
        let text = e.text ?? '';
        if (s.brain) {
          const body = text.replace(/^\[helm [^\]\n]*\]\n\n/, '');
          const line = this.#sessions.brief?.();
          text = line ? `${line}\n\n${body}` : body;
        }
        const images = (e.attachments ?? [])
          .map((a) => ({
            filename: a.filename,
            mime: a.mime,
            data: a.data ?? (a.ref ? this.#sessions.events.attachment(s.id, a.ref) : null),
          }))
          .filter((a) => a.data);
        if (!text && !images.length) {
          settle(e.turnId, 'interrupted', 'queued message could not be restored after restart', { ends: false });
          continue;
        }
        revive.push({
          source: e.source,
          turnId: e.turnId,
          text,
          images,
          compact: e.compact ?? null,
          delivery: e.delivery ?? 'auto',
          references: e.references ?? [],
          referenceContext: e.referenceContext,
          introduce: e.introduce === true,
          stopGeneration: s.stopGeneration ?? 0,
        });
        continue;
      }
      if (processAlive && active?.turnId === e.turnId) continue;
      if (latest && latest.seq > e.seq) { settle(e.turnId, 'ok', null, { ends: false }); continue; }
      // Helm never owned a native thread's process, so its restart did not
      // stop it; the daemon check settles those turns from Codex's record.
      // An echoed ticket is a leftover; the echo is the turn that counts.
      settle(e.turnId, echoed ? 'ok' : 'interrupted', echoed ? null : s.nativeSocket ? 'Codex is no longer running this turn.' : 'helm restarted', { ends: !echoed });
      if (!echoed && !processAlive && !s.nativeSocket) s.recovery = { kind: 'restart', message: 'The agent stopped. Resume from the saved conversation.', at: Date.now() };
    }
    if (finished && !(processAlive && active) && s.delegation && !['done', 'error', 'interrupted'].includes(s.delegation.status)) {
      s.delegation.status = finished === 'ok' ? 'done' : finished;
    }

    if (revive.length) {
      const order = new Map((s.queueOrder ?? []).map((turnId, index) => [turnId, index]));
      revive.sort((left, right) => (order.get(left.turnId) ?? Infinity) - (order.get(right.turnId) ?? Infinity));
      this.#core.outbox.set(s.id, [...(this.#core.outbox.get(s.id) ?? []), ...revive]);
    }
  }

  /**
   * Work the agent still owes: a turn the log has not seen the end of, a
   * question, or queued messages. The log is asked as well as the status,
   * because a native thread's status is only what its daemon last said.
   */
  #inFlight(s) {
    return ['working', 'blocked', 'starting'].includes(s.status)
      || this.#sessions.events.pending(s.id).length > 0
      || (this.#core.outbox.get(s.id)?.length ?? 0) > 0
      || !!activeTurnFromEvents(this.#sessions.events.tail(s.id, 0));
  }

  /**
   * Listen again to an agent process that outlived the daemon. A failed
   * check is not a failed task: an idle thread with nothing in flight stays
   * idle and attaches on its next message, quietly. One that was working,
   * asking, or holding queued messages is held and marked until a retry
   * (three, ninety seconds apart) reaches it - a machine busy enough to time
   * out a read is usually fine a minute later.
   */
  async #reattach(s, attempt) {
    try {
      const d = await this.#core.driver(s);
      // Drivers start idle and suppress duplicate status events. Seed the
      // persisted state so an adopted idle process corrects a stale busy row.
      d.status = s.status;
      await d.start();
      this.reconnected(s);
      this.#core.delivery.pump(s);
      this.#core.reap(s, d.status);
    } catch (err) {
      if (!this.#core.index.has(s.id)) return;
      this.#sessions.log(`[${s.id}] could not reattach surviving agent: ${err.message}`);
      this.#core.drivers.delete(s.id);
      const busy = this.#inFlight(s);
      if (busy && attempt < 3) {
        const timer = setTimeout(() => { this.#core.reapers.delete(`reattach:${s.id}`); void this.#reattach(s, attempt + 1); }, this.#sessions.reattachRetryMs);
        timer.unref?.();
        this.#core.reapers.set(`reattach:${s.id}`, timer);
      }
      // An account process may be alive while this thread cannot be
      // checked. Hold the queue so nothing replays into work that may still
      // be running, and say so - but only when there is work to hold.
      s.status = 'idle';
      if (busy) {
        s.queuePaused = true;
        s.recovery = { kind: 'error', message: `${RECONNECT_FAILED} ${err.message}`, at: Date.now() };
      } else if (this.unreachable(s)) {
        // A mark left by an earlier restart, on a thread with nothing to hold.
        delete s.recovery; s.queuePaused = false;
      }
      const event = this.#sessions.events.append(s.id, { type: 'status', status: 'idle' });
      s.lastSeq = event.seq;
      this.#core.save();
      this.#sessions.emit('event', { id: s.id, event });
      this.#sessions.emit('session', s);
    }
  }

  /** Re-watch every surviving pane after a daemon restart. */
  async resume() {
    const reattaching = [];
    // One gate per account, not one for the machine: the crowd that timed
    // out was forty threads on one app-server, and a slow account must not
    // hold back the others' reconnects.
    const gates = new Map();
    const reattachSlot = (s, job) => {
      if (!gates.has(s.profileId)) gates.set(s.profileId, limiter(this.#sessions.reattachConcurrency));
      return gates.get(s.profileId)(job);
    };
    const profiles = loadProfiles()?.profiles ?? [];
    // Native Codex belongs to its terminal daemon, not Helm's proc host.
    // Discover its real loaded threads before deciding which turns survived.
    if (this.#sessions.nativeDiscovery) await this.#core.natives.discoverNativeCodex(profiles);
    for (const s of this.#core.index.values()) {
      // A terminal lives in the host process, which outlives us - so its
      // record stays until `adoptTerminals()` has asked what really survived.
      if (s.pty) continue;
      if (s.external) { await this.#core.external.refreshExternalActivity(s); continue; }
      if (!s.driver) { this.#sessions.runtime.watch(this.#core.handle(s)); continue; }
      // An agent process the host kept is still running whatever it was
      // running: its active turn and questions are still answerable. Any
      // unmatched queued tickets are rebuilt from the log for when it settles.
      const profile = profiles.find((p) => p.id === s.profileId);
      const procId = hostedProcId(s, s.driver === 'codex' && profile ? materialize(profile) : null);
      // A thread its terminal still has open is alive even when attaching
      // to it just failed: settling its turn or replaying its queue would
      // put a second writer on work that is still running.
      const nativeAlive = s.nativeSocket && (this.#core.drivers.get(s.id)?.nativeConnected || this.#core.natives.nativeLoaded.has(s.engineSessionId));
      if (s.nativeSocket && !nativeAlive && this.#core.natives.nativeUnknown.has(s.profileId)) {
        // Its daemon is there but did not answer, so whether the thread is
        // still working is unknown. Keep its turn, question and status as
        // they were; hold the queue so nothing is sent into work that may
        // still be running. The next answer from the daemon settles it.
        if (s.recovery?.kind === 'restart') delete s.recovery;
        this.#restoreOpenTurns(s, this.#sessions.events.tail(s.id, 0), true);
        // Only a thread with work in flight has anything to hold or to warn
        // about; an idle one simply carries on at its next message.
        if (this.#inFlight(s)) {
          s.queuePaused = true;
          s.recovery = { kind: 'error', message: `${RECONNECT_FAILED} Codex did not answer, so this thread could not be checked.`, at: Date.now() };
        } else if (this.unreachable(s)) {
          // A mark left by an earlier restart, on a thread with nothing to hold.
          delete s.recovery; s.queuePaused = false;
        }
        s.lastSeq = this.#sessions.events.last(s.id);
        this.#sessions.emit('session', s);
        continue;
      }
      if (nativeAlive || !s.nativeSocket && procId && this.#sessions.procs.hasProc(procId)) {
        if (s.recovery?.kind === 'restart') delete s.recovery;
        const tail = this.#sessions.events.tail(s.id, 0);
        this.#restoreOpenTurns(s, tail, true);
        s.lastSeq = this.#sessions.events.last(s.id);
        // Listen immediately, including to unattended threads. Otherwise a
        // turn that finishes during the update stays busy until someone opens
        // the thread, and its queued messages never get delivered.
        // A few at a time per account: forty threads asking one app-server at
        // once on a busy machine all timed out together, and every one of
        // them read as a failed task.
        reattaching.push(reattachSlot(s, () => this.#reattach(s, 0)));
        continue;
      }
      // The process that asked died with the previous daemon; a prompt it
      // left open cannot be answered any more, so close it out here rather
      // than show a phone a question nobody can act on.
      // Only its turns and questions matter here, and most threads have
      // neither open: glancing at them leaves the rest of each log unread.
      const seen = this.#sessions.events.glance(s.id);
      for (const p of seen.pending) {
        this.#sessions.events.append(s.id, { type: 'permission.resolved', requestId: p.requestId, decision: 'cancelled' });
      }
      // The active turn died with the old daemon. Unsent queued tickets are
      // different: `#restoreOpenTurns` puts them back into the outbox rather
      // than closing them as though the agent had already seen them.
      this.#restoreOpenTurns(s, seen.turns, false);
      // The process a failed reconnect was about is gone; so is the mark.
      // Anything it was doing is settled just above, as "restart" if need be.
      if (this.unreachable(s)) { delete s.recovery; s.queuePaused = false; }
      if (s.status !== 'idle') {
        s.status = 'idle';
        s.updatedAt = Date.now();
        // The log is what a viewer replays for status: closing the turns
        // above without recording the settle leaves the last `working`
        // standing, and the session reads as busy until the next turn.
        const event = this.#sessions.events.append(s.id, { type: 'status', status: 'idle' });
        s.lastSeq = event.seq;
        this.#sessions.emit('event', { id: s.id, event });
        this.#sessions.emit('session', s);
      }
      s.lastSeq = this.#sessions.events.last(s.id);
      if (s.nativeAgents) { delete s.nativeAgents; this.#core.delegation.refreshTeam(s); }
      this.#core.delivery.pump(s);
    }
    this.#core.save();
    await Promise.allSettled(reattaching);
    for (const child of this.#core.index.values()) {
      if (!child.delegation) continue;
      this.#core.delegation.updateTeam(child);
      // Seqs are contiguous in a log's tail, so these are its last 500 events' turns.
      const { seq, turns } = this.#sessions.events.glance(child.id);
      const completed = lastTaskResult(turns.filter((event) => event.seq > seq - 500));
      if (completed && !this.#sessions.hasActiveDelegations(child.id) && !['working', 'blocked', 'starting'].includes(child.status)) {
        void this.#core.delegation.notifyParent(child, completed);
      }
    }
  }
}
