import { existsSync } from 'node:fs';
import { expand } from './paths.js';
import { dropMergedBranch, keepReason, makeChatWorktree, removeChatWorktree, renameChatBranch, repoConfig, restoreChatWorktree, runSetup, uncommitted, worktreePlan } from './chat-worktree.js';

/** How often idle chats are checked for a branch merged back. */
const SWEEP_MS = 2 * 60_000;
/**
 * A chat quiet this long loses a worktree it never committed to: one never
 * sent a message, or one whose work was outside the repo, kept it forever.
 */
export const UNUSED_MS = 60 * 60_000;

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
  /** Worktree folders being removed, from their agents' release to the end. */
  #removing = new Map();
  /** Stops the setup commands running now when the daemon goes away. */
  #stopping = new AbortController();
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

  /**
   * The repo's setup command, while the chat says it is setting up. False
   * when the daemon stopped it: the chat stays "setting up" on disk, and the
   * next daemon runs it again from the start (`setupCommand`).
   */
  async setup(s, command) {
    const signal = this.#stopping.signal;
    let result;
    try {
      // A folder removed since it was made (a restart, by hand) comes back first.
      await this.ensure(s);
      result = command ? await runSetup(command, expand(s.chatWorktree.path), { signal }) : { ok: true };
    } catch (err) { result = { ok: false, output: err.message }; }
    if (signal.aborted) return false;
    if (this.#core.index.get(s.id) !== s) return false;
    if (result.ok) delete s.chatWorktree.setup;
    else {
      s.chatWorktree.setup = 'failed';
      this.say(s, `The setup command in helm.json failed, so the agent starts without it.\n${result.output.slice(-1500)}`);
    }
    return true;
  }

  /** The setup command a chat's worktree asks for now, read from its own helm.json. */
  setupCommand(s) {
    return repoConfig(expand(s.chatWorktree.path))?.setup ?? repoConfig(expand(s.chatWorktree.repo))?.setup ?? null;
  }

  /** Before an agent starts: a chat reopened after its folder was removed gets it back. */
  async ensure(s) {
    // A removal under way still shows the folder: an agent started now
    // finds it gone a moment later and fails.
    await this.#removing.get(s.chatWorktree?.path);
    if (!s.chatWorktree || existsSync(expand(s.chatWorktree.path))) return;
    let record;
    try { record = await restoreChatWorktree(s.chatWorktree); }
    catch (err) { throw new Error(`could not rebuild this chat's worktree: ${err.message}`); }
    if (!record) return;
    for (const o of this.#sharing(s)) o.chatWorktree = { ...record, setup: o.chatWorktree.setup };
    this.#core.save();
  }

  /** Whether the chat's folder is being removed right now. */
  removing(s) { return this.#removing.has(s.chatWorktree?.path); }

  /** The chat has a name: the branch takes it while it holds no commits. */
  async titled(s) {
    // A helper's branch is named after its task already, and its parent was told that name.
    if (!s.chatWorktree || s.delegation || this.#busy.has(s.id)) return;
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

  stop() {
    clearInterval(this.#timer);
    this.#timer = null;
    this.#stopping.abort();
    this.#stopping = new AbortController();
  }

  async sweep() {
    for (const s of [...this.#core.index.values()]) {
      if (s.chatWorktree && s.chatWorktree.setup !== 'running') await this.tidy(s);
    }
  }

  /**
   * An idle chat whose branch is merged into its base loses its folder and
   * branch. Uncommitted changes, unmerged commits, or a branch with no work
   * of its own (the chat may still be starting on it) keep them; the last
   * only until the chat has been quiet for UNUSED_MS. Quiet that long with
   * unmerged commits and nothing else in the folder, the chat is parked: the
   * folder goes, the branch stays, and the branch goes once it is merged.
   */
  async tidy(s, now = Date.now()) {
    // A branch of the chat (a fork) works in the same folder: all of them idle.
    // A Codex thread still open in its daemon is in use too. Removing its
    // folder released Helm's link, the 2.5 s native check joined it again and
    // rebuilt the folder, and 3 s later it went again: a full checkout and a
    // dozen git commands every 3 s, for as long as Codex kept it open.
    const idle = () => this.#sharing(s).every((o) => this.#core.index.get(o.id) === o && this.#sessions.canReturnTask(o.id)
      && !this.#core.natives?.holds(o));
    if (this.#busy.has(s.id) || !s.chatWorktree || !idle()) return false;
    const quiet = this.#sharing(s).every((o) => now - (o.updatedAt || o.createdAt || now) >= UNUSED_MS);
    const merged = !quiet;
    // What to do with the folder: null keeps it, 'park' keeps only the branch.
    const verdict = async () => {
      const reason = await keepReason(s.chatWorktree, { merged });
      if (!reason) return 'remove';
      if (reason === 'unmerged' && quiet && !await uncommitted(s.chatWorktree, { ignored: true })) return 'park';
      return null;
    };
    this.#busy.add(s.id);
    const path = s.chatWorktree.path;
    let removed = null;
    try {
      if (s.chatWorktree.parked) {
        // A message now waits, then rebuilds the folder from base if the branch went.
        this.#removing.set(path, new Promise((resolve) => { removed = resolve; }));
        if (!await dropMergedBranch(s.chatWorktree)) return false;
        for (const o of this.#sharing(s)) delete o.chatWorktree.parked;
        this.#core.save();
        this.#sessions.log(`[${s.id}] removed merged branch ${s.chatWorktree.branch}`);
        return true;
      }
      const action = await verdict();
      if (!action) return false;
      this.#removing.set(path, new Promise((resolve) => { removed = resolve; }));
      // The agent's process sits in that folder: let it go first. Its
      // conversation stays, and the next message rebuilds the folder.
      for (const o of this.#sharing(s)) await this.#sessions.release(o.id);
      if (this.#core.index.get(s.id) !== s || !idle() || await verdict() !== action) return false;
      const park = action === 'park';
      await removeChatWorktree(s.chatWorktree, { keepBranch: park });
      if (park) {
        for (const o of this.#sharing(s)) o.chatWorktree = { ...o.chatWorktree, parked: true };
        this.#core.save();
      }
      this.#sessions.log(`[${s.id}] removed ${park ? 'parked' : merged ? 'merged' : 'unused'} worktree ${s.chatWorktree.path} (${s.chatWorktree.branch}${park ? ' kept' : ''})`);
      for (const o of this.#sharing(s)) this.#sessions.emit('session', o);
      return true;
    } catch (err) {
      this.#sessions.log(`[${s.id}] could not remove its worktree: ${err.message}`);
      return false;
    } finally {
      this.#busy.delete(s.id);
      if (removed) { this.#removing.delete(path); removed(); }
    }
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
