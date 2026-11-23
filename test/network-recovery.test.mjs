import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = await mkdtemp(join(tmpdir(), 'helm-network-recovery-'));
Object.assign(process.env, { HELM_DIR: join(root, 'state'), HELM_DB: join(root, 'db'),
  HELM_SSH_DIR: join(root, 'ssh'), HELM_PROCS_SOCKET: join(root, 'procs.sock'),
  HELM_TERMINALS_SOCKET: join(root, 'terminals.sock'), HELM_NATIVE_SOCKET: join(root, 'native.sock'),
  HERDR_SOCKET_PATH: join(root, 'herdr.sock'), HELM_NO_SERVICE: '1' });
const { ensureTcpRecovery, configuredTcpRecovery, TCP_RECOVERY_FILE, TCP_RECOVERY_SCRIPT,
  ensureFastTcp, FAST_TCP_FILE, FAST_TCP_SCRIPT } = await import('../packages/connect/src/network-recovery.js');
const exec = promisify(execFile);
test.after(() => rm(root, { recursive: true, force: true }));

async function fixture(context, { live = '0', saved } = {}) {
  const dir = await mkdtemp(join(root, 'case-'));
  const liveFile = join(dir, 'live');
  const configFile = join(dir, 'saved');
  await writeFile(liveFile, live);
  if (saved !== undefined) await writeFile(configFile, saved);
  await mkdir(join(dir, 'bin'));
  // Exercise the real repair shell, with every OS path redirected to this
  // fixture and an unprivileged sysctl stand-in. Never invoke sudo or change
  // the host kernel, even when running this test as root.
  await writeFile(join(dir, 'bin/sysctl'), `#!/bin/sh\n[ "$1" = -w ] || exit 1\nprintf '%s' "\${2##*=}" > '${liveFile}'\n`, { mode: 0o755 });
  let calls = 0;
  const options = { os: 'linux', env: {}, uid: 0, configured: async () => null,
    read: (path, encoding) => readFile(path === TCP_RECOVERY_FILE ? configFile : liveFile, encoding),
    run: async (command, args, opts) => {
      assert.equal(command, '/bin/sh');
      assert.equal(args[0], '-c');
      calls++;
      const script = args[1].replaceAll(TCP_RECOVERY_FILE, configFile)
        .replaceAll('/proc/sys/net/ipv4/tcp_mtu_probing', liveFile)
        .replaceAll('/etc/sysctl.d/.helm-tcp-mtu.', join(dir, '.helm-tcp-mtu.'));
      return exec('/bin/sh', ['-c', script, ...args.slice(2)], { ...opts, env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` } });
    },
  };
  return { options, liveFile, configFile, calls: () => calls };
}

test('repairs a disabled kernel, saves reboot protection, and becomes a no-op', async context => {
  const f = await fixture(context);
  const status = await ensureTcpRecovery(f.options);
  assert.equal(status.enabled, true);
  assert.equal(status.persistent, true);
  assert.equal(status.mode, 1);
  assert.equal(status.repair, undefined);
  assert.match(await readFile(f.configFile, 'utf8'), /tcp_mtu_probing = 1/);
  await ensureTcpRecovery(f.options);
  assert.equal(f.calls(), 1);
  // Another network tool resetting the live setting is repaired next time.
  await writeFile(f.liveFile, '0');
  assert.equal((await ensureTcpRecovery(f.options)).enabled, true);
  assert.equal(f.calls(), 2);
});

test('preserves stronger live or saved settings, including after a reboot', async context => {
  for (const state of [{ live: '2' }, { live: '0', saved: 'net.ipv4.tcp_mtu_probing = 2\n' },
    { live: '2', saved: 'net.ipv4.tcp_mtu_probing = 1\n' }]) {
    const f = await fixture(context, state);
    const status = await ensureTcpRecovery(f.options);
    assert.equal(status.mode, 2);
    assert.equal(status.persistentMode, 2);
    assert.equal(status.repair, undefined);
  }
});

test('an administrator password is never requested by a daemon; failures are visible', async context => {
  const f = await fixture(context);
  const status = await ensureTcpRecovery({ ...f.options, uid: 1000, run: async (command, args, opts) => {
    assert.equal(command, 'sudo');
    assert.deepEqual(args, ['-n', '/bin/sh', '-c', TCP_RECOVERY_SCRIPT, 'helm-network-repair', '1']);
    assert.equal(opts.timeout, 5000);
    throw Object.assign(new Error('failed'), { stderr: 'sudo: a password is required' });
  } });
  assert.equal(status.enabled, false);
  assert.equal(status.persistent, false);
  assert.equal(status.repair, 'helm network-repair');
  assert.match(status.reason, /password is required/);
  await ensureTcpRecovery({ ...f.options, uid: 1000, interactive: true, run: async (command, args) => {
    assert.equal(command, 'sudo');
    assert.equal(args[0], '/bin/sh');
  } });
});

test('configuration honors filename order, directory overrides, masks, and explicit disablement', async () => {
  const contents = new Map([
    ['/usr/lib/sysctl.d/10-recovery.conf', 'net.ipv4.tcp_mtu_probing=2'],
    ['/etc/sysctl.d/10-recovery.conf', ''], // /dev/null-style mask
    ['/etc/sysctl.d/90-recovery.conf', 'net.ipv4.tcp_mtu_probing = 1 # recovery'],
    ['/etc/sysctl.d/99-policy.conf', 'net/ipv4/tcp_mtu_probing = 0'],
  ]);
  const options = { list: async dir => [...contents.keys()].filter(path => path.startsWith(dir + '/')).map(path => path.slice(dir.length + 1)),
    read: async path => contents.get(path) ?? '' };
  assert.equal(await configuredTcpRecovery(options), 0);
  contents.set('/etc/sysctl.conf', 'net.ipv4.tcp_mtu_probing = 2');
  assert.equal(await configuredTcpRecovery(options), 2);
  contents.delete('/etc/sysctl.conf');
  contents.delete('/etc/sysctl.d/99-policy.conf');
  assert.equal(await configuredTcpRecovery(options), 1);
  contents.delete('/etc/sysctl.d/90-recovery.conf');
  assert.equal(await configuredTcpRecovery(options), null);
});

test('does not overwrite unrelated settings or follow a privileged symlink', async context => {
  const f = await fixture(context, { saved: 'net.ipv4.tcp_mtu_probing = 1\nnet.ipv4.ip_forward = 1\n' });
  const before = await readFile(f.configFile, 'utf8');
  assert.equal((await ensureTcpRecovery(f.options)).repair, 'helm network-repair');
  assert.equal(await readFile(f.configFile, 'utf8'), before);
  assert.equal(await readFile(f.liveFile, 'utf8'), '0');
  await rm(f.configFile);
  const target = join(root, 'symlink-target');
  await writeFile(target, 'net.ipv4.tcp_mtu_probing = 1\n');
  await symlink(target, f.configFile);
  assert.match((await ensureTcpRecovery(f.options)).reason, /symlink/);
  assert.equal(await readFile(target, 'utf8'), 'net.ipv4.tcp_mtu_probing = 1\n');
});

test('tests, disabled services, unsupported OSes and missing kernel support never run repairs', async context => {
  const f = await fixture(context);
  for (const override of [{ env: { NODE_TEST_CONTEXT: 'child-v8' } }, { env: { HELM_NO_SERVICE: '1' } }, { os: 'darwin' }]) {
    assert.equal((await ensureTcpRecovery({ ...f.options, ...override })).supported, false);
  }
  await writeFile(f.liveFile, 'unavailable');
  assert.equal((await ensureTcpRecovery(f.options)).supported, false);
  assert.equal(f.calls(), 0);
});

async function fastFixture({ live = 'cubic', available = 'reno cubic bbr', saved } = {}) {
  const dir = await mkdtemp(join(root, 'fast-'));
  const files = { live: join(dir, 'live'), available: join(dir, 'available'), saved: join(dir, 'saved'), modules: join(dir, 'modules') };
  await writeFile(files.live, `${live}\n`);
  await writeFile(files.available, `${available}\n`);
  if (saved !== undefined) await writeFile(files.saved, saved);
  await mkdir(files.modules);
  await mkdir(join(dir, 'bin'));
  // The real script, with every system path in this folder and stand-ins
  // for sysctl and modprobe. It never changes this computer.
  await writeFile(join(dir, 'bin/sysctl'), `#!/bin/sh\n[ "$1" = -w ] || exit 1\ncase "$2" in net.ipv4.tcp_congestion_control=*) printf '%s\\n' "\${2##*=}" > '${files.live}' ;; esac\n`, { mode: 0o755 });
  await writeFile(join(dir, 'bin/modprobe'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  let calls = 0;
  const options = { os: 'linux', env: {}, uid: 0, configured: async () => null,
    read: (path, encoding) => readFile(path === FAST_TCP_FILE ? files.saved : files.live, encoding),
    run: async (command, args, opts) => {
      assert.equal(command, '/bin/sh');
      calls++;
      const script = args[1].replaceAll(FAST_TCP_FILE, files.saved)
        .replaceAll('/proc/sys/net/ipv4/tcp_available_congestion_control', files.available)
        .replaceAll('/etc/sysctl.d/.helm-bbr.', join(dir, '.helm-bbr.'))
        .replaceAll('/etc/modules-load.d', files.modules);
      return exec('/bin/sh', ['-c', script, ...args.slice(2)], { ...opts, env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}` } });
    },
  };
  return { options, files, calls: () => calls };
}

test('turns on BBR where Linux still uses its default, saves it, and then does nothing', async () => {
  const f = await fastFixture();
  const status = await ensureFastTcp(f.options);
  assert.deepEqual([status.control, status.enabled, status.persistent, status.repair], ['bbr', true, true, undefined]);
  assert.match(await readFile(f.files.saved, 'utf8'), /net\.ipv4\.tcp_congestion_control = bbr/);
  assert.equal(await readFile(join(f.files.modules, 'helm-bbr.conf'), 'utf8'), 'tcp_bbr\n');
  await ensureFastTcp(f.options);
  assert.equal(f.calls(), 1);
});

test('keeps a congestion control someone chose, and asks no password from a service', async () => {
  const chosen = await fastFixture();
  const kept = await ensureFastTcp({ ...chosen.options, configured: async () => 'cubic' });
  assert.deepEqual([kept.control, kept.repair, chosen.calls()], ['cubic', undefined, 0]);

  const noBbr = await fastFixture({ available: 'reno cubic' });
  assert.match((await ensureFastTcp(noBbr.options)).reason, /no BBR/);
  assert.equal(await readFile(noBbr.files.live, 'utf8'), 'cubic\n');

  const f = await fastFixture();
  const status = await ensureFastTcp({ ...f.options, uid: 1000, run: async (command, args, opts) => {
    assert.equal(command, 'sudo');
    assert.deepEqual(args, ['-n', '/bin/sh', '-c', FAST_TCP_SCRIPT, 'helm-network-repair']);
    assert.equal(opts.timeout, 5000);
    throw Object.assign(new Error('failed'), { stderr: 'sudo: a password is required' });
  } });
  assert.equal(status.repair, 'helm network-repair');
  assert.match(status.reason, /password is required/);
});

test('the ufw rules for the local network are found missing only when ufw is on', async () => {
  const { missingLanRules } = await import('../packages/connect/src/network-recovery.js');
  assert.equal(missingLanRules('ENABLED=no', '', ['192.168.1.9']), null);
  assert.equal(missingLanRules('', '', ['192.168.1.9']), null);
  const none = missingLanRules('ENABLED=yes', '### tuple ### allow tcp 8787 0.0.0.0/0 any 192.168.1.0/24 in', ['192.168.1.9', '100.80.16.79']);
  assert.deepEqual(none.map(({ port, range }) => `${port} ${range}`), ['8787 192.168.0.0/16', '44301:44332 192.168.0.0/16']);
  const rules = [
    '### tuple ### allow udp 8787 0.0.0.0/0 any 192.168.1.0/24 in',
    '### tuple ### allow udp 44301:44332 0.0.0.0/0 any 0.0.0.0/0 in comment=48',
  ].join('\n');
  assert.deepEqual(missingLanRules('ENABLED=yes', rules, ['192.168.1.9']), []);
  // A rule for another subnet does not open this one; a rule for everyone does.
  assert.deepEqual(missingLanRules('ENABLED=yes', rules, ['10.0.0.5']).map(({ port, range }) => `${port} ${range}`), ['8787 10.0.0.0/8']);
});

test('the firewall repair runs ufw once per missing rule and reports what is still closed', async () => {
  const { ensureLanFirewall } = await import('../packages/connect/src/network-recovery.js');
  let rules = '';
  const calls = [];
  const read = async (path) => (path.endsWith('ufw.conf') ? 'ENABLED=yes\n' : rules);
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const at = args.indexOf('port');
    rules += `### tuple ### allow udp ${args[at + 1]} 0.0.0.0/0 any ${args[args.indexOf('from') + 1]} in\n`;
  };
  const env = {};
  const status = await ensureLanFirewall({ os: 'linux', env, uid: 1000, read, run, addresses: ['192.168.1.9'] });
  assert.deepEqual(status, { supported: true, missing: [] });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 3), ['sudo', '-n', 'ufw']);
  assert.ok(calls[0].includes('192.168.0.0/16') && calls[0].includes('8787'));
  assert.equal((await ensureLanFirewall({ os: 'linux', env, uid: 1000, read, run, addresses: ['192.168.1.9'] })).missing.length, 0);
  assert.equal(calls.length, 2, 'nothing to do the second time');

  const failed = await ensureLanFirewall({ os: 'linux', env, uid: 1000, read: async (path) => (path.endsWith('ufw.conf') ? 'ENABLED=yes' : ''),
    run: async () => { throw Object.assign(new Error('x'), { stderr: 'sudo: a password is required' }); }, addresses: ['10.1.2.3'] });
  assert.equal(failed.repair, 'helm network-repair');
  assert.match(failed.reason, /password/);
  assert.equal(failed.missing.length, 2);
});
