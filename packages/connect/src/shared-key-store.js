import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { codeKeyInfo, openSharedKeyPacket, sealCodeSnapshot } from './code-transfer.js';
import { HELM_DIR } from './paths.js';

const VAULT_ID = 'shared-key-vault';
export const token = () => randomBytes(16).toString('hex');
export const validToken = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export const validChat = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(value);
export const keyName = name => {
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) {
    throw new Error('Use a key name that starts with a letter or underscore. Use only letters, numbers and underscores.');
  }
  return name;
};
export function keyNames(names) {
  if (!Array.isArray(names) || !names.length || names.length > 128) throw new Error('Choose between 1 and 128 key names.');
  return [...new Set(names.map(keyName))].sort();
}
export function keyValue(value) {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 8192 || /[\0\r\n]/.test(value)) {
    throw new Error('Enter a key value on one line. Use at most 8192 bytes.');
  }
  return value;
}
export const readOnlyChat = session => ['plan', 'readonly', 'read'].includes(session.mode);
export const endedChat = session => !session || session.deleted || session.archived || session.adopted
  || ['exited', 'interrupted', 'error'].includes(session.status)
  || ['done', 'interrupted', 'exited', 'error'].includes(session.delegation?.status);

// The first machine owns the vault. Presence, names and machine kinds can change.
export function keyHome(net) {
  return Object.values(net.machines ?? {}).sort((a, b) =>
    (a.addedAt ?? 0) - (b.addedAt ?? 0) || a.id.localeCompare(b.id))[0];
}

export function writePrivate(file, data) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + token() + '.tmp';
  try {
    writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
}

export function readPrivate(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return fallback; }
}

const grantMatches = (grant, machine, chat, name) => grant.machine === machine && grant.chat === chat && grant.name === name;

export class SharedKeyStore {
  constructor({ path = join(HELM_DIR, 'shared-keys', 'vault.json'), publicKey = () => codeKeyInfo().codePubkey,
    seal = sealCodeSnapshot, open = openSharedKeyPacket, now = Date.now } = {}) {
    Object.assign(this, { path, publicKey, seal, open, now });
  }

  #state() {
    const sealed = readPrivate(this.path, null);
    return sealed ? this.open(sealed, VAULT_ID) : { keys: {}, grants: [], permits: {} };
  }

  #save(state) {
    writePrivate(this.path, this.seal(state, this.publicKey(), VAULT_ID));
  }

  #key(state, name) {
    if (!Object.hasOwn(state.keys, name)) throw new Error(`Shared key ${name} is missing. Add it in Settings.`);
    return state.keys[name];
  }

  list() {
    const { keys, grants } = this.#state();
    return { keys: Object.entries(keys).map(([name, { used }]) => ({
      name, machines: Object.keys(used), lastUse: Math.max(0, ...Object.values(used)) || null,
    })).sort((a, b) => a.name.localeCompare(b.name)), grants };
  }

  set(name, value) {
    const state = this.#state();
    keyName(name); keyValue(value);
    // A replacement requires a new approval.
    Object.defineProperty(state.keys, name, { enumerable: true, configurable: true, writable: true,
      value: { value, version: token(), used: {} } });
    state.grants = state.grants.filter(grant => grant.name !== name);
    this.#save(state);
  }

  remove(name) {
    const state = this.#state();
    delete state.keys[keyName(name)];
    state.grants = state.grants.filter(grant => grant.name !== name);
    this.#save(state);
  }

  revoke(id) {
    if (!validToken(id)) throw new Error('Choose a shared key grant.');
    const state = this.#state();
    state.grants = state.grants.filter(grant => grant.id !== id);
    this.#save(state);
  }

  release(machine, chat) {
    const state = this.#state();
    const active = state.grants.filter(grant => grant.machine !== machine || grant.chat !== chat);
    if (active.length === state.grants.length) return;
    const removed = new Set(state.grants.filter(grant => !active.includes(grant)).map(grant => grant.id));
    state.grants = active;
    // A chat it already sent can start after the sending chat ends.
    for (const permit of Object.values(state.permits)) {
      if (permit.kind === 'chat' && !permit.claimed) permit.grants = permit.grants.filter(id => !removed.has(id));
    }
    this.#save(state);
  }

  // Check all names before showing an approval card.
  missing(machine, chat, names) {
    const state = this.#state();
    return {
      versions: Object.fromEntries(names.map(name => [name, this.#key(state, name).version])),
      missing: names.filter(name => !state.grants.some(grant => grantMatches(grant, machine, chat, name))),
    };
  }

  #grant(state, machine, chat, title, name) {
    const found = state.grants.find(grant => grantMatches(grant, machine, chat, name));
    if (found) return found;
    const grant = { id: token(), name, machine, chat, title };
    state.grants.push(grant);
    return grant;
  }

  issue(machine, { id, kind, target, names, chat, title, approved, versions }) {
    const state = this.#state();
    const previous = state.permits[id];
    if (previous) {
      if (previous.source !== machine || previous.target !== target || previous.kind !== kind
        || previous.chat !== chat || JSON.stringify(Object.keys(previous.keys).sort()) !== JSON.stringify(names)) {
        throw new Error('This key request number belongs to another job.');
      }
      return;
    }
    const keys = Object.fromEntries(names.map(name => [name, this.#key(state, name).version]));
    const grants = [];
    if (versions && names.some(name => keys[name] !== versions[name])) {
      throw new Error('A shared key changed. Ask to use it again.');
    }
    for (const name of chat ? names : []) {
      const grant = state.grants.find(grant => grantMatches(grant, machine, chat, name));
      if (grant) grants.push(grant.id);
      else if (!approved) throw new Error('Ask the owner to allow this key again.');
      else if (kind === 'command') grants.push(this.#grant(state, machine, chat, title, name).id);
    }
    // Keep one record per authorized job so retrying can never reissue it.
    state.permits[id] = { kind, source: machine, target, chat, keys, grants };
    this.#save(state);
  }

  claim(machine, id, { kind, source, chat, title, publicKey }) {
    const state = this.#state(), permit = state.permits[id];
    if (!permit || permit.target !== machine || permit.source !== source || permit.kind !== kind) throw new Error('This job has no shared key grant.');
    // A resumed transfer can repeat its attachment to the same chat. Never
    // put back a grant that the owner removed while the transfer was paused.
    if (chat && permit.claimed === chat) return;
    if (permit.claimed) throw new Error('This shared key request was already used.');
    const names = Object.keys(permit.keys);
    const keys = names.map(name => {
      const key = this.#key(state, name);
      if (key.version !== permit.keys[name]) throw new Error(`Shared key ${name} changed. Ask to use it again.`);
      return [name, key];
    });
    if (permit.grants.some(id => !state.grants.some(grant => grant.id === id))) {
      throw new Error('The owner ended access to a shared key. Ask to use it again.');
    }
    if (chat) {
      for (const name of names) this.#grant(state, machine, chat, title, name);
    } else {
      for (const [, key] of keys) key.used[machine] = this.now();
    }
    const sealed = chat ? undefined : this.seal(Object.fromEntries(keys.map(([name, key]) => [name, key.value])), publicKey, `shared-key-job-${id}`);
    permit.claimed = chat || true;
    permit.keys = Object.fromEntries(names.map(name => [name, true]));
    permit.grants = [];
    this.#save(state);
    return sealed;
  }
}
