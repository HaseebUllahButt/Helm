import test from 'node:test';
import assert from 'node:assert/strict';
import { systemdArg } from '../packages/connect/src/service.js';

test('systemd service arguments preserve spaces and disable specifiers', () => {
  assert.equal(systemdArg('/home/a path/helm'), '"/home/a path/helm"');
  assert.equal(systemdArg('https://helm.example/%n'), '"https://helm.example/%%n"');
  assert.equal(systemdArg('a"b\\c'), '"a\\"b\\\\c"');
  assert.throws(() => systemdArg('one\ntwo'), /newlines/);
});

test('the service starts Node under Helm\'s own name', async () => {
  const { execStart, renamedUnit } = await import('../packages/connect/src/service.js');
  assert.equal(execStart('/usr/bin/node', ['/a b/helm.js', 'up', '--name', '50%']),
    'ExecStart=@"/usr/bin/node" "helm" "/a b/helm.js" "up" "--name" "50%%"');
  const old = '[Service]\nType=simple\nExecStart="/usr/bin/node" "/x/helm.js" "up" "--host" "0.0.0.0"\nRestart=always\n';
  const next = renamedUnit(old);
  assert.equal(next, '[Service]\nType=simple\nExecStart=@"/usr/bin/node" "helm" "/x/helm.js" "up" "--host" "0.0.0.0"\nRestart=always\n');
  // Once only, and never a line Helm did not write this way.
  assert.equal(renamedUnit(next), null);
  assert.equal(renamedUnit('ExecStart=/usr/bin/node /x/helm.js up\n'), null);
});

test('an installed service file is renamed once, and comes back if systemd refuses it', { skip: process.platform !== 'linux' }, async () => {
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { renameService } = await import('../packages/connect/src/service.js');
  const dir = mkdtempSync(join(tmpdir(), 'helm-unit-'));
  const file = join(dir, 'helm-serve.service');
  const old = '[Service]\nExecStart="/usr/bin/node" "/x/helm.js" "up"\n';
  const kept = { ...process.env };
  process.env.INVOCATION_ID = 'test';
  delete process.env.HELM_NO_SERVICE;
  // systemd as it answers: the line it has loaded, and the service's process.
  const systemd = ({ pid = process.pid, accepts = true } = {}) => {
    const calls = [];
    let loaded = old;
    const run = async (_cmd, args) => {
      calls.push(args.filter((a) => a !== '--user').join(' '));
      if (args.includes('daemon-reload')) loaded = readFileSync(file, 'utf8');
      if (args.includes('MainPID')) return { stdout: `${pid}\n` };
      if (args.includes('ExecStart')) {
        const named = loaded.includes('ExecStart=@');
        return { stdout: `{ path=/usr/bin/node ; argv[]=${named && accepts ? 'helm' : '/usr/bin/node'} /x/helm.js up ; ignore_errors=no }\n` };
      }
      return { stdout: '' };
    };
    return { run, calls };
  };
  try {
    writeFileSync(file, old);
    const ok = systemd();
    assert.equal(await renameService({ dir, run: ok.run }), true);
    assert.match(readFileSync(file, 'utf8'), /^ExecStart=@"\/usr\/bin\/node" "helm" "\/x\/helm\.js" "up"$/m);
    assert.equal(ok.calls.at(-1), '--no-block restart helm-serve.service');
    // Started again under the new line: nothing more to do, so no restart loop.
    const again = systemd();
    assert.equal(await renameService({ dir, run: again.run }), false);
    assert.deepEqual(again.calls, []);

    // A `helm up` run by hand is not the service's process.
    writeFileSync(file, old);
    const other = systemd({ pid: 1 });
    assert.equal(await renameService({ dir, run: other.run }), false);
    assert.equal(readFileSync(file, 'utf8'), old);

    // systemd reads the line another way: the old file is back, no restart.
    const refuses = systemd({ accepts: false });
    await assert.rejects(renameService({ dir, run: refuses.run }), /old one is back/);
    assert.equal(readFileSync(file, 'utf8'), old);
    assert.ok(!refuses.calls.some((c) => c.includes('restart')));
  } finally {
    process.env = kept;
    rmSync(dir, { recursive: true, force: true });
  }
});
