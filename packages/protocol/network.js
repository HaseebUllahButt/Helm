import { proofBody, setProofSigner, signNetworkProof, checkNetworkProof } from './proof.js';
export { signNetworkProof, checkNetworkProof } from './proof.js';
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
import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, watch, realpathSync, renameSync, statSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { hostname, homedir } from 'node:os';
import { createHash, randomBytes, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  newNetworkKey, newNetworkId, newDeviceId, mintToken, verifyToken, ROLE, proofOf, checkProof,
} from './identity.js';

// Duplicated from @helm/connect's paths rather than imported: the relay reads
// this file too, and it must not have to depend on the package that depends
// on it.
export const HELM_DIR = process.env.HELM_DIR || join(homedir(), '.helm');
export const NETWORK_FILE = join(HELM_DIR, 'network.json');

// Compare the actual directories too: a symlink to ~/.helm is still production.
const canonicalDirectory = (directory) => {
  const path = resolve(directory);
  try { return realpathSync(path); } catch {
    try { return join(realpathSync(dirname(path)), basename(path)); } catch { return path; }
  }
};
const productionDirectory = () => canonicalDirectory(join(homedir(), '.helm'));
const isProductionDirectory = () => canonicalDirectory(HELM_DIR) === productionDirectory();

export const assertWritableDirectory = () => {
  if (!isProductionDirectory()) return;
  if (process.env.NODE_TEST_CONTEXT) {
    throw new Error('Tests cannot write the production Helm registration. Set HELM_DIR to a temporary directory before importing Helm modules.');
  }
  if (process.env.HELM_DIR && canonicalDirectory(process.env.HELM_DIR) !== canonicalDirectory(HELM_DIR)) {
    throw new Error('HELM_DIR changed after Helm was imported; refusing to write the production registration. Set HELM_DIR before importing Helm modules.');
  }
};

const write = (net, { joining = false } = {}) => {
  assertWritableDirectory();
  if (net.machines?.[net.self]) {
    const me = net.machines[net.self];
    if (!checkMachineRecord(net, me)) me.updatedAt = Math.max(Date.now(), (me.updatedAt ?? 0) + 1);
    signMachineRecord(net, me);
  }
  if (isProductionDirectory()) {
    const existing = loadNetwork();
    const provisionalJoin = joining && existing?.provisional
      && Object.keys(existing.machines ?? {}).length === 1;
    if (existing && !provisionalJoin
        && (existing.id !== net.id || existing.self !== net.self || existing.key !== net.key)) {
      throw new Error('This machine already has a Helm registration; refusing to replace its network or machine identity. Use a temporary HELM_DIR for tests.');
    }
  }
  mkdirSync(HELM_DIR, { recursive: true, mode: 0o700 });
  chmodSync(HELM_DIR, 0o700);
  // 0600: the file contains the network key, which is the whole ballgame.
  // Readers must see the complete old or new registration, never a truncated
  // file that looks like an unregistered machine during a daemon restart.
  const temporary = `${NETWORK_FILE}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(net, null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, NETWORK_FILE);
  } finally { rmSync(temporary, { force: true }); }
  return net;
};

let networkCache = null;

export function loadNetwork() {
  let info;
  try { info = statSync(NETWORK_FILE, { bigint: true }); }
  catch { networkCache = null; return null; }
  // Check metadata on every read: revocations and writes from another
  // process must be visible immediately, without waiting for a watcher.
  const stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  if (networkCache?.stamp === stamp) return structuredClone(networkCache.net);
  try {
    const net = JSON.parse(readFileSync(NETWORK_FILE, 'utf8'));
    if (isProductionDirectory() && (!net || typeof net.id !== 'string'
        || typeof net.self !== 'string' || typeof net.key !== 'string')) throw new Error();
    networkCache = { stamp, net };
    return structuredClone(net);
  } catch {
    networkCache = null;
    if (isProductionDirectory()) {
      throw new Error('The existing Helm registration cannot be read. Restore network.json from a backup; it will not be replaced with a new network.');
    }
    return null;
  }
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
  assertWritableDirectory();
  mkdirSync(HELM_DIR, { recursive: true, mode: 0o700 });
  chmodSync(HELM_DIR, 0o700);
  if (existsSync(LOCAL_KEY_FILE)) {
    chmodSync(LOCAL_KEY_FILE, 0o600);
    const v = readFileSync(LOCAL_KEY_FILE, 'utf8').trim();
    if (v) return v;
  }
  const v = newNetworkKey();
  writeFileSync(LOCAL_KEY_FILE, v, { mode: 0o600 });
  chmodSync(LOCAL_KEY_FILE, 0o600);
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
 * a home - it holds an https address the others can be dialled at.
 *
 * A controller is deliberately not here. It is not a fourth kind of machine:
 * it holds a device token rather than the network key, runs no daemon and
 * cannot become a machine, so no value of `kind` ever names it.
 */
export const MACHINE_KINDS = ['pc', 'vm'];
export const machineKind = (v) => (MACHINE_KINDS.includes(v) ? v : null);
// Older machines may still hold 'nas' (storage, since removed) on their own
// record. The roster keeps it word for word so fingerprints stay equal; it
// acts as a pc everywhere it is read.
const rosterKind = (v) => (v === 'nas' ? v : machineKind(v));

/** The private signing key stays on this machine, outside the shared roster. */
export function machineSigningInfo() {
  assertWritableDirectory();
  const file = join(HELM_DIR, 'code_ed25519');
  if (!existsSync(file) && !existsSync(`${file}.pub`)) {
    mkdirSync(HELM_DIR, { recursive: true, mode: 0o700 });
    const pair = generateKeyPairSync('ed25519');
    writeFileSync(file, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    writeFileSync(`${file}.pub`, pair.publicKey.export({ type: 'spki', format: 'der' }), { mode: 0o600, flag: 'wx' });
  }
  chmodSync(HELM_DIR, 0o700);
  const privateKey = createPrivateKey(readFileSync(file));
  const publicKey = createPublicKey(privateKey);
  const codeSignPubkey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  if (readFileSync(`${file}.pub`).toString('base64url') !== codeSignPubkey) throw new Error('The machine signing keys do not match. Restore them from a backup.');
  chmodSync(file, 0o600);
  chmodSync(`${file}.pub`, 0o600);
  return { privateKey, publicKey, codeSignPubkey };
}

function recordBody(net, record) {
  const clean = machineRecord(record.id, record, Infinity);
  if (!clean) throw new Error('Cannot sign this machine record.');
  delete clean.machineSignature;
  return proofBody(net.id, 'machine-record', clean);
}
export function signMachineRecord(net, record) {
  const pair = machineSigningInfo();
  record.codeSignPubkey = pair.codeSignPubkey;
  record.machineSignature = sign(null, recordBody(net, record), pair.privateKey).toString('base64url');
  return record;
}
export function checkMachineRecord(net, record, key = record?.codeSignPubkey) {
  try { return !!key && typeof record?.machineSignature === 'string' && verify(null,
    recordBody(net, record), createPublicKey({ key: Buffer.from(key, 'base64url'), type: 'spki', format: 'der' }), Buffer.from(record.machineSignature, 'base64url')); }
  catch { return false; }
}

const credentialBody = (claims) => Buffer.from('helm-credential-v2:' + JSON.stringify([
  claims.net, claims.sub, claims.role, claims.issuer, claims.ch ?? null, claims.exp ?? null,
  ...(claims.proofKey ? [claims.proofKey] : []),
  // An object, so it can never read as a proofKey.
  ...(claims.aud !== undefined ? [{ aud: claims.aud }] : []),
]));
const signedToken = (net, claims) => {
  const signed = { ...claims, issuer: net.self };
  signed.signature = sign(null, credentialBody(signed), machineSigningInfo().privateKey).toString('base64url');
  return mintToken(net.key, signed);
};
const DEVICE_TTL = 7 * 24 * 60 * 60_000;

/** Public keys and addresses a signed-in browser may contact. */
export function hubTrust(net) {
  return { network: net.id, revoked: Object.keys(net.revoked ?? {}), machines: Object.fromEntries(Object.values(net.machines ?? {})
    .filter(m => !net.revoked?.[m.id] && m.codeSignPubkey)
    .map(m => [m.id, { key: m.codeSignPubkey, endpoints: m.endpoints ?? [] }])) };
}

/** Remote connections must use TLS. Loopback stays available for local tools. */
export function secureHubAddress(base) {
  try {
    const url = new URL(base);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return !url.username && !url.password && !url.search && !url.hash
      && url.pathname === '/' && (url.protocol === 'https:' || (url.protocol === 'http:' && local));
  } catch { return false; }
}

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
        id, name: cleanName(name, hostname()), kind: 'vm', endpoints: [], signedHub: true,
        updatedAt: Date.now(), addedAt: Date.now(), codeSignPubkey: machineSigningInfo().codeSignPubkey,
      },
    },
    devices: {},
    revoked: {},
  });
}

/**
 * The inviter's receipt for a new machine. Other machines accept a machine
 * they have not seen only with this receipt, signed by a member they know.
 */
export const admitMachine = (net, machine, key) =>
  signNetworkProof(net, MACHINE_ADMISSION, { machine, key, at: Date.now() });
const MACHINE_ADMISSION = 'machine-admission';

/** Join a network we have been handed the key to. */
export function joinNetwork({ id, key, name = hostname(), port = 8787, machines = {}, devices = {}, revoked = {}, self = newDeviceId(), admission }) {
  // What the inviter handed us is a roster from the network, which is exactly
  // the thing `mergeRoster` refuses to take on trust; hold it to the same bar.
  const given = sanitizeRoster({ id, machines, devices, revoked });
  return write({
    id, key, self, port,
    machines: {
      ...given.machines,
      [self]: {
        id: self, name: cleanName(name, hostname()), endpoints: [], signedHub: true,
        updatedAt: Date.now(), addedAt: Date.now(), codeSignPubkey: machineSigningInfo().codeSignPubkey,
        ...(admissionOf(admission) ? { admission: admissionOf(admission) } : {}),
      },
    },
    devices: given.devices,
    revoked: given.revoked,
  }, { joining: true });
}

export function forgetNetwork() {
  assertWritableDirectory();
  rmSync(NETWORK_FILE, { force: true });
}

// ------------------------------------------------------------------ tokens

/**
 * A credential for this machine, proving membership to any peer. Durable,
 * so it is what the CLI's own tooling may hold - but it never goes over the
 * wire from a daemon any more: see `hubCredential`.
 */
export const machineToken = (net) =>
  signedToken(net, { net: net.id, sub: net.self, role: ROLE.MACHINE });

// ------------------------------------------------------------ hub handshake
//
// Remote hubs require HTTPS. The shared-key proof checks network membership;
// the signed credential proves the caller owns its pinned machine key.

export const HELLO_PATH = '/api/hub/hello';
const HUB_PROOF = 'hub-proof';
const CREDENTIAL_TTL_MS = 60_000;

/** The hub's answer to a dialler's nonce. */
export const hubProof = (net, nonce) => proofOf(net.key, HUB_PROOF, `${net.id}:${nonce}`);

export const checkHubProof = (net, nonce, mac) =>
  checkProof(net.key, HUB_PROOF, `${net.id}:${nonce}`, mac);

/**
 * The whole hello answer. The shared-key proof shows network membership,
 * and any member can make it for any nonce. The signed part names this
 * machine, so a dialler can check that the machine which owns the address it
 * dialled answered, and not a member it was relayed to.
 */
export function hubHelloAnswer(net, nonce) {
  const challenge = issueChallenge();
  return {
    net: net.id, proof: hubProof(net, nonce), challenge,
    signed: signNetworkProof(net, HUB_HELLO, { nonce, challenge, network: net.id }),
  };
}
const HUB_HELLO = 'hub-hello';

/**
 * A machine token spendable once, against the challenge the hub issued.
 * `aud` names the hub it is for. A hub that has not signed its hello yet
 * (older Helm) gets no `aud`: its credential check would not know the field.
 */
export const oneTimeToken = (net, challenge, aud) => signedToken(net, {
  net: net.id, sub: net.self, role: ROLE.MACHINE, ch: challenge, exp: Date.now() + CREDENTIAL_TTL_MS,
  ...(aud !== undefined ? { aud } : {}),
});

/**
 * The machines that own the address `base`. Loopback on this machine's port
 * is its own hub. `machine` adds an address heard on the LAN for that machine.
 */
export function addressOwners(net, base, machine) {
  const clean = String(base ?? '').replace(/\/+$/, '');
  let url;
  try { url = new URL(clean); } catch { return []; }
  const owners = new Set();
  // Loopback is this machine's hub only on its own port: another program
  // can listen on any other one.
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && net.machines?.[net.self]
      && Number(url.port || 80) === Number(net.port ?? 8787)) owners.add(net.self);
  for (const [id, m] of Object.entries(net.machines ?? {})) {
    if (net.revoked?.[id]) continue;
    if ((m.endpoints ?? []).some((e) => e.replace(/\/+$/, '') === clean)) owners.add(id);
  }
  const boot = bootstrapAddress(net);
  if (boot && boot.url.replace(/\/+$/, '') === clean) owners.add(boot.machine);
  if (machine && net.machines?.[machine] && !net.revoked?.[machine]) owners.add(machine);
  return [...owners];
}

/**
 * Handshake with the hub at `base` (http/https) and return a credential for
 * one request or socket. Throws, without having sent anything secret, if the
 * hub cannot prove it is part of this network - an older hub included: it
 * has no hello route, and falling back to the durable token for it would be
 * the very downgrade an impostor would ask for.
 */
/**
 * POST a small JSON body and read a small JSON answer. Not fetch: when fetch
 * gives up on an address that does not answer, its connection keeps trying
 * for ten more seconds, and a `helm` command that asked an offline machine
 * stayed open that long after it was done. Giving up here closes it at once.
 * Failures read as fetch's did, so every caller's retry rules stay the same.
 */
function postJson(url, body, { timeout, signal }) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    let req, timer, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      req?.destroy();
      if (error) reject(error); else resolve(value);
    };
    const aborted = () => finish(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
    if (signal?.aborted) { aborted(); return; }
    let target;
    try { target = new URL(url); } catch (cause) { finish(new TypeError('fetch failed', { cause })); return; }
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    req = send(target, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      // Only a good answer is read; anything else is told by its status.
      if (res.statusCode < 200 || res.statusCode >= 300) { finish(null, { status: res.statusCode, body: null }); return; }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 64 * 1024) finish(null, { status: res.statusCode, body: null });
        else chunks.push(chunk);
      });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not a hub's answer */ }
        finish(null, { status: res.statusCode, body: parsed });
      });
      res.on('error', (cause) => finish(new TypeError('fetch failed', { cause })));
    });
    req.on('error', (cause) => finish(new TypeError('fetch failed', { cause })));
    timer = setTimeout(() => finish(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), timeout);
    signal?.addEventListener('abort', aborted, { once: true });
    req.end(data);
  });
}

/** The sign-in request, kept on an object so a test can stand in for it. */
export const hubHello = { post: postJson };

export async function hubCredential(net, base, { timeout = 15_000, signal, machine } = {}) {
  if (!secureHubAddress(base)) throw new Error('Use HTTPS to connect to another machine.');
  const owners = addressOwners(net, base, machine);
  if (!owners.length) {
    const err = new Error('that address belongs to no machine in this network - nothing was sent to it');
    err.untrusted = true;
    throw err;
  }
  const nonce = randomBytes(24).toString('base64url');
  const res = await hubHello.post(`${base.replace(/\/+$/, '')}${HELLO_PATH}`, { nonce }, { timeout, signal });
  if (res.status === 404) {
    const err = new Error('that hub runs an older helm without the handshake - upgrade it');
    err.untrusted = true;
    throw err;
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`hub hello answered ${res.status}`);
  const body = res.body;
  const impostor = () => {
    const err = new Error('that address answered, but not as a hub of this network - nothing was sent to it');
    err.untrusted = true;
    return err;
  };
  if (!body || body.net !== net.id || typeof body.challenge !== 'string'
      || !checkHubProof(net, nonce, body.proof)) throw impostor();
  // The machine that owns this address must have answered. Any other
  // member's signature means the hello was relayed.
  const signed = body.signed;
  if (signed && signed.nonce === nonce && signed.challenge === body.challenge && signed.network === net.id
      && owners.includes(signed.issuer) && checkNetworkProof(net, HUB_HELLO, signed)) {
    return oneTimeToken(net, body.challenge, signed.issuer);
  }
  // Otherwise allowed only while an owner of this address still runs an
  // older Helm, as before. Its own signed record says when it has updated,
  // and from then on an answer without its signature is a downgrade. A
  // signature this side cannot check changes nothing: a relay could drop it.
  if (!owners.some((id) => !net.machines[id]?.signedHub)) throw impostor();
  // A hub that signed is new enough to read a hub name, and an updated hub
  // wants one. Naming the owner it claims to be only narrows where the
  // credential works.
  const claimed = signed && owners.includes(signed.issuer) ? signed.issuer : undefined;
  return oneTimeToken(net, body.challenge, claimed);
}

/**
 * A browser credential lasts seven days. Revocation also ends it.
 *
 * The label is whatever the browser called itself in the login body, so it is
 * cleaned on the way in for the same reason a machine name is: it goes into
 * the roster, and a record this machine authors must be one every other
 * machine will accept back unchanged.
 */
export function issueDevice(net, label = 'device', proofKey) {
  const id = newDeviceId();
  net.devices[id] = {
    id, label: cleanName(label, 'device').slice(0, 60),
    addedAt: Date.now(), updatedAt: Date.now(),
  };
  write(net);
  return { id, token: signedToken(net, { net: net.id, sub: id, role: ROLE.DEVICE, ...(proofKey ? { proofKey } : {}), exp: Date.now() + DEVICE_TTL }) };
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
export function deviceToken(net, id, proofKey) {
  if (!net.devices[id] || net.revoked[id]) return null;
  return signedToken(net, { net: net.id, sub: id, role: ROLE.DEVICE, ...(proofKey ? { proofKey } : {}), exp: Date.now() + DEVICE_TTL });
}

/**
 * Is this token allowed in right now?
 *
 * Signature first (cheap, and settles whether the bearer knows the key at
 * all), then the pinned signing key, roster membership, expiry and revocation.
 */
export function authenticate(net, token) {
  const claims = verifyToken(net.key, token);
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return null;
  if (claims.net !== net.id) return null;
  if (claims.role !== ROLE.MACHINE && claims.role !== ROLE.DEVICE) return null;
  if (typeof claims.sub !== 'string' || !ids.test(claims.sub)) return null;
  if (net.revoked[claims.sub]) return null;
  if (claims.role === ROLE.MACHINE && !Object.hasOwn(net.machines ?? {}, claims.sub)) return null;
  if (claims.role === ROLE.MACHINE && claims.issuer !== claims.sub) return null;
  if (typeof claims.issuer !== 'string' || net.revoked[claims.issuer]) return null;
  const key = net.machines?.[claims.issuer]?.codeSignPubkey;
  if (!key || typeof claims.signature !== 'string') return null;
  try {
    if (!verify(null, credentialBody(claims), createPublicKey({ key: Buffer.from(key, 'base64url'), type: 'spki', format: 'der' }), Buffer.from(claims.signature, 'base64url'))) return null;
  } catch { return null; }
  if (claims.role === ROLE.DEVICE && !(claims.exp > Date.now() && claims.exp <= Date.now() + DEVICE_TTL)) return null;
  if (claims.role === ROLE.DEVICE && !Object.hasOwn(net.devices ?? {}, claims.sub)) return null;
  if (claims.exp !== undefined && !(claims.exp > Date.now())) return null;
  // A credential that names a hub is good at that hub only. A machine that
  // has updated always names one, so a credential of its without a name was
  // signed for someone else's hello.
  if (claims.aud !== undefined && claims.aud !== net.self) return null;
  if (claims.role === ROLE.MACHINE && claims.ch !== undefined && claims.aud === undefined
      && net.machines[claims.sub]?.signedHub) return null;
  // A handshake credential is good once, and only here: the challenge it
  // answers must be one this process issued and nobody has spent.
  if (claims.ch !== undefined && !spendChallenge(claims.ch)) return null;
  return claims;
}

/** A browser signs each remote request for one hub and one challenge. */
export const deviceProofBody = (network, p) => Buffer.from(JSON.stringify([
  'helm-device-request-v1', network, p.aud, p.sub, p.ch, p.method, p.path, p.exp,
]));
export function checkDeviceRequest(net, claims, encoded, method, path) {
  if (claims?.role !== ROLE.DEVICE) return true;
  if (!claims.proofKey || typeof encoded !== 'string' || encoded.length > 4096) return false;
  try {
    const p = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (p.aud !== net.self || p.sub !== claims.sub || p.method !== method || p.path !== path
        || !(p.exp > Date.now()) || p.exp > Date.now() + 60_000 || typeof p.signature !== 'string') return false;
    const key = createPublicKey({ key: Buffer.from(claims.proofKey, 'base64url'), type: 'spki', format: 'der' });
    return verify(null, deviceProofBody(net.id, p), key, Buffer.from(p.signature, 'base64url')) && spendChallenge(p.ch);
  } catch { return false; }
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

/**
 * Call `onChange(net, hash)` soon after this machine's roster changes, however
 * it changed: the CLI writing the file from another process, a login on the
 * hub, a merge from gossip.
 *
 * Gossip used to notice only on its 15-second tick, so a device removed on one
 * machine kept working on the others for up to two ticks - half a minute in
 * which "remove" was a request rather than a decision. This only moves *when*
 * the existing fingerprint exchange starts; what is exchanged, and who merges
 * what, is untouched, and the tick stays as the net under it.
 *
 * It fires only when the roster's fingerprint really differs from the last one
 * seen. That is what keeps two machines that just merged each other's records
 * from answering each other for ever, and what keeps a machine's own periodic
 * rewrites of an unchanged record quiet. The directory is watched rather than
 * the file, because a watch on a file dies with the inode when it is replaced.
 * Returns a stop function; where the platform cannot watch, it does nothing
 * and the tick carries on alone.
 */
export function watchNetwork(onChange, { debounceMs = 150 } = {}) {
  let last = null;
  const read = () => { const net = loadNetwork(); return net ? rosterHash(net) : null; };
  last = read();
  let timer = null;
  let watcher = null;
  try {
    watcher = watch(HELM_DIR, { persistent: false }, (_event, name) => {
      if (name && name !== 'network.json') return;
      clearTimeout(timer);
      const settle = (retry) => {
        const net = loadNetwork();
        // A write in flight reads as unparseable. Look once more rather than
        // leave the change to the next tick.
        if (!net) {
          if (retry) { timer = setTimeout(() => settle(false), debounceMs * 2); timer.unref?.(); }
          return;
        }
        const hash = rosterHash(net);
        if (hash === last) return;
        last = hash;
        try { onChange(net, hash); } catch { /* the tick is the fallback */ }
      };
      timer = setTimeout(() => settle(true), debounceMs);
      timer.unref?.();
    });
    watcher.on('error', () => {});
  } catch { /* no inotify here: the periodic tick still runs */ }
  return () => { clearTimeout(timer); watcher?.close(); };
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
const CODE_PUBKEY = /^[A-Za-z0-9_-]{40,512}$/;

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

// X25519 SPKI, base64url encoded. It is deliberately kept as one printable
// roster field so it cannot become a line injection when gossiped or logged.
const codePubkeyOf = (v) => {
  const raw = text(v, 512);
  return raw && CODE_PUBKEY.test(raw) ? raw : null;
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
  keep(out, 'kind', rosterKind(their.kind));
  keep(out, 'addedAt', stampOf(their.addedAt, ceiling));
  keep(out, 'pubkey', pubkeyOf(their.pubkey));
  keep(out, 'codePubkey', codePubkeyOf(their.codePubkey));
  // Ed25519 half of the same identity - same shape, same checks, pinned the
  // same way in mergeRoster.
  keep(out, 'codeSignPubkey', codePubkeyOf(their.codeSignPubkey));
  keep(out, 'machineSignature', text(their.machineSignature, 128));
  keep(out, 'sendV2', typeof their.sendV2 === 'boolean' ? their.sendV2 : null);
  // This machine's hub signs its hello (see hubCredential).
  keep(out, 'signedHub', their.signedHub === true ? true : null);
  keep(out, 'admission', admissionOf(their.admission, id, ceiling));
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

/** An admission receipt of exactly the shape admitMachine makes, or null. */
function admissionOf(v, machine = v?.machine, ceiling = Date.now() + MAX_CLOCK_SKEW_MS) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const keys = Object.keys(v).sort().join();
  if (keys !== 'at,issuer,key,machine,signature') return null;
  if (typeof v.issuer !== 'string' || !ids.test(v.issuer) || v.machine !== machine || !ids.test(String(machine))
      || !codePubkeyOf(v.key) || stampOf(v.at, ceiling) === null || !text(v.signature, 128)) return null;
  return { machine: v.machine, key: v.key, at: v.at, issuer: v.issuer, signature: v.signature };
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

  // A machine this side has not seen needs an admission receipt from a member
  // it knows. That member can arrive in the same roster, so repeat until no
  // more records join.
  const pending = new Map(Object.entries(incoming.machines ?? {}));
  for (let progress = true; progress && pending.size;) {
    progress = false;
    for (const [id, their] of pending) {
      if (!net.machines[id] && !admitted(net, id, their)) continue;
      pending.delete(id);
      progress = true;
      if (mergeMachine(net, id, their)) changed = true;
    }
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
  if (net.bootstrap && !bootstrapAddress(net)) { delete net.bootstrap; changed = true; }

  if (changed) write(net);
  return changed;
}

/**
 * Whether a machine this side has not seen may join its roster: the record
 * must carry an admission receipt for this id and signing key, signed by a
 * current member this side already knows.
 */
function admitted(net, id, their) {
  const a = their.admission;
  return !!a && a.machine === id && a.key === their.codeSignPubkey && a.issuer !== id
    && !!net.machines[a.issuer] && checkNetworkProof(net, MACHINE_ADMISSION, a);
}

/** Fold one signed machine record in. Returns whether it changed. */
function mergeMachine(net, id, their) {
  if (net.revoked[id]) return false;
  // A machine is the only writer of its own record. Without this, someone
  // else's view of us - a hub that had never heard of us writing an empty
  // placeholder, stamped with its own clock - wins on last-writer-wins and
  // we overwrite our own address list with nothing. We then advertise no
  // way to reach us, and nothing can dial us until a restart.
  if (id === net.self) return false;
  const current = net.machines[id];
  if (current && !current.codeSignPubkey) return false;
  // Existing unsigned records stay fixed until their owner signs an update.
  if (!checkMachineRecord(net, their, current?.codeSignPubkey ?? their.codeSignPubkey)) return false;
  // A code key once learned is pinned to the machine it was learned for
  // (TOFU): it is what code handoffs are encrypted to, so a forged newer
  // record - or one that simply omits the field - must never swap or
  // remove it. The signing key is pinned the same way, and independently:
  // a record learned before the second key existed keeps the one it has
  // while still being able to learn the other. Every other field still
  // merges last-writer-wins.
  if (current?.codePubkey && current.codePubkey !== their.codePubkey) return false;
  if (current?.codeSignPubkey && current.codeSignPubkey !== their.codeSignPubkey) return false;
  const won = newer(current, their);
  if (won === current) return false;
  net.machines[id] = won;
  return true;
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
  if (!changed && checkMachineRecord(net, me)) return net;

  me.updatedAt = Date.now();
  return write(net);
}

/** Record where we can be reached, for other members to try later. */
export const advertise = (net, endpoints) => describeSelf(net, { endpoints });

/** Every address any member has told us about, ours last. */
export function allEndpoints(net) {
  const out = [];
  for (const m of Object.values(net.machines)) {
    if (m.id === net.self || net.revoked?.[m.id]) continue;
    for (const e of m.endpoints ?? []) if (!out.includes(e)) out.push(e);
  }
  for (const e of (net.revoked?.[net.self] ? [] : net.machines[net.self]?.endpoints ?? [])) {
    if (!out.includes(e)) out.push(e);
  }
  const boot = bootstrapAddress(net);
  if (boot && !out.includes(boot.url)) out.push(boot.url);
  return out;
}

/** How long the invitation address is used while its owner advertises nothing. */
export const BOOTSTRAP_TTL_MS = 24 * 60 * 60_000;

/**
 * The address this machine joined through, while it still stands in for the
 * inviter: until the inviter advertises any address of its own, and for one
 * day at most. An old address can change owner, so it must not live on.
 */
export function bootstrapAddress(net, now = Date.now()) {
  const b = net?.bootstrap;
  if (!b || typeof b.url !== 'string' || b.machine === net.self || net.revoked?.[b.machine]) return null;
  const owner = net.machines?.[b.machine];
  if (!owner || (owner.endpoints ?? []).length || !secureHubAddress(b.url)) return null;
  if (!(b.at > now - BOOTSTRAP_TTL_MS && b.at <= now + MAX_CLOCK_SKEW_MS)) return null;
  return { machine: b.machine, url: b.url };
}

// ------------------------------------------------------------------ publish

setProofSigner(() => machineSigningInfo().privateKey);
