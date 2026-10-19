import { existsSync } from 'node:fs';
import { expand } from './paths.js';
import { keepReason, makeChatWorktree, removeChatWorktree, renameChatBranch, restoreChatWorktree, runSetup, worktreePlan } from './chat-worktree.js';

/** How often idle chats are checked for a branch merged back. */
const SWEEP_MS = 2 * 60_000;

/**
 * A chat's own worktree (chat-worktree.js) over its life: made before its
 * agent starts, the branch named after the chat, rebuilt when a reopened
 * chat finds its folder gone, and removed once its work is merged back.
 */
export class SessionWorktrees {
  #sessions;
  #core;
  #timer = null;
  /** Chats whose worktree is being checked or removed right now. */
  #busy = new Set();
  constructor(sessions, core) {
    this.#sessions = sessions;
    this.#core = core;
  }

  /** Only a new chat in a folder; never a quick chat, the brain, a clone or a hidden helper. */
  plan({ cwd, quick, brain, clone, delegation }) {
    if (quick || brain || clone || delegation?.hidden || !cwd) return null;
    return worktreePlan(cwd).catch(() => null);
  }

  /** The worktree for a chat being started, or an error to show in it. */
  async make(plan, id) {
    try { return await makeChatWorktree(plan, id); }
    catch (err) {
      this.#sessions.log(`[${id}] could not make a worktree: ${err.message}`);
      return { error: `Helm could not make this chat's own worktree, so it works in ${plan.root}: ${err.message}` };
    }
  }

  /** A line in the chat, the way other start-up problems show. */
  say(s, message) {
    const event = this.#sessions.events.append(s.id, { type: 'error', kind: 'worktree', message });
    s.lastSeq = event.seq;
    this.#sessions.emit('event', { id: s.id, event });
  }

  /** The repo's setup command, while the chat says it is setting up. */
  async setup(s, command) {
    const result = await runSetup(command, expand(s.chatWorktree.path));
    if (this.#core.index.get(s.id) !== s) return;
    if (result.ok) delete s.chatWorktree.setup;
    else {
      s.chatWorktree.setup = 'failed';
      this.say(s, `The setup command in helm.json failed, so the agent starts without it.\n${result.output.slice(-1500)}`);
    }
  }

  /** Before an agent starts: a chat reopened after its folder was removed gets it back. */
  async ensure(s) {
    if (!s.chatWorktree || existsSync(expand(s.chatWorktree.path))) return;
    let record;
    try { record = await restoreChatWorktree(s.chatWorktree); }
    catch (err) { throw new Error(`could not rebuild this chat's worktree: ${err.message}`); }
    if (!record) return;
    for (const o of this.#sharing(s)) o.chatWorktree = { ...record, setup: o.chatWorktree.setup };
    this.#core.save();
  }

  /** The chat has a name: the branch takes it while it holds no commits. */
  async titled(s) {
    if (!s.chatWorktree || this.#busy.has(s.id)) return;
    this.#busy.add(s.id);
    try {
      const branch = await renameChatBranch(s.chatWorktree, s.title);
      if (!branch || this.#core.index.get(s.id) !== s) return;
      for (const o of this.#sharing(s)) {
        o.chatWorktree = { ...o.chatWorktree, branch };
        this.#sessions.emit('session', o);
      }
      this.#core.save();
    } catch (err) { this.#sessions.log(`[${s.id}] could not rename the worktree branch: ${err.message}`); }
    finally { this.#busy.delete(s.id); }
  }

  /** Check every chat with a worktree now, then every few minutes. */
  watch() {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.#timer.unref?.();
    void this.sweep();
  }

  stop() { clearInterval(this.#timer); this.#timer = null; }

  async sweep() {
    for (const s of [...this.#core.index.values()]) {
      if (s.chatWorktree && s.chatWorktree.setup !== 'running') await this.tidy(s);
    }
  }

  /**
   * An idle chat whose branch is merged into its base loses its folder and
   * branch. Uncommitted changes, unmerged commits, or a branch with no work
   * of its own (the chat may still be starting on it) keep them.
   */
  async tidy(s) {
    // A branch of the chat (a fork) works in the same folder: all of them idle.
    const idle = () => this.#sharing(s).every((o) => this.#core.index.get(o.id) === o && this.#sessions.canReturnTask(o.id));
    if (this.#busy.has(s.id) || !s.chatWorktree || !idle()) return false;
    this.#busy.add(s.id);
    try {
      if (await keepReason(s.chatWorktree)) return false;
      // The agent's process sits in that folder: let it go first. Its
      // conversation stays, and the next message rebuilds the folder.
      for (const o of this.#sharing(s)) await this.#sessions.release(o.id);
      if (this.#core.index.get(s.id) !== s || !idle() || await keepReason(s.chatWorktree)) return false;
      await removeChatWorktree(s.chatWorktree);
      this.#sessions.log(`[${s.id}] removed merged worktree ${s.chatWorktree.path} (${s.chatWorktree.branch})`);
      for (const o of this.#sharing(s)) this.#sessions.emit('session', o);
      return true;
    } catch (err) {
      this.#sessions.log(`[${s.id}] could not remove its worktree: ${err.message}`);
      return false;
    } finally { this.#busy.delete(s.id); }
  }

  /** Chats in the same worktree as `s`, itself included. */
  #sharing(s) {
    return [s, ...[...this.#core.index.values()].filter((o) => o !== s && o.chatWorktree?.path === s.chatWorktree?.path)];
  }

  /** A deleted chat takes its worktree along when nothing in it would be lost. */
  async dropped(s) {
    if (!s.chatWorktree || !existsSync(expand(s.chatWorktree.path))) return;
    if ([...this.#core.index.values()].some((o) => o !== s && o.chatWorktree?.path === s.chatWorktree.path)) return;
    try {
      if (!await keepReason(s.chatWorktree, { merged: false })) await removeChatWorktree(s.chatWorktree);
    } catch (err) { this.#sessions.log(`[${s.id}] could not remove its worktree: ${err.message}`); }
  }
}
