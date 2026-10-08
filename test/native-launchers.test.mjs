import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, renameSync, readlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'helm-native-launchers-'));
process.env.HELM_DIR = join(root, 'helm');
mkdirSync(process.env.HELM_DIR);
writeFileSync(join(process.env.HELM_DIR, 'profiles.json'), JSON.stringify({ version: 1, profiles: [] }));
const { integrateNativeCommands, removeNativeLaunchers, nativeIntegrationStatus, LAUNCHER_DIR } = await import('../packages/connect/src/native-cli.js');
test.after(() => rmSync(root, { recursive: true, force: true }));

const home = join(root, 'home'), bin = join(root, 'local-bin'), versions = join(root, 'versions');
for (const dir of [home, bin, versions]) mkdirSync(dir);
const bashrc = join(home, '.bashrc');
const provider = (name, text) => {
  const path = join(versions, name);
  writeFileSync(path, `#!/bin/sh\nprintf '${text} %s' "$*"\n`, { mode: 0o755 });
  return path;
};
/** How self-updaters swap the command: a new symlink renamed over the old. */
const update = (path, target) => { symlinkSync(target, `${path}.new`); renameSync(`${path}.new`, path); };
// Non-interactive, the way a script would run it: straight to the real CLI.
const run = (name) => execFileSync('/bin/sh', ['-c', `${name} hello`], {
  encoding: 'utf8', env: { ...process.env, PATH: `${LAUNCHER_DIR}:${bin}:/usr/bin:/bin` },
});
const savedPath = process.env.PATH;
// Isolate discovery from providers installed in /usr/bin on the test host.
process.env.PATH = bin;
test.after(() => { process.env.PATH = savedPath; });

test('the command runs from Helm\'s own folder, finds the real CLI each time, and survives its self-update', () => {
  symlinkSync(provider('claude-1', 'one'), join(bin, 'claude'));
  writeFileSync(bashrc, 'export PATH="$HOME/.local/bin:$PATH"\n');
  assert.deepEqual(integrateNativeCommands({ home, shells: [bashrc] }), ['claude']);
  assert.match(readFileSync(join(LAUNCHER_DIR, 'claude'), 'utf8'), /Helm native CLI integration/);
  assert.equal(run('claude'), 'one hello');
  // Nothing of the CLI's was touched.
  assert.equal(readlinkSync(join(bin, 'claude')), join(versions, 'claude-1'));
  update(join(bin, 'claude'), provider('claude-2', 'two'));
  assert.equal(run('claude'), 'two hello');
  // Last in the file, so it is first on PATH.
  assert.match(readFileSync(bashrc, 'utf8'), /\$PATH"\n\n# >>> helm[^\n]*\n[\s\S]*# <<< helm <<<\n$/);
  assert.deepEqual(nativeIntegrationStatus(), { on: true, commands: ['claude'] });
});

test('the PATH line is written once and moved back to the end when something is added after it', () => {
  integrateNativeCommands({ home, shells: [bashrc] });
  const once = readFileSync(bashrc, 'utf8');
  assert.equal(once.match(/# >>> helm/g).length, 1);
  writeFileSync(bashrc, `${once}export PATH="/opt/other:$PATH"\n`);
  integrateNativeCommands({ home, shells: [bashrc] });
  const text = readFileSync(bashrc, 'utf8');
  assert.equal(text.match(/# >>> helm/g).length, 1);
  assert.ok(text.indexOf('/opt/other') < text.indexOf('# >>> helm'));
  // An interactive shell really does find Helm's command first - even when
  // the folder was already on PATH further back, as `helm` itself puts it.
  for (const start of ['/usr/bin:/bin', `/usr/bin:/bin:${LAUNCHER_DIR}`]) {
    const [found, path] = execFileSync('/bin/bash', ['-c', `source ${bashrc}; command -v claude; echo "$PATH"`], { encoding: 'utf8', env: { HOME: home, PATH: start } }).trim().split('\n');
    assert.equal(found, join(LAUNCHER_DIR, 'claude'));
    assert.equal(path.split(':').filter((d) => d === LAUNCHER_DIR).length, 1, 'listed once');
  }
});

test('a command replaced by an older Helm is put back, then served from Helm\'s folder', () => {
  const real = provider('pi-real', 'pi');
  const path = join(bin, 'pi'), saved = join(bin, '.pi-helm-native');
  symlinkSync(real, saved);
  writeFileSync(path, '#!/bin/sh\n# Helm native CLI integration\nexec true\n', { mode: 0o755 });
  const manifest = JSON.parse(readFileSync(join(process.env.HELM_DIR, 'native-cli.json'), 'utf8'));
  writeFileSync(join(process.env.HELM_DIR, 'native-cli.json'), JSON.stringify({ ...manifest, pi: { path, saved, executable: real, engine: 'pi' } }));
  const now = integrateNativeCommands({ home, shells: [bashrc] });
  assert.equal(readlinkSync(path), real);
  assert.equal(existsSync(saved), false);
  assert.deepEqual(now.sort(), ['claude', 'pi']);
  assert.equal(run('pi'), 'pi hello');
});

test('turning it off removes the launchers and PATH line, and startup does not turn it back on', () => {
  const removed = removeNativeLaunchers({ home });
  assert.deepEqual(removed.sort(), ['claude', 'pi']);
  assert.equal(existsSync(join(LAUNCHER_DIR, 'claude')), false);
  assert.doesNotMatch(readFileSync(bashrc, 'utf8'), /helm/);
  assert.match(readFileSync(bashrc, 'utf8'), /\/opt\/other/);
  assert.deepEqual(integrateNativeCommands({ home, shells: [bashrc] }), []);
  assert.equal(nativeIntegrationStatus().on, false);
  assert.deepEqual(integrateNativeCommands({ enable: true, home, shells: [bashrc] }).sort(), ['claude', 'pi']);
  assert.equal(nativeIntegrationStatus().on, true);
});
