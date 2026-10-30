/**
 * Move a chat to another machine with its whole conversation.
 *
 * "Send task" starts a fresh agent there with a summary. A move instead
 * carries the CLI's own conversation file, so the agent on the other
 * machine resumes with everything it knew. Four steps, each saved to
 * ~/.helm/chat-moves/<moveId>.json so a restart picks up where it was:
 *
 *   copying-project  the chat's folder, over the resumable Send engine
 *   copying-chat     the conversation, renamed to a new id and pointed at
 *                    the folder's new path, laid out as the CLI's home
 *   opening          the target puts it in its CLI home and opens it as a
 *                    saved conversation: messages show, no agent starts
 *   done             the old chat is archived and refuses new messages
 *
 * The conversation gets a new id so a chat moved back, or moved twice,
 * never collides with the copy it came from.
 */
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync,
  statSync, writeFileSync, copyFileSync, createWriteStream, lstatSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { M } from '@helm/protocol';
import { beginTransferActivity } from '@helm/protocol/transfer-activity';
import { HELM_DIR, HOME, expand } from './paths.js';
import { getProfiles } from './profiles.js';
import { ENGINES } from './engines.js';

const ID = /^[a-f0-9]{24}$/;
const MOVABLE = new Set(['claude', 'codex']);
// Where each CLI keeps conversations inside its home. A pack may only
// write below these, so a move can never place a file anywhere else.
const TOP = { claude: 'projects', codex: 'sessions' };
const BUSY = new Set(['starting', 'working', 'blocked']);
const line = (value, max) => typeof value === 'string' && value.length > 0
  && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

/** Claude names a project folder after its path, every other character a dash. */
export const claudeKey = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

const homeOf = (profile) => expand(profile?.env?.[ENGINES[profile.engine]?.homeEnv] ?? ENGINES[profile.engine]?.defaultHome);

/** The conversation file a chat's CLI writes, found from its id. */
export function conversationFile(session, home) {
  if (session.transcript && existsSync(session.transcript)) return session.transcript;
  const id = session.engineSessionId;
  if (session.engine === 'claude') {
    const file = join(home, 'projects', claudeKey(expand(session.cwd)), `${id}.jsonl`);
    return existsSync(file) ? file : null;
  }
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { const hit = walk(path); if (hit) return hit; }
      else if (entry.name.endsWith(`-${id}.jsonl`)) return path;
    }
    return null;
  };
  return walk(join(home, 'sessions'));
}

/**
 * Rewrite one conversation line for its new place. Only the id and the
 * working folder change: message text stays byte for byte, because Claude
 * signs its thinking and a changed path inside it would fail the next turn.
 */
export function moveRecord(text, { oldId, newId, from, to }) {
  let record;
  try { record = JSON.parse(text); } catch { return text; }
  const under = (value) => value === from || value.startsWith(`${from}/`) ? to + value.slice(from.length) : value;
  const visit = (value, key) => {
    if (typeof value === 'string') {
      if (value === oldId) return newId;
      return key === 'cwd' || key === 'roots' ? under(value) : value;
    }
    if (Array.isArray(value)) return value.map((item) => visit(item, /roots$/i.test(key ?? '') ? 'roots' : null));
    if (value && typeof value === 'object') {
      for (const name of Object.keys(value)) value[name] = visit(value[name], name);
    }
    return value;
  };
  return JSON.stringify(visit(record, null));
}

async function rewriteFile(source, target, change) {
  mkdirSync(dirname(target), { recursive: true });
  const out = createWriteStream(target, { mode: 0o600 });
  const lines = createInterface({ input: createReadStream(source), crlfDelay: Infinity });
  for await (const text of lines) {
    if (!out.write(`${text.trim() ? moveRecord(text, change) : text}\n`)) await new Promise((r) => out.once('drain', r));
  }
  await new Promise((resolve, reject) => out.end((error) => error ? reject(error) : resolve()));
}

/** Copy a folder, rewriting each conversation file in it. */
async function rewriteTree(source, target, change) {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name.replaceAll(change.oldId, change.newId));
    if (entry.isDirectory()) await rewriteTree(from, to, change);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) await rewriteFile(from, to, change);
    else if (entry.isFile()) { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); }
  }
}

export class ChatMoves {
  constructor({ network, sessions, rpc, sendEngine, directory = join(HELM_DIR, 'chat-moves'), profiles = getProfiles }) {
    Object.assign(this, { network, sessions, rpc, sendEngine, directory, profiles });
    this.running = new Map();
  }

  #file(id) { return join(this.directory, `${id}.json`); }
  #read(id) { try { return JSON.parse(readFileSync(this.#file(id), 'utf8')); } catch { return null; } }
  #save(record) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = this.#file(record.moveId);
    writeFileSync(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
  #authorize(caller) {
    const net = this.network();
    if (!caller || net.revoked?.[caller] || !(caller === net.self || net.devices?.[caller])) {
      throw new Error('Only this machine or a paired device can move a chat.');
    }
    return net;
  }
  #view(record) {
    return { moveId: record.moveId, phase: record.phase, error: record.error ?? null,
      progress: record.progress ?? null, targetMachineId: record.targetMachineId, targetName: record.targetName,
      folder: record.targetFolder ?? null, sessionId: record.result?.sessionId ?? null };
  }

  /** Start a move, or report the one with this id. Asking again after a failure retries it. */
  async move(params, caller) {
    const net = this.#authorize(caller);
    if (!ID.test(params?.moveId ?? '')) throw new Error('invalid move id');
    const saved = this.#read(params.moveId);
    if (saved) {
      if (saved.sessionId !== params.sessionId || saved.targetMachineId !== params.targetMachineId) {
        throw new Error('This move does not match the one that started.');
      }
      if (saved.phase === 'failed' && params.retry === true) this.#retry(saved);
      if (!['done', 'failed'].includes(saved.phase)) this.#run(saved);
      return this.#view(saved);
    }
    const session = this.sessions.get(params.sessionId);
    if (!MOVABLE.has(session.engine) || !session.engineSessionId) {
      throw new Error('Only Claude and Codex chats can move. Use "Send to another machine" for this chat.');
    }
    if (session.brain || session.delegation?.parentId || session.engine === 'shell') throw new Error('Move the main chat, not a helper.');
    if (session.movedAway) throw new Error(`This chat already moved to ${session.movedAway.machineName}.`);
    if (session.moving) throw new Error('Helm is already moving this chat.');
    if (session.externalActive || session.nativeCli || session.nativeChat) throw new Error('This chat runs in a terminal. Close it there first.');
    if (BUSY.has(session.status)) throw new Error('Wait for the reply to finish, then move the chat.');
    const target = net.machines?.[params.targetMachineId];
    if (!target || target.id === net.self || net.revoked?.[target.id]) throw new Error('Choose another machine in this network.');
    if (!line(params.profileId, 256)) throw new Error('Choose an agent account on the other machine.');
    const cwd = resolve(expand(session.cwd || '~'));
    if (cwd === HOME || cwd === '/') throw new Error('This chat works in your home folder. Helm cannot copy a whole home folder.');
    const profiles = await this.profiles();
    const home = homeOf(profiles.find((p) => p.id === session.profileId) ?? { engine: session.engine });
    const conversation = conversationFile(session, home);
    if (!conversation) throw new Error('Helm cannot find this chat\'s conversation file.');
    let agents;
    try { ({ agents } = await this.rpc(target.id, M.AGENT_LIST, { models: false }, { timeout: 60_000 })); }
    catch (error) { throw new Error(`Cannot check agent accounts on ${target.name}: ${error.message}`); }
    const account = agents.find((agent) => agent.id === params.profileId && agent.available);
    if (account?.engine !== session.engine) throw new Error(`Choose a signed-in ${ENGINES[session.engine]?.label ?? session.engine} account on ${target.name}.`);
    const prior = this.sendEngine.prior(cwd, target.id)?.job.target.path;
    const folder = params.targetFolder?.trim() || prior
      || (cwd.startsWith(`${HOME}/`) ? `~/${relative(HOME, cwd)}` : `~/${basename(cwd)}`);
    if (!line(folder, 1024) || !(folder.startsWith('/') || folder.startsWith('~/'))) throw new Error('The folder must start with / or ~/');
    if (folder !== prior && await this.#occupied(target, folder)) {
      throw new Error(`${folder} already exists on ${target.name}. Choose another folder.`);
    }
    const record = {
      moveId: params.moveId, sessionId: session.id, targetMachineId: target.id, targetName: target.name,
      profileId: params.profileId, includeEnv: params.includeEnv !== false, folder,
      engine: session.engine, engineSessionId: session.engineSessionId,
      newId: randomUUID(),
      sourceCwd: cwd, home, conversation, title: session.title || basename(cwd),
      phase: 'copying-project', createdAt: Date.now(),
    };
    this.#save(record);
    this.sessions.setMove(session.id, { moving: { moveId: record.moveId, machineName: target.name } });
    this.#run(record);
    return this.#view(record);
  }

  status(params, caller) {
    this.#authorize(caller);
    if (!ID.test(params?.moveId ?? '')) throw new Error('invalid move id');
    const record = this.#read(params.moveId);
    if (!record) throw new Error('Helm has no record of this move.');
    return this.#view(record);
  }

  async #occupied(target, folder) {
    try {
      const listing = await this.rpc(target.id, M.FS_LIST, { path: folder }, { timeout: 20_000 });
      return !Number.isInteger(listing?.entryCount) || listing.entryCount !== 0;
    } catch (error) {
      if (/ENOENT|no such file or directory|no such folder/i.test(error.message)) return false;
      throw new Error(`Cannot check ${folder} on ${target.name}: ${error.message}`);
    }
  }

  /**
   * Try a failed move again. The chat may have changed since, so copies
   * that finished go again (only the changes travel); a copy that stopped
   * part way resumes. A failure while opening only opens again.
   */
  #retry(record) {
    record.error = null;
    record.phase = record.resumeAt === 'opening' ? 'opening' : 'copying-project';
    if (record.phase === 'copying-project') {
      for (const field of ['projectJob', 'chatJob']) {
        try { if (this.sendEngine.status({ jobId: record[field] }, this.network().self).job.phase === 'done') record[field] = null; }
        catch { record[field] = null; }
      }
    }
    this.#save(record);
  }

  /** Continue moves a restart interrupted, and finish one that opened but did not mark its old chat. */
  start() {
    let files = [];
    try { files = readdirSync(this.directory); } catch { return; }
    for (const file of files) {
      if (!/^[a-f0-9]{24}\.json$/.test(file)) continue;
      const record = this.#read(file.slice(0, -5));
      if (!record || record.phase === 'failed') continue;
      let marked = false;
      try { marked = !!this.sessions.get(record.sessionId).movedAway; } catch { continue; }
      if (record.phase !== 'done' || !marked) this.#run(record);
    }
  }

  #run(record) {
    if (this.running.has(record.moveId)) return this.running.get(record.moveId);
    const end = beginTransferActivity();
    const work = this.#steps(record)
      .catch((error) => {
        record.resumeAt = record.phase;
        record.phase = 'failed';
        record.error = String(error.message).slice(0, 500);
        this.#save(record);
        // The chat stays usable here; a retry starts from the failed step.
        try { this.sessions.setMove(record.sessionId, { moving: null }); } catch {}
      })
      .finally(() => { end(); this.running.delete(record.moveId); });
    this.running.set(record.moveId, work);
    return work;
  }

  async #send(record, field, start) {
    let job = record[field] ? this.sendEngine.status({ jobId: record[field] }, this.network().self).job : null;
    if (job && ['failed', 'interrupted', 'cancelled'].includes(job.phase)) job = this.sendEngine.retry({ jobId: job.id }, this.network().self).job;
    if (!job) { job = this.sendEngine.start(start, this.network().self).job; record[field] = job.id; this.#save(record); }
    const timer = setInterval(() => {
      try {
        const now = this.sendEngine.status({ jobId: job.id }, this.network().self).job;
        record.progress = { bytes: now.bytes.sent, total: now.bytes.total };
      } catch { clearInterval(timer); }
    }, 500);
    timer.unref?.();
    try { job = await this.sendEngine.wait(job.id); } finally { clearInterval(timer); }
    if (job.phase !== 'done') throw new Error(job.error || `The copy stopped (${job.phase}).`);
    record.progress = null;
    return job;
  }

  async #steps(record) {
    const self = this.network().self;
    this.sessions.setMove(record.sessionId, { moving: { moveId: record.moveId, machineName: record.targetName } });
    if (record.phase === 'copying-project') {
      const job = await this.#send(record, 'projectJob', { path: record.sourceCwd, targetMachineId: record.targetMachineId,
        destination: record.folder, includeEnv: record.includeEnv, internal: true });
      record.targetFolder = job.target.path;
      record.phase = 'copying-chat';
      this.#save(record);
    }
    if (record.phase === 'copying-chat') {
      // Built again on each try: the chat may have said more since a failure.
      const pack = join(this.directory, `${record.moveId}.pack`);
      rmSync(pack, { recursive: true, force: true });
      const change = { oldId: record.engineSessionId, newId: record.newId, from: record.sourceCwd, to: expand(record.targetFolder) };
      const top = TOP[record.engine];
      if (record.engine === 'claude') {
        const dir = join(pack, top, claudeKey(change.to));
        await rewriteFile(record.conversation, join(dir, `${record.newId}.jsonl`), change);
        // Claude keeps a chat's helper transcripts and large tool results beside it.
        const extra = join(dirname(record.conversation), record.engineSessionId);
        if (existsSync(extra)) await rewriteTree(extra, join(dir, record.newId), change);
      } else {
        const rel = relative(join(record.home, top), record.conversation);
        const place = rel.startsWith('..') ? basename(record.conversation) : rel;
        await rewriteFile(record.conversation, join(pack, top, place.replaceAll(record.engineSessionId, record.newId)), change);
      }
      const { stage } = await this.rpc(record.targetMachineId, M.CHAT_ADOPT, { moveId: record.moveId, step: 'prepare' }, { timeout: 30_000 });
      record.stage = stage;
      await this.#send(record, 'chatJob', { path: pack, targetMachineId: record.targetMachineId, destination: stage, includeEnv: true, internal: true });
      rmSync(pack, { recursive: true, force: true });
      record.phase = 'opening';
      this.#save(record);
    }
    if (record.phase === 'opening') {
      const source = this.sessions.get(record.sessionId);
      const opened = await this.rpc(record.targetMachineId, M.CHAT_ADOPT, {
        moveId: record.moveId, step: 'open', engine: record.engine, id: record.newId,
        cwd: record.targetFolder, profileId: record.profileId, title: source.title || record.title,
        from: { sessionId: record.sessionId, machineName: this.network().machines?.[self]?.name ?? self },
      }, { timeout: 120_000 });
      record.result = { sessionId: opened.sessionId };
      record.phase = 'done';
      this.#save(record);
    }
    if (record.phase === 'done') {
      this.sessions.setMove(record.sessionId, { moving: null, movedAway: {
        machineId: record.targetMachineId, machineName: record.targetName, sessionId: record.result.sessionId, at: Date.now() } });
      const source = this.sessions.get(record.sessionId);
      if (!source.archived) this.sessions.archive(record.sessionId);
    }
  }

  /** Target side: give the source a staging place, then open what arrived there. */
  async adopt(params, caller) {
    const net = this.network();
    if (!caller || caller === net.self || !net.machines?.[caller] || net.revoked?.[caller]) {
      throw new Error('Only another machine in this network can move a chat here.');
    }
    if (!ID.test(params?.moveId ?? '')) throw new Error('invalid move id');
    const stage = join(HELM_DIR, 'incoming-chats', params.moveId);
    if (params.step === 'prepare') {
      mkdirSync(dirname(stage), { recursive: true, mode: 0o700 });
      return { stage };
    }
    if (params.step !== 'open') throw new Error('unknown move step');
    if (!MOVABLE.has(params.engine)) throw new Error('Only Claude and Codex chats can move.');
    if (!line(params.id, 128) || !/^[A-Za-z0-9-]+$/.test(params.id)) throw new Error('invalid conversation id');
    if (!line(params.cwd, 1024) || !line(params.profileId, 256)) throw new Error('invalid move request');
    const profile = (await this.profiles()).find((p) => p.id === params.profileId && p.engine === params.engine);
    if (!profile) throw new Error(`No ${params.engine} account "${params.profileId}" on this machine.`);
    const home = homeOf(profile);
    const top = TOP[params.engine];
    if (existsSync(stage)) {
      const root = join(stage, top);
      const place = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const from = join(dir, entry.name);
          const rel = relative(stage, from);
          const to = join(home, rel);
          if (rel.startsWith('..') || !to.startsWith(join(home, top) + sep) || entry.isSymbolicLink()) throw new Error('The moved chat holds a file outside its place.');
          if (entry.isDirectory()) { place(from); continue; }
          if (!entry.isFile()) continue;
          // A retry after a lost reply finds its own files already placed.
          if (existsSync(to) && lstatSync(to).size === statSync(from).size) continue;
          if (existsSync(to)) throw new Error('A conversation with this id already exists here.');
          mkdirSync(dirname(to), { recursive: true });
          renameSync(from, to);
        }
      };
      if (!existsSync(root)) throw new Error('The moved chat arrived empty.');
      place(root);
      rmSync(stage, { recursive: true, force: true });
    }
    const session = await this.sessions.resumeExternal({ engine: params.engine, account: profile.id,
      id: params.id, cwd: params.cwd, title: typeof params.title === 'string' ? params.title.slice(0, 120) : undefined });
    const from = params.from && line(params.from.machineName, 120) && line(params.from.sessionId, 80)
      ? { machineId: caller, machineName: params.from.machineName, sessionId: params.from.sessionId } : null;
    if (from) this.sessions.setMove(session.id, { movedFrom: from });
    return { sessionId: session.id };
  }
}
