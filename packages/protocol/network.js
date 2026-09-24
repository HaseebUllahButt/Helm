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
import { createHash, randomBytes } from 'node:crypto';
import {
  newNetworkKey, newNetworkId, newDeviceId, mintToken, verifyToken, ROLE, proofOf, checkProof,
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

const LOCAL_KEY_FILE = join(HELM_DIR, 'local.key');

/**
 * The secret that lets a browser *on this machine* sign itself in.
 *
 * Being on the loopback interface is not enough on its own: the VM's Caddy
 * terminates HTTPS and proxies to the hub over loopback, so every request
 * from the internet arrives looking local. This file is the thing an outsider
 * cannot get - it is readable only by the user whose agents these are, and
 * anyone who can read it can already read the network key sitting beside it.
 */
export function localKey() {
  if (existsSync(LOCAL_KEY_FILE)) {
    const v = readFileSync(LOCAL_KEY_FILE, 'utf8').trim();
    if (v) return v;
  }
  mkdirSync(HELM_DIR, { recursive: true, mode: 0o700 });
  const v = newNetworkKey();
  writeFileSync(LOCAL_KEY_FILE, v, { mode: 0o600 });
  return v;
}

export const saveNetwork = write;

export function requireNetwork() {
  const net = loadNetwork();
  if (!net) throw new Error('this machine is not in a network yet - run `helm up`');
  return net;
}

/**
 * A name that will survive the trip through the roster unchanged.
 *
 * Gossip converges by both sides agreeing on a fingerprint, so a record whose
 * author keeps re-sending something the receiver's checks reject is a pair of
 * machines that disagree forever, re-exchanging rosters every tick. The fix is
 * to hold what we author to the same bar we hold everyone else to, here, at
 * the one point a name enters the roster.
 */
const cleanName = (value, fallback = 'machine') => {
  const once = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TEXT);
  return once || fallback;
};

/**
 * A name somebody typed, held to what a machine name has to be.
 *
 * Stricter than what the roster will accept, and deliberately so. A machine's
 * name is also its ssh Host alias: `ssh laptop` works because `ssh.js` writes
 * the name into `~/.ssh/config` and the hub resolves it back to a machine by
 * name when the tunnel opens. `aliasOf` there strips a name down to this same
 * character set, so a name outside it is one the app would show and ssh could
 * not reach. Typed names are refused rather than quietly rewritten, because
 * the person typing is right there to be told.
 *
 * Nothing rewrites an existing record to this: a machine that joined under a
 * hostname with an apostrophe in it keeps the name it has.
 */
export const NAME_RULE =
  'a letter or number first, then letters, numbers, dots, dashes or underscores';

export const machineName = (value) => {
  const clean = String(value ?? '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(clean) ? clean : null;
};

/**
 * What a machine is for. The set is closed because the word travels in the
 * roster: every machine has to mean the same thing by it, and there is no
 * version negotiation on a gossiped record.
 *
 * A 'pc' runs agents and dials out to the rest. A 'vm' does that and is also
 * a home - it holds an https address the others can be dialled at. A 'nas'
 * is storage for the network: the same hub and daemon as a pc, flagged so
 * the rest of the network knows it is a machine that stays reachable.
 *
 * A controller is deliberately not here. It is not a fourth kind of machine:
 * it holds a device token rather than the network key, runs no daemon and
 * cannot become a machine, so no value of `kind` ever names it.
 */
export const MACHINE_KINDS = ['pc', 'vm', 'nas'];
export const machineKind = (v) => (MACHINE_KINDS.includes(v) ? v : null);

/**
 * Start a brand new network with this machine as its first member.
 *
 * The founder is the network's home - it is the machine everything else is
 * added from - so it starts life designated 'vm', both on the roster record
 * every peer will see and in `role`, the local note of the same fact that a
 * joined machine gets from its invite.
 */
export function createNetwork({ name = hostname(), port = 8787 } = {}) {
  const id = newDeviceId();
  return write({
    id: newNetworkId(),
    key: newNetworkKey(),
    self: id,
    role: 'vm',
    port,
    machines: {
      [id]: {
        id, name: cleanName(name, hostname()), kind: 'vm', endpoints: [],
        updatedAt: Date.now(), addedAt: Date.now(),
      },
    },
    devices: {},
    revoked: {},
  });
}

/** Join a network we have been handed the key to. */
export function joinNetwork({ id, key, name = hostname(), port = 8787, machines = {}, devices = {}, revoked = {} }) {
  const self = newDeviceId();
  // What the inviter handed us is a roster from the network, which is exactly
  // the thing `mergeRoster` refuses to take on trust; hold it to the same bar.
  const given = sanitizeRoster({ id, machines, devices, revoked });
  return write({
    id, key, self, port,
    machines: {
      ...given.machines,
      [self]: {
        id: self, name: cleanName(name, hostname()), endpoints: [],
        updatedAt: Date.now(), addedAt: Date.now(),
      },
    },
    devices: given.devices,
    revoked: given.revoked,
  });
}

export function forgetNetwork() {
  rmSync(NETWORK_FILE, { force: true });
}

// ------------------------------------------------------------------ tokens

/**
 * A credential for this machine, proving membership to any peer. Durable,
 * so it is what the CLI's own tooling may hold - but it never goes over the
 * wire from a daemon any more: see `hubCredential`.
 */
export const machineToken = (net) =>
  mintToken(net.key, { net: net.id, sub: net.self, role: ROLE.MACHINE });

// ------------------------------------------------------------ hub handshake
//
// A machine dials every address in the roster, and most of those are plain
// http on some LAN. It used to open with its durable machine token, to
// whatever answered: anyone holding that IP on a café's wifi - or just
// listening on it - got a credential that never expires, and every frame it
// sent back (an RPC, an SSH key for authorized_keys) was obeyed. So now the
// hub goes first: it proves it holds the network key by MACing our nonce,
// and we answer its challenge with a token that is good for one use, for a
// minute. A hub that cannot prove itself is never sent anything; a sniffer
// on the wire sees a credential that is already spent.

export const HELLO_PATH = '/api/hub/hello';
const HUB_PROOF = 'hub-proof';
const CREDENTIAL_TTL_MS = 60_000;

/** The hub's answer to a dialler's nonce. */
export const hubProof = (net, nonce) => proofOf(net.key, HUB_PROOF, `${net.id}:${nonce}`);

export const checkHubProof = (net, nonce, mac) =>
  checkProof(net.key, HUB_PROOF, `${net.id}:${nonce}`, mac);

/** A machine token spendable once, against the challenge the hub issued. */
export const oneTimeToken = (net, challenge) => mintToken(net.key, {
  net: net.id, sub: net.self, role: ROLE.MACHINE, ch: challenge, exp: Date.now() + CREDENTIAL_TTL_MS,
});

/**
 * Handshake with the hub at `base` (http/https) and return a credential for
 * one request or socket. Throws, without having sent anything secret, if the
 * hub cannot prove it is part of this network - an older hub included: it
 * has no hello route, and falling back to the durable token for it would be
 * the very downgrade an impostor would ask for.
 */
export async function hubCredential(net, base, { timeout = 5000 } = {}) {
  const nonce = randomBytes(24).toString('base64url');
  const res = await fetch(`${base.replace(/\/+$/, '')}${HELLO_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce }),
    signal: AbortSignal.timeout(timeout),
  });
  if (res.status === 404) {
    const err = new Error('that hub runs an older helm without the handshake - upgrade it');
    err.untrusted = true;
    throw err;
  }
  if (!res.ok) throw new Error(`hub hello answered ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!body || body.net !== net.id || typeof body.challenge !== 'string'
      || !checkHubProof(net, nonce, body.proof)) {
    const err = new Error('that address answered, but not as a hub of this network - nothing was sent to it');
    err.untrusted = true;
    throw err;
  }
  return oneTimeToken(net, body.challenge);
}

/**
 * A credential for a phone or browser. Durable: only revocation ends it.
 *
 * The label is whatever the browser called itself in the login body, so it is
 * cleaned on the way in for the same reason a machine name is: it goes into
 * the roster, and a record this machine authors must be one every other
 * machine will accept back unchanged.
 */
export function issueDevice(net, label = 'device') {
  const id = newDeviceId();
  net.devices[id] = {
    id, label: cleanName(label, 'device').slice(0, 60),
    addedAt: Date.now(), updatedAt: Date.now(),
  };
  write(net);
  return { id, token: mintToken(net.key, { net: net.id, sub: id, role: ROLE.DEVICE }) };
}

/**
 * Another token for a device that is already a member.
 *
 * Not the same thing as adding one: the credential is derived from the network
 * key and the id, so re-issuing is how a caller that can already prove it is
 * this machine gets a working token back without leaving a second permanent
 * member behind. Returns null if that id is no longer anyone, so a caller
 * cannot revive something the owner removed.
 */
export function deviceToken(net, id) {
  if (!net.devices[id] || net.revoked[id]) return null;
  return mintToken(net.key, { net: net.id, sub: id, role: ROLE.DEVICE });
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
  if (claims.exp !== undefined && !(claims.exp > Date.now())) return null;
  // A handshake credential is good once, and only here: the challenge it
  // answers must be one this process issued and nobody has spent.
  if (claims.ch !== undefined && !spendChallenge(claims.ch)) return null;
  return claims;
}

/** Challenges this hub has handed out: value -> expiry. */
const challenges = new Map();
const MAX_CHALLENGES = 4096;

/** A fresh challenge for a dialler to answer, good for a minute. */
export function issueChallenge() {
  const now = Date.now();
  if (challenges.size >= MAX_CHALLENGES) {
    for (const [c, exp] of challenges) if (exp <= now) challenges.delete(c);
    // Still full: someone is asking faster than anyone honest would. Drop
    // the oldest rather than grow - a real dialler retries.
    while (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value);
  }
  const c = randomBytes(18).toString('base64url');
  challenges.set(c, now + 60_000);
  return c;
}

function spendChallenge(c) {
  const exp = challenges.get(c);
  challenges.delete(c);
  return exp !== undefined && exp > Date.now();
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

// ------------------------------------------------------- what a peer may say
//
// Everything below exists because a roster arrives over the wire from
// something that has proved membership and nothing more. What it contains is
// not inert: a machine record carries the SSH public key every other machine
// writes into its own authorized_keys, and the addresses every device and
// daemon will next send a bearer token to. An unchecked merge therefore hands
// whoever holds the weakest credential in the network a shell on all of them.
//
// So a record is accepted field by field, and anything unrecognised, oversized
// or shaped wrong is dropped rather than repaired - a roster is a handful of
// small records, and there is no legitimate sender of a malformed one.

/** Deliberately generous; a real network is single digits of each. */
const MAX_RECORDS = 256;
const MAX_ENDPOINTS = 16;
const MAX_TEXT = 200;
const MAX_URL = 255;

/**
 * How far ahead of us a peer's clock may be and still be believed.
 *
 * Records merge last-writer-wins, so a record stamped far in the future can
 * never be corrected by the machine it purports to describe. A day is well
 * past any real skew between machines that both hold working TLS.
 */
export const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

const ids = /^[a-f0-9]{1,64}$/;
const sshUsers = /^[a-z_][a-z0-9_-]{0,31}$/i;

/** The key types OpenSSH actually accepts, and nothing that looks like one. */
const PUBKEY =
  /^(ssh-ed25519|ssh-rsa|ssh-dss|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) ([A-Za-z0-9+/]+={0,3})(?: .*)?$/;

/**
 * One line of printable text, or null.
 *
 * Control characters are the whole point of the check: a newline in a machine
 * name is how a second line arrives in a file that is written one record per
 * line, which is what `~/.ssh/config` and `authorized_keys` both are.
 */
const text = (v, max = MAX_TEXT) =>
  typeof v === 'string' && v.length > 0 && v.length <= max
    && !/[\u0000-\u001f\u007f]/.test(v)
    ? v
    : null;

/**
 * An endpoint is an origin something will be dialled at, so it is held to
 * being exactly that: http(s), no credentials, no path to smuggle anything in.
 */
const endpointOf = (v) => {
  const raw = text(v, MAX_URL);
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.hash || url.search) return null;
  return raw;
};

/**
 * The key, checked but kept whole.
 *
 * Deliberately *not* reduced to `type blob` here, even though that is what
 * eventually gets written to a file. Gossip converges by two machines hashing
 * identical records, so anything normalised on the way in is something the
 * authoring machine keeps re-sending and this side keeps rewriting: the two
 * never agree, and they trade full rosters every tick forever - which is the
 * bandwidth the fingerprint exists to save. Storing what the author wrote,
 * once it is proved to be a single line holding one real key, is what keeps
 * the two fingerprints equal. `ssh.js` drops the comment at the point the
 * line is actually written, which is the layer where it can do harm.
 */
const pubkeyOf = (v) => {
  const raw = text(v, 1024);
  return raw && PUBKEY.test(raw.trim()) ? raw.trim() : null;
};

const stampOf = (v, ceiling) =>
  Number.isFinite(v) && v >= 0 && v <= ceiling ? v : null;

/** Copy `value` onto `out[key]` when it survived its check. */
const keep = (out, key, value) => { if (value !== null && value !== undefined) out[key] = value; };

function machineRecord(id, their, ceiling) {
  if (!ids.test(id) || !their || typeof their !== 'object') return null;
  // A record with no usable stamp cannot take part in last-writer-wins at all.
  const updatedAt = stampOf(their.updatedAt, ceiling);
  if (updatedAt === null) return null;

  const out = { id, updatedAt };
  keep(out, 'name', text(their.name) ?? id.slice(0, 8));
  // Optional: records written before kinds existed carry none, and stay
  // valid - but a value that is not a real kind is dropped like any other
  // field the sender cannot vouch for.
  keep(out, 'kind', machineKind(their.kind));
  keep(out, 'addedAt', stampOf(their.addedAt, ceiling));
  keep(out, 'pubkey', pubkeyOf(their.pubkey));
  keep(out, 'sshUser', text(their.sshUser, 32) && sshUsers.test(their.sshUser) ? their.sshUser : null);
  keep(out, 'sshPort', Number.isInteger(their.sshPort) && their.sshPort > 0 && their.sshPort < 65536
    ? their.sshPort : null);

  const endpoints = [];
  for (const e of Array.isArray(their.endpoints) ? their.endpoints : []) {
    const ok = endpointOf(e);
    if (ok && !endpoints.includes(ok) && endpoints.length < MAX_ENDPOINTS) endpoints.push(ok);
  }
  out.endpoints = endpoints;
  return out;
}

function deviceRecord(id, their, ceiling) {
  if (!ids.test(id) || !their || typeof their !== 'object') return null;
  const updatedAt = stampOf(their.updatedAt, ceiling);
  if (updatedAt === null) return null;
  const out = { id, updatedAt };
  keep(out, 'label', text(their.label, 60) ?? 'device');
  keep(out, 'addedAt', stampOf(their.addedAt, ceiling));
  return out;
}

/**
 * Everything in an incoming roster that is worth believing.
 *
 * Exported so the shape this accepts can be tested directly, and so a caller
 * that wants to know what it would keep can ask without merging.
 */
export function sanitizeRoster(incoming, { now = Date.now() } = {}) {
  const ceiling = now + MAX_CLOCK_SKEW_MS;
  const out = { id: incoming?.id, machines: {}, devices: {}, revoked: {} };
  if (!incoming || typeof incoming !== 'object') return out;

  const take = (source, build, into) => {
    let n = 0;
    for (const [id, their] of Object.entries(source ?? {})) {
      if (n >= MAX_RECORDS) break;
      const record = build(id, their, ceiling);
      if (!record) continue;
      into[id] = record;
      n += 1;
    }
  };
  take(incoming.machines, machineRecord, out.machines);
  take(incoming.devices, deviceRecord, out.devices);

  let n = 0;
  for (const [id, at] of Object.entries(incoming.revoked ?? {})) {
    if (n >= MAX_RECORDS) break;
    if (!ids.test(id)) continue;
    out.revoked[id] = stampOf(at, ceiling) ?? now;
    n += 1;
  }
  return out;
}

/**
 * Fold a peer's roster into ours.
 *
 * Returns whether anything actually changed, so callers can skip writing to
 * disk and re-gossiping on the overwhelmingly common no-op exchange.
 *
 * What arrives is passed through `sanitizeRoster` first, so the rest of this
 * function - and everything downstream of it, the SSH mesh especially - is
 * working with fields that have already been proved to be what they claim.
 */
export function mergeRoster(net, unchecked) {
  if (!unchecked || unchecked.id !== net.id) return false;
  const incoming = sanitizeRoster(unchecked);
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

// ------------------------------------------------------------------ publish

