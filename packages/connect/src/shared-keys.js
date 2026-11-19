import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { codeKeyInfo, openSharedKeyPacket } from './code-transfer.js';
import { HELM_DIR } from './paths.js';
import { SharedKeyStore, endedChat, keyHome, keyName, keyNames, readOnlyChat,
  readPrivate, validChat, validToken, writePrivate } from './shared-key-store.js';

const REQUEST = /^keys-([a-f0-9]{32})$/;
const SILENCE_MS = 90_000;
const deny = message => Object.assign(new Error(message), { deliveryNotSent: true });

const sameRequest = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export class SharedKeys {
  #waiting = new Map();
  #running = new Map();
  #closing = new Set();
  #granted = new Set();
  #timers = new Map();

  constructor({ sessions, network, rpc, store = new SharedKeyStore(), directory = join(HELM_DIR, 'shared-keys', 'requests'),
    now = Date.now, publicKey = () => codeKeyInfo().codePubkey, open = openSharedKeyPacket }) {
    Object.assign(this, { sessions, network, rpc, store, directory, now, publicKey, open });
  }

  owns(requestId) { return typeof requestId === 'string' && REQUEST.test(requestId); }

  async #home(action, params = {}) {
    const net = this.network(), home = keyHome(net);
    if (!home || net.revoked?.[home.id]) throw new Error('The machine that stores shared keys is no longer paired.');
    if (home.id === net.self) return this.#vault(action, params, net.self, net);
    try { return await this.rpc(home.id, 'keys.vault', { ...params, action }); }
    catch (error) {
      if (/unknown method/i.test(error.message)) throw new Error(`Update Helm on ${home.name} to use shared keys.`);
      if (['offline', 'unreachable', 'timeout'].includes(error.code) || (!error.rpc && /offline|not connected|connect|timed out|timeout/i.test(error.message))) {
        throw new Error(`Connect ${home.name} to use shared keys.`);
      }
      throw error;
    }
  }

  #machine(net, id) {
    if (!id || net.revoked?.[id] || !Object.hasOwn(net.machines ?? {}, id)) throw new Error('Choose a paired machine.');
    return net.machines[id];
  }

  #vault(action, p, caller, net) {
    this.#machine(net, caller);
    if (keyHome(net)?.id !== net.self) throw new Error('This machine does not store shared keys.');
    switch (action) {
      case 'pub': return { publicKey: this.publicKey() };
      case 'list': return this.store.list();
      case 'set': {
        const name = keyName(p.name);
        const { value } = this.open(p.sealed, `shared-key-save-${name}`);
        this.store.set(name, value);
        return { ok: true };
      }
      case 'remove': this.store.remove(p.name); return { ok: true };
      case 'revoke': this.store.revoke(p.id); return { ok: true };
      case 'release':
        if (!validChat(p.chat)) throw new Error('Choose a chat.');
        this.store.release(caller, p.chat);
        return { ok: true };
      case 'missing':
        if (!validChat(p.chat)) throw new Error('Choose a chat.');
        return this.store.missing(caller, p.chat, keyNames(p.names));
      case 'issue':
        this.#machine(net, p.target);
        if (!validToken(p.id) || !['command', 'chat'].includes(p.kind) || (p.chat !== null && !validChat(p.chat))) {
          throw new Error('Choose a job for this shared key.');
        }
        this.store.issue(caller, { ...p, names: keyNames(p.names) });
        return { ok: true };
      case 'claim': {
        this.#machine(net, p.source);
        if (!validToken(p.id) || !['command', 'chat'].includes(p.kind) || (p.kind === 'chat' && !validChat(p.chat))) {
          throw new Error('Choose a job for this shared key.');
        }
        const publicKey = p.kind === 'command'
          ? (caller === net.self ? this.publicKey() : this.#machine(net, caller).codePubkey) : null;
        if (p.kind === 'command' && !publicKey) throw new Error('Restart Helm on the machine that will run this command.');
        return { sealed: this.store.claim(caller, p.id, { kind: p.kind, source: p.source,
          chat: p.kind === 'chat' ? p.chat : null, title: typeof p.title === 'string' ? p.title.slice(0, 200) : '', publicKey }) };
      }
      default: throw new Error('Unknown shared key action.');
    }
  }

  #file(id) { return join(this.directory, id + '.json'); }
  #get(id) {
    if (!validToken(id)) throw new Error('Choose a shared key request.');
    return readPrivate(this.#file(id), null);
  }
  #put(id, record, wakeWaiters = true) {
    writePrivate(this.#file(id), record);
    clearTimeout(this.#timers.get(id));
    this.#timers.delete(id);
    if (record.state === 'asking') this.#expire(id, record);
    if (wakeWaiters) for (const wake of this.#waiting.get(id) ?? []) wake();
  }

  #expire(id, record) {
    const timer = setTimeout(() => {
      try { this.cancel(id); } catch { /* A write error must not stop the daemon. */ }
    }, Math.max(0, record.seen + SILENCE_MS - this.now()));
    timer.unref();
    this.#timers.set(id, timer);
  }

  async restore() {
    let files = [];
    try { files = readdirSync(this.directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const file of files) {
      const id = file.endsWith('.json') ? file.slice(0, -5) : '';
      if (!validToken(id)) continue;
      const record = this.#get(id);
      if (record?.state === 'asking') this.#expire(id, record);
    }
    const { grants } = await this.#home('list');
    return this.#active(grants.filter(grant => grant.machine === this.network().self).map(grant => grant.chat));
  }

  stop() {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    for (const list of this.#waiting.values()) for (const wake of list) wake();
  }

  #chat(id, callerThreadId) {
    if (!validChat(id)) throw new Error('Use shared keys from a chat on this machine.');
    let session;
    try { session = this.sessions.get(id); } catch { /* The chat is gone. */ }
    if (endedChat(session)) throw new Error('This chat has ended.');
    if (readOnlyChat(session)) throw new Error('A read-only chat cannot use shared keys.');
    if (callerThreadId && session.engine === 'codex' && session.engineSessionId !== callerThreadId) {
      throw new Error('Use shared keys from your own chat.');
    }
    return session;
  }

  #card(id, record) {
    const { request, missing } = record, net = this.network();
    this.sessions.showHelmAsk(request.chat, {
      requestId: `keys-${id}`, kind: 'tool', tool: 'keys', ownLabels: true,
      title: 'Use a shared key',
      detail: missing.join(', '),
      reason: request.kind === 'chat' ? `Give access to a chat on ${net.machines[request.target]?.name ?? request.target}.`
        : `Run a command on ${net.machines[request.target]?.name ?? request.target} with this key.`,
      options: [
        { id: 'allow', role: 'allow', label: request.kind === 'chat' ? 'Allow for the new chat' : 'Allow for this chat' },
        { id: 'deny', role: 'deny', label: 'Deny' },
      ],
    });
  }

  async #issue(id, record, approved) {
    const { request } = record;
    const session = request.chat && this.#chat(request.chat, request.callerThreadId);
    await this.#home('issue', { id, ...request, title: session?.title, versions: record.versions, approved });
    if (session && request.kind === 'command') this.#track(session);
    this.#put(id, { ...record, state: 'allowed' });
    return { state: 'allowed' };
  }

  async #ask(id, request) {
    const net = this.network();
    this.#machine(net, request.target);
    const previous = this.#get(id);
    if (previous && !sameRequest(previous.request, request)) throw new Error('This key request number belongs to another job.');
    if (previous) {
      if (previous.state === 'asking') {
        this.#chat(request.chat, request.callerThreadId);
        this.#put(id, { ...previous, seen: this.now() });
        this.#card(id, previous);
      }
      return { state: previous.state };
    }
    if (request.target !== net.self) {
      try { await this.rpc(request.target, 'keys.support', {}); }
      catch (error) {
        if (/unknown method/i.test(error.message)) throw new Error(`Update Helm on ${net.machines[request.target].name} to use shared keys.`);
        throw error;
      }
    }
    if (!request.chat) return this.#issue(id, { request }, false);
    const session = this.#chat(request.chat, request.callerThreadId);
    const { missing, versions } = await this.#home('missing', { chat: request.chat, names: request.names });
    if (!missing.length) return this.#issue(id, { request, versions }, false);
    const record = { request, missing, versions, state: 'asking', seen: this.now(), back: session.status };
    this.#put(id, record);
    this.#card(id, record);
    return { state: 'asking' };
  }

  async request(p) {
    if (!validToken(p.id) || !['command', 'chat'].includes(p.kind)) throw new Error('Choose a job for this shared key.');
    const request = { kind: p.kind, target: p.target, names: keyNames(p.names), chat: p.chat ?? null,
      callerThreadId: p.callerThreadId ?? null };
    if (request.chat !== null && !validChat(request.chat)) throw new Error('Choose a chat.');
    if (this.#running.has(p.id)) {
      const held = this.#running.get(p.id);
      if (!sameRequest(held.request, request)) throw new Error('This key request number belongs to another job.');
      return held.work;
    }
    const work = this.#ask(p.id, request).finally(() => this.#running.delete(p.id));
    this.#running.set(p.id, { request, work });
    return work;
  }

  async wait(id) {
    let record = this.#get(id);
    if (record?.state !== 'asking') return { state: record?.state ?? 'missing' };
    this.#chat(record.request.chat, record.request.callerThreadId);
    this.#card(id, record);
    const waiters = this.#waiting.get(id) ?? new Set();
    this.#put(id, { ...record, seen: this.now() }, false);
    this.#waiting.set(id, waiters);
    await new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        if (!waiters.size) this.#waiting.delete(id);
        resolve();
      };
      const timer = setTimeout(done, 10_000);
      waiters.add(done);
    });
    record = this.#get(id);
    return { state: record?.state ?? 'missing' };
  }

  #close(id, record, state) {
    this.#put(id, { ...record, state });
    this.sessions.closeHelmAsk(record.request.chat, `keys-${id}`, state === 'allowed' ? 'allow' : state === 'denied' ? 'deny' : 'cancelled',
      record.back === 'blocked' ? 'working' : record.back);
  }

  cancel(id) {
    const record = this.#get(id);
    if (record?.state === 'asking') this.#close(id, record, 'cancelled');
    return { ok: true };
  }

  async answer(chat, requestId, decision) {
    const id = REQUEST.exec(requestId)?.[1], record = id && this.#get(id);
    if (!record || record.request.chat !== chat || record.state !== 'asking') {
      this.sessions.closeHelmAsk(chat, requestId, 'cancelled');
      throw deny('This key request is no longer open.');
    }
    if (decision.option === 'deny') { this.#close(id, record, 'denied'); return { ok: true }; }
    if (decision.option !== 'allow') throw deny('Choose Allow for this chat or Deny.');
    if (this.now() - record.seen > SILENCE_MS) {
      this.#close(id, record, 'cancelled');
      throw deny('The chat stopped waiting. Ask the chat to try again.');
    }
    try { await this.#issue(id, record, true); }
    catch (error) { throw deny(error.message); }
    this.#close(id, record, 'allowed');
    return { ok: true };
  }

  async claimCommand(id, source) {
    const { sealed } = await this.#home('claim', { id, source, kind: 'command' });
    return this.open(sealed, `shared-key-job-${id}`);
  }

  async attach(id, source, session) {
    if (endedChat(session)) throw new Error('This chat has ended.');
    await this.#home('claim', { id, source, kind: 'chat', chat: session.id, title: session.title });
    this.#track(session);
  }

  #track(session) {
    this.#granted.add(session.id);
    this.onSession(session);
  }

  onSession(session) {
    const id = session?.id;
    if (!this.#granted.has(id) || !endedChat(session) || this.#closing.has(id)) return;
    this.#closing.add(id);
    Promise.resolve(this.#home('release', { chat: id })).then(() => this.#granted.delete(id), () => {})
      .finally(() => this.#closing.delete(id));
  }

  async #active(chats) {
    if (!Array.isArray(chats) || chats.some(id => !validChat(id))) throw new Error('Choose chats.');
    const ended = [];
    for (const id of new Set(chats)) {
      let session;
      try { session = this.sessions.get(id); } catch { /* The chat was removed. */ }
      if (endedChat(session)) ended.push(id);
      else this.#track(session);
    }
    await Promise.all(ended.map(chat => this.#home('release', { chat })));
    return ended;
  }

  async #list() {
    const net = this.network(), result = await this.#home('list');
    const machines = new Map();
    for (const grant of result.grants) {
      if (!machines.has(grant.machine)) machines.set(grant.machine, []);
      machines.get(grant.machine).push(grant.chat);
    }
    const ended = new Map(await Promise.all([...machines].map(async ([machine, chats]) => {
      try {
        const ids = machine === net.self ? await this.#active(chats) : await this.rpc(machine, 'keys.active', { chats }, 3_000);
        return [machine, new Set(ids)];
      } catch { return [machine, new Set()]; } // Keep grants visible while their machine is offline.
    })));
    const nameOf = id => net.machines[id]?.name ?? id;
    return { keys: result.keys.map(key => ({ ...key, machines: key.machines.map(nameOf).sort() })),
      grants: result.grants.filter(grant => !net.revoked?.[grant.machine] && !ended.get(grant.machine)?.has(grant.chat))
        .map(grant => ({ ...grant, machine: nameOf(grant.machine) })) };
  }

  async dispatch(method, p, caller) {
    const net = this.network();
    const local = caller === net.self && !net.revoked?.[caller];
    const owner = !!caller && !!net.devices?.[caller] && !net.revoked?.[caller];
    if (method === 'keys.vault') return this.#vault(p.action, p, caller, net);
    if (method === 'keys.active' || method === 'keys.support') {
      this.#machine(net, caller);
      return method === 'keys.support' ? { ok: true } : this.#active(p.chats);
    }
    if (method === 'keys.request' || method === 'keys.wait' || method === 'keys.cancel') {
      if (!local) throw new Error('Ask for shared keys from your own machine.');
      if (method === 'keys.request') return this.request(p);
      return method === 'keys.wait' ? this.wait(p.id) : this.cancel(p.id);
    }
    if (!local && !owner) throw new Error('Manage shared keys from your machine or the Helm app.');
    if (method === 'keys.public') return this.#home('pub');
    if (method === 'keys.list') return this.#list();
    if (method === 'keys.remove') return this.#home('remove', { name: keyName(p.name) });
    if (method === 'keys.revoke') return this.#home('revoke', { id: p.id });
    if (method === 'keys.set') {
      const name = keyName(p.name);
      return this.#home('set', { name, sealed: p.sealed });
    }
    throw new Error('Unknown shared key command.');
  }
}
