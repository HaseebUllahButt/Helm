/**
 * The network this machine belongs to.
 *
 * A "network" is a set of machines that trust each other plus the devices
 * allowed to drive them. It has no head. Every machine keeps a full copy of
 * the roster and they reconcile whenever two of them talk, so any machine can
 * answer a phone on its own - including a laptop whose only other peer is
 * switched off.
 *
 * The roster is deliberately tiny (a handful of records, each a few hundred
 * bytes) which is what lets the merge rule be as simple as it is: every
 * record carries `updatedAt` and the newer one wins. Real conflicts need two
 * machines to edit the same record while partitioned from each other, and the
 * only editable fields are a machine's own self-description and an explicit
 * revocation - neither of which two people race on.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, homedir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  newNetworkKey, newNetworkId, newDeviceId, mintToken, verifyToken, ROLE,
} from './identity.js';

// Duplicated from @helm/connect's paths rather than imported: the relay reads
// this file too, and it must not have to depend on the package that depends
// on it.
export const HELM_DIR = process.env.HELM_DIR || join(homedir(), '.helm');
export const NETWORK_FILE = join(HELM_DIR, 'network.json');

const write = (net) => {
  mkdirSync(HELM_DIR, { recursive: true, mode: 0o700 });
  // 0600: the file contains the network key, which is the whole ballgame.
  writeFileSync(NETWORK_FILE, JSON.stringify(net, null, 2), { mode: 0o600 });
  return net;
};

export function loadNetwork() {
  if (!existsSync(NETWORK_FILE)) return null;
  try { return JSON.parse(readFileSync(NETWORK_FILE, 'utf8')); } catch { return null; }
}

export const saveNetwork = write;

export function requireNetwork() {
  const net = loadNetwork();
  if (!net) throw new Error('this machine is not in a network yet - run `helm up`');
  return net;
}

/** Start a brand new network with this machine as its first member. */
export function createNetwork({ name = hostname(), port = 8787 } = {}) {
  const id = newDeviceId();
  return write({
    id: newNetworkId(),
    key: newNetworkKey(),
    self: id,
    port,
    machines: {
      [id]: { id, name, endpoints: [], updatedAt: Date.now(), addedAt: Date.now() },
    },
    devices: {},
    revoked: {},
  });
}

/** Join a network we have been handed the key to. */
export function joinNetwork({ id, key, name = hostname(), port = 8787, machines = {}, devices = {}, revoked = {} }) {
  const self = newDeviceId();
  return write({
    id, key, self, port,
    machines: {
      ...machines,
      [self]: { id: self, name, endpoints: [], updatedAt: Date.now(), addedAt: Date.now() },
    },
    devices, revoked,
  });
}

export function forgetNetwork() {
  rmSync(NETWORK_FILE, { force: true });
}

// ------------------------------------------------------------------ tokens

/** A credential for this machine, proving membership to any peer. */
export const machineToken = (net) =>
  mintToken(net.key, { net: net.id, sub: net.self, role: ROLE.MACHINE });

/** A credential for a phone or browser. Durable: only revocation ends it. */
export function issueDevice(net, label = 'device') {
  const id = newDeviceId();
  net.devices[id] = { id, label, addedAt: Date.now(), updatedAt: Date.now() };
  write(net);
  return { id, token: mintToken(net.key, { net: net.id, sub: id, role: ROLE.DEVICE }) };
}

/**
 * Is this token allowed in right now?
 *
 * Signature first (cheap, and settles whether the bearer knows the key at
 * all), then the revocation list, which is the only piece of shared state
 * authentication depends on.
 */
export function authenticate(net, token) {
  const claims = verifyToken(net.key, token);
  if (!claims) return null;
  if (claims.net !== net.id) return null;
  if (net.revoked[claims.sub]) return null;
  return claims;
}

/** Remove a device or machine from the network, everywhere, permanently. */
export function revoke(net, subject) {
  net.revoked[subject] = Date.now();
  delete net.devices[subject];
  delete net.machines[subject];
  return write(net);
}

// ------------------------------------------------------------------ roster

const newer = (a, b) => ((a?.updatedAt ?? 0) >= (b?.updatedAt ?? 0) ? a : b);

/**
 * A cheap fingerprint of the roster.
 *
 * Membership almost never changes, so shipping the whole roster on every
 * exchange means both sides spend the entire month repeating themselves - at
 * 15-second intervals that is hundreds of megabytes a year per link, which
 * matters on a metered tunnel. Sides compare fingerprints and only send the
 * real thing when they differ.
 *
 * Key order is normalised because two machines holding identical state must
 * produce identical hashes, and object key order is insertion order.
 */
export function rosterHash(net) {
  const stable = (o) =>
    Object.keys(o).sort().reduce((acc, k) => {
      const v = o[k];
      acc[k] = v && typeof v === 'object' && !Array.isArray(v) ? stable(v) : v;
      return acc;
    }, {});
  const r = roster(net);
  return createHash('sha256')
    .update(JSON.stringify(stable({ m: r.machines, d: r.devices, v: r.revoked })))
    .digest('base64url')
    .slice(0, 16);
}

/** The shareable part of our state - never the key. */
export const roster = (net) => ({
  id: net.id,
  machines: net.machines,
  devices: net.devices,
  revoked: net.revoked,
});

/**
 * Fold a peer's roster into ours.
 *
 * Returns whether anything actually changed, so callers can skip writing to
 * disk and re-gossiping on the overwhelmingly common no-op exchange.
 */
export function mergeRoster(net, incoming) {
  if (!incoming || incoming.id !== net.id) return false;
  let changed = false;

  for (const [id, their] of Object.entries(incoming.machines ?? {})) {
    if (net.revoked[id]) continue;
    // A machine is the only writer of its own record. Without this, someone
    // else's view of us - a hub that had never heard of us writing an empty
    // placeholder, stamped with its own clock - wins on last-writer-wins and
    // we overwrite our own address list with nothing. We then advertise no
    // way to reach us, and nothing can dial us until a restart.
    if (id === net.self) continue;
    const won = newer(net.machines[id], their);
    if (won !== net.machines[id]) { net.machines[id] = won; changed = true; }
  }
  for (const [id, their] of Object.entries(incoming.devices ?? {})) {
    if (net.revoked[id]) continue;
    const won = newer(net.devices[id], their);
    if (won !== net.devices[id]) { net.devices[id] = won; changed = true; }
  }
  // Revocation is one-way and always wins: a machine that has been offline
  // must not be able to reinstate a device you removed while it was away.
  for (const [id, at] of Object.entries(incoming.revoked ?? {})) {
    if (net.revoked[id]) continue;
    net.revoked[id] = at;
    delete net.devices[id];
    delete net.machines[id];
    changed = true;
  }

  if (changed) write(net);
  return changed;
}

/**
 * Describe ourselves to the rest of the network.
 *
 * Everything another machine needs to know about us - where to reach us, and
 * the SSH identity for the key mesh - is written here and only here, so that
 * our record has exactly one author. `updatedAt` moves only when something
 * actually changed, which keeps a periodic call from churning the roster.
 */
export function describeSelf(net, fields) {
  const me = net.machines[net.self];
  if (!me) return net;

  const sameList = (a = [], b = []) =>
    a.length === b.length && b.every((x) => a.includes(x));

  let changed = false;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const differs = Array.isArray(v) ? !sameList(me[k], v) : me[k] !== v;
    if (differs) { me[k] = v; changed = true; }
  }
  if (!changed) return net;

  me.updatedAt = Date.now();
  return write(net);
}

/** Record where we can be reached, for other members to try later. */
export const advertise = (net, endpoints) => describeSelf(net, { endpoints });

/** Every address any member has told us about, ours last. */
export function allEndpoints(net) {
  const out = [];
  for (const m of Object.values(net.machines)) {
    if (m.id === net.self) continue;
    for (const e of m.endpoints ?? []) if (!out.includes(e)) out.push(e);
  }
  for (const e of net.machines[net.self]?.endpoints ?? []) {
    if (!out.includes(e)) out.push(e);
  }
  return out;
}
