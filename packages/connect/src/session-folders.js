import { existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { collapse, expand, isQuickDir } from './paths.js';
import { ENGINES } from './engines.js';
import { projectKeysFor } from './project-key.js';
import { indexedFolders } from './fs.js';
import { listProjects, removeProject, saveProject } from './settings.js';
import { conversationFile } from './chat-move.js';
import { claudeTranscript, findMovedFolder, folderStamp, linkClaudeHistory, movedPath, realFolder,
  recordedFolder, waitingFolder } from './chat-folder.js';

const isDir = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };
const homeOf = (profile) => expand(profile?.env?.[ENGINES[profile?.engine]?.homeEnv] ?? ENGINES[profile?.engine]?.defaultHome ?? '~');
const BUSY = new Set(['starting', 'working', 'blocked']);

/**
 * A chat's folder over its life (chat-folder.js): what identifies it, kept
 * when the agent starts there; where it went when it is missing; and a
 * change of folder on purpose. A chat never dies of its folder. When the
 * folder cannot be found the agent starts in an empty folder of Helm's,
 * the chat says why, and the app offers to pick the folder.
 */
export class SessionFolders {
  #sessions;
  #core;
  /** One search per missing folder, shared by every chat that was in it. */
  #finding = new Map();
  constructor(sessions, core) {
    this.#sessions = sessions;
    this.#core = core;
  }

  /** A line in the chat. `note`: news, not a failure. */
  say(s, message, note = false) {
    const event = this.#sessions.events.append(s.id, { type: 'error', kind: 'folder', message, ...(note ? { tone: 'note' } : {}) });
    s.lastSeq = event.seq;
    this.#sessions.emit('event', { id: s.id, event });
  }

  /** The folder exists: keep what finds it again after a rename or a fresh clone. */
  note(s, dir) {
    const stamp = folderStamp(dir);
    if (!stamp) return;
    if (s.folderStamp !== stamp) { s.folderStamp = stamp; if (this.#core.index.get(s.id) === s) this.#core.save(); }
    void projectKeysFor([dir]).then((keys) => {
      const found = keys[dir] ?? [];
      if (!found.length || JSON.stringify(found) === JSON.stringify(s.folderKeys ?? [])) return;
      s.folderKeys = found;
      if (this.#core.index.get(s.id) === s) this.#core.save();
    }).catch(() => {});
  }

  /** Claude resumes only from its folder's own place: put the conversation there. */
  history(s, profile, dir) {
    // A chat that never ran has no conversation yet to look for.
    if (s.engine !== 'claude' || (!s.hasInput && !s.forkFrom)) return;
    const home = homeOf(profile);
    for (const id of [s.engineSessionId, s.forkFrom?.sessionId]) {
      if (!id) continue;
      try {
        const how = linkClaudeHistory(home, id, dir);
        if (how === 'linked' || how === 'copied') this.#sessions.log(`[${s.id}] ${how} Claude conversation ${id} into ${dir}`);
      } catch (err) { this.#sessions.log(`[${s.id}] could not carry Claude conversation ${id} to ${dir}: ${err.message}`); }
    }
  }

  /**
   * The folder an agent starts in, just before it starts. Mostly the
   * chat's own. A chat that has never run keeps the plain "folder does
   * not exist" error: there is nothing in it to keep.
   */
  async prepare(s, profile) {
    if (!s.cwd || s.quick || isQuickDir(s.cwd)) return s.cwd;
    const dir = expand(s.cwd);
    if (isDir(dir)) {
      if (s.folderLost) {
        delete s.folderLost;
        this.#core.save();
        this.#sessions.emit('session', s);
        this.say(s, `The folder ${collapse(dir)} is back. This chat works there again.`, true);
      }
      this.note(s, dir);
      this.history(s, profile, dir);
      return dir;
    }
    if (!s.engineSessionId && !s.hasInput && !s.prompts) return dir;
    const search = await this.#find(s, profile, dir);
    if (search.found && search.found !== dir) {
      this.#moveAll(dir, search.found);
      const now = expand(s.cwd);
      this.say(s, `The folder ${collapse(dir)} is missing. Helm found it at ${collapse(now)}, so this chat works there now.`, true);
      this.history(s, profile, now);
      return now;
    }
    const waiting = waitingFolder(s.id);
    mkdirSync(waiting, { recursive: true, mode: 0o700 });
    const candidates = search.candidates.map(collapse);
    const fresh = s.folderLost?.path !== collapse(dir);
    if (fresh || JSON.stringify(s.folderLost.candidates ?? []) !== JSON.stringify(candidates)) {
      s.folderLost = { path: collapse(dir), at: fresh ? Date.now() : s.folderLost.at, ...(candidates.length ? { candidates } : {}) };
      this.#core.save();
      this.#sessions.emit('session', s);
    }
    if (fresh) {
      this.say(s, `The folder ${collapse(dir)} is missing, and Helm could not find where it went. `
        + 'This chat works in an empty folder for now. Pick the folder to continue there.');
    }
    this.history(s, profile, waiting);
    return waiting;
  }

  /** Where `dir` went, searched once for every chat that was in it. */
  #find(s, profile, dir) {
    let pending = this.#finding.get(dir);
    if (pending) return pending;
    pending = this.#search(s, profile, dir).catch((err) => {
      this.#sessions.log(`[${s.id}] could not look for ${dir}: ${err.message}`);
      return { found: null, candidates: [] };
    }).finally(() => this.#finding.delete(dir));
    this.#finding.set(dir, pending);
    return pending;
  }

  async #search(s, profile, dir) {
    const home = homeOf(profile);
    const file = s.engine === 'claude' ? claudeTranscript(home, s.engineSessionId)
      : s.engine === 'codex' && s.engineSessionId ? conversationFile(s, home) : null;
    const said = recordedFolder(s.engine, file);
    // The empty folder a lost chat waits in is no answer to where it went.
    const recorded = said && !said.startsWith(waitingFolder('')) && !isQuickDir(said) ? [said] : [];
    const others = [...this.#core.index.values()].filter((o) => o.cwd && !o.quick).map((o) => expand(o.cwd))
      .filter((path) => path !== dir && isDir(path)).map((path) => ({ path, repo: existsSync(`${path}/.git`) }));
    const list = this.#sessions.folderCandidates ?? indexedFolders;
    const found = await findMovedFolder({
      missing: dir, stamp: s.folderStamp ?? null, keys: s.folderKeys ?? null, recorded,
      folders: async () => [...others, ...await list()],
      keysOf: (dirs) => projectKeysFor(dirs),
    });
    if (found.found) this.#sessions.log(`[${s.id}] folder ${dir} found at ${found.found} (${found.how})`);
    return found;
  }

  /**
   * Every chat in `from`, or in a folder inside it, now works in `to`, the
   * way a T3 Code project moves all its threads at once. A saved project
   * moves with them. A chat still working keeps its agent; the new folder
   * is used from its next start.
   */
  #moveAll(from, to) {
    const moved = [];
    for (const o of this.#core.index.values()) {
      if (!o.cwd || o.quick) continue;
      const next = movedPath(expand(o.cwd), from, to);
      if (!next) continue;
      o.cwd = next;
      delete o.folderLost;
      if (o.chatWorktree?.repo) {
        const repo = movedPath(expand(o.chatWorktree.repo), from, to);
        if (repo) o.chatWorktree = { ...o.chatWorktree, repo };
      }
      moved.push(o);
    }
    try {
      const saved = listProjects();
      for (const p of saved) {
        const next = movedPath(expand(p.path), from, to);
        if (!next) continue;
        removeProject(p.path);
        saveProject({ path: collapse(next), title: p.title });
      }
    } catch (err) { this.#sessions.log(`could not move the saved project ${from}: ${err.message}`); }
    this.#core.save();
    for (const o of moved) {
      this.#sessions.emit('session', o);
      if (this.#core.drivers.has(o.id)) void this.#core.release(o);
    }
    return moved;
  }

  /**
   * The owner, or an agent, picks a chat's folder. `all` moves every chat
   * that was in the old folder with it. Refused while the chat works: its
   * step finishes first.
   */
  async change(id, folder, { all = true } = {}) {
    const s = this.#sessions.get(id);
    if (!s.driver) throw new Error('Only an agent chat can change its folder.');
    if (s.quick) throw new Error('This chat has no folder.');
    if (s.external || s.nativeCli) throw new Error('This chat runs in a terminal. Open it in Helm first.');
    const wanted = String(folder ?? '').trim();
    if (!wanted) throw new Error('Name the folder.');
    const target = realFolder(resolve(expand(wanted)));
    if (!isDir(target)) throw new Error(`The folder ${collapse(target)} does not exist on this machine.`);
    if (BUSY.has(s.status) || this.#core.deliveryState.isSending(id) || this.#sessions.events.activeTurn(id)) {
      throw new Error('The chat is working. Change the folder when it stops.');
    }
    const from = expand(s.cwd);
    if (from === target && !s.folderLost) return { session: s, moved: [] };
    const released = await this.#core.release(s);
    if (!released) throw new Error('The chat is working. Change the folder when it stops.');
    const moved = all && !s.chatWorktree ? this.#moveAll(from, target) : [];
    if (!moved.includes(s)) {
      s.cwd = target;
      delete s.folderLost;
      this.#core.save();
      this.#sessions.emit('session', s);
      moved.push(s);
    }
    this.note(s, target);
    for (const o of moved) {
      const others = moved.length > 1 && o === s ? ` ${moved.length - 1} other ${moved.length === 2 ? 'chat' : 'chats'} in that folder moved too.` : '';
      this.say(o, `The folder of this chat is now ${collapse(expand(o.cwd))}.${others}`, true);
    }
    return { session: s, moved: moved.map((o) => o.id) };
  }
}
