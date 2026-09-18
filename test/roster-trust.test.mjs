import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * What a roster is allowed to say, and what happens to it afterwards.
 *
 * A roster arrives from something that has proved membership and nothing
 * more, and what it contains is not inert: a machine record carries the SSH
 * key every other machine writes into its own authorized_keys, and the
 * addresses every device and daemon sends a bearer token to next. Before
 * these checks existed, one POST from a paired phone put an attacker's key on
 * every machine in the network.
 *
 * The second half of this file is the regression that fixing it nearly
 * caused: gossip converges by two machines hashing identical records, so any
 * field the receiver normalises is one the author keeps re-sending and the
 * receiver keeps rewriting. They never agree, and they trade full rosters
 * every tick forever.
 */

const root = mkdtempSync(join(tmpdir(), 'helm-roster-'));
process.env.HELM_DIR = join(root, 'helm');
process.env.HELM_SSH_DIR = join(root, 'ssh');

const N = await import('@helm/protocol/network');
const { applyPeers } = await import('../packages/connect/src/ssh.js');

test.after(() => rmSync(root, { recursive: true, force: true }));

const machine = (over = {}) => ({
  id: 'aa11bb22cc33',
  name: 'vm-c',
  endpoints: ['https://1-2-3-4.sslip.io'],
  pubkey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIREALKEY helm@haseeb',
  sshUser: 'haseeb',
  sshPort: 22,
  updatedAt: Date.now(),
  addedAt: Date.now(),
  ...over,
});

const only = (over) => N.sanitizeRoster({
  id: 'n1', machines: { aa11bb22cc33: machine(over) }, devices: {}, revoked: {},
}).machines.aa11bb22cc33;

test('an ordinary machine record survives intact', () => {
  const kept = only({});
  assert.equal(kept.name, 'vm-c');
  assert.equal(kept.pubkey, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIREALKEY helm@haseeb');
  assert.deepEqual(kept.endpoints, ['https://1-2-3-4.sslip.io']);
  assert.equal(kept.sshUser, 'haseeb');
  assert.equal(kept.sshPort, 22);
});

test('a newline in a name or key never reaches the roster', () => {
  assert.equal(only({ name: 'evil\n  ProxyCommand /bin/sh -c id' }).name, 'aa11bb22');
  assert.equal(only({ pubkey: 'ssh-ed25519 AAAAKEY x\nssh-rsa AAAASECOND y' }).pubkey, undefined);
});

test('a key that is not one openssh would accept is dropped', () => {
  for (const pubkey of [
    'command="rm -rf /" ssh-ed25519 AAAAKEY',   // an authorized_keys option
    'ssh-ed25519',                              // no blob
    'not-a-type AAAAKEY',                       // invented type
    'ssh-ed25519 AAAA!BAD comment',             // blob outside base64
  ]) assert.equal(only({ pubkey }).pubkey, undefined, pubkey);

  // A blob that is base64-shaped but nonsense does get through, and that is
  // fine: what matters is that the line cannot hold an option or a second
  // key. sshd ignores a key it cannot parse.
  assert.equal(only({ pubkey: 'ssh-ed25519 AAAA junk' }).pubkey, 'ssh-ed25519 AAAA junk');
});

test('an endpoint has to be an address something can be dialled at', () => {
  for (const bad of [
    'file:///etc/passwd', 'javascript:alert(1)',
    'http://user:pw@evil.example',              // credentials
    'https://evil.example/path?x=1',            // not an origin
  ]) assert.deepEqual(only({ endpoints: [bad] }).endpoints, [], bad);

  assert.deepEqual(
    only({ endpoints: ['http://192.168.1.5:8787', 'https://ok.example'] }).endpoints,
    ['http://192.168.1.5:8787', 'https://ok.example']
  );
});

test('a record stamped far in the future is refused outright', () => {
  // Last-writer-wins means such a record could never be corrected by the
  // machine it claims to describe.
  assert.equal(only({ updatedAt: Date.now() + 10 * 365 * 24 * 3600e3 }), undefined);
  // Ordinary skew is still believed.
  assert.ok(only({ updatedAt: Date.now() + 60_000 }));
});

test('ids, and the number of them, are bounded', () => {
  const machines = {};
  for (let i = 0; i < 400; i++) machines[i.toString(16).padStart(12, '0')] = machine();
  machines['../../etc/passwd'] = machine();
  machines['NOT-HEX'] = machine();
  const kept = N.sanitizeRoster({ id: 'n1', machines }).machines;
  assert.ok(Object.keys(kept).length <= 256);
  assert.equal(kept['../../etc/passwd'], undefined);
  assert.equal(kept['NOT-HEX'], undefined);
});

// ------------------------------------------------------------- convergence

test('what a machine authors is what a peer stores, byte for byte', () => {
  // The property gossip depends on: sanitising is identity on a well-formed
  // record, so two machines holding the same records produce the same hash.
  const authored = {
    id: 'n1',
    machines: { aa11bb22cc33: machine({ name: "Haseeb’s laptop" }) },
    devices: { dd44ee55ff66: { id: 'dd44ee55ff66', label: 'iPhone — Safari', addedAt: 1, updatedAt: 2 } },
    revoked: {},
  };
  const stored = N.sanitizeRoster(authored);
  assert.equal(N.rosterHash(authored), N.rosterHash(stored));
  // And again, so a second exchange has nothing left to teach either side.
  assert.equal(N.rosterHash(stored), N.rosterHash(N.sanitizeRoster(stored)));
});

test('the names and labels this machine authors survive its own checks', () => {
  // The other half of convergence: a record we write must be one we would
  // accept back. `createNetwork` and `issueDevice` are where both enter.
  const net = N.createNetwork({ name: 'x'.repeat(500), port: 8787 });
  N.issueDevice(net, 'y'.repeat(500));
  const mine = N.roster(N.loadNetwork());
  assert.equal(N.rosterHash(mine), N.rosterHash(N.sanitizeRoster(mine)));
});

test('a name typed into the app is one every machine will accept back', () => {
  // The rename path. A name is refused rather than repaired, because the
  // person typing it is there to be told - and because a name the roster or
  // the ssh files would rewrite is a record its author keeps re-sending and
  // every peer keeps rewriting, which is gossip that never converges.
  for (const bad of ['', '   ', '-vm', '.', 'my laptop', "Haseeb's", 'a\nb', 'x'.repeat(65)]) {
    assert.equal(N.machineName(bad), null, `should refuse ${JSON.stringify(bad)}`);
  }
  assert.equal(N.machineName('  vm-2.home '), 'vm-2.home');

  const net = N.createNetwork({ name: 'before', port: 8787 });
  N.describeSelf(net, { name: N.machineName('vm-2.home') });
  const mine = N.roster(N.loadNetwork());
  assert.equal(mine.machines[net.self].name, 'vm-2.home');
  assert.equal(N.rosterHash(mine), N.rosterHash(N.sanitizeRoster(mine)));

  // And the other half of what the name is for: it reaches the ssh config as
  // itself, so `ssh vm-2.home` resolves back to this machine at the hub.
  applyPeers([{ id: 'aa11bb22cc33', name: 'vm-2.home', pubkey: machine().pubkey, sshUser: 'haseeb', sshPort: 22 }]);
  assert.match(readFileSync(join(root, 'ssh', 'config'), 'utf8'), /^Host vm-2\.home$/m);
});

// --------------------------------------------------------------- ssh files

test('a hostile peer cannot write a line of its own into the ssh files', () => {
  applyPeers([
    {
      id: 'deadbeefcafe',
      name: 'evil\n  ProxyCommand /bin/sh -c "id > /tmp/pwned"',
      pubkey: 'ssh-ed25519 AAAAATTACKER a@b\nssh-rsa AAAASMUGGLED c@d',
      sshUser: 'root', sshPort: 22,
    },
    { id: 'aa11bb22cc33', name: 'vm-c', pubkey: 'ssh-ed25519 AAAAREAL helm@haseeb', sshUser: 'haseeb', sshPort: 22 },
  ]);

  const keys = readFileSync(join(root, 'ssh', 'authorized_keys'), 'utf8');
  assert.doesNotMatch(keys, /SMUGGLED|ATTACKER/);
  assert.match(keys, /ssh-ed25519 AAAAREAL {2}# helm:vm-c/);
  // The comment is dropped at the file, whatever travelled with the key.
  assert.doesNotMatch(keys, /helm@haseeb/);

  const config = readFileSync(join(root, 'ssh', 'config'), 'utf8');
  assert.doesNotMatch(config, /\/bin\/sh/);
  // helm's own ProxyCommand is the only one, for each of the two hosts.
  assert.equal(config.match(/^\s*ProxyCommand /gm).length, 2);
  assert.match(config, /^Host vm-c$/m);
});

test('a real peer list is written exactly as before', () => {
  const { peers } = applyPeers([
    { id: 'aa11bb22cc33', name: 'vm-c', pubkey: 'ssh-ed25519 AAAAREAL helm@haseeb', sshUser: 'haseeb', sshPort: 2222 },
  ]);
  assert.equal(peers, 1);
  const config = readFileSync(join(root, 'ssh', 'config'), 'utf8');
  assert.match(config, /^Host vm-c$/m);
  assert.match(config, /^ {2}User haseeb$/m);
  assert.match(config, /^ {2}Port 2222$/m);
});
