import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverBrowsers, systemChromium, chromiumUserDataDirs } from '../packages/connect/src/chromium-find.js';

const root = mkdtempSync(join(tmpdir(), 'helm-chromium-find-'));
test.after(() => rmSync(root, { recursive: true, force: true }));
const make = (dir, files) => { mkdirSync(dir, { recursive: true }); for (const [name, body] of Object.entries(files)) { const path = join(dir, name); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, body); } return dir; };
// A program with the files beside it that mark each kind of app.
const chromiumProgram = (dir, exe = 'run') => { make(dir, { 'resources.pak': '', 'chrome_100_percent.pak': '', [exe]: '#!/bin/sh\n' }); return join(dir, exe); };
const electronProgram = (dir, exe = 'run') => { make(dir, { 'resources.pak': '', 'resources/app.asar': '', [exe]: '#!/bin/sh\n' }); return join(dir, exe); };
const plainProgram = (dir, exe = 'run') => { make(dir, { [exe]: '#!/bin/sh\n' }); return join(dir, exe); };

test('Linux finds an unfamiliar Chromium browser by file evidence and rejects Electron and non-Chromium apps', () => {
  const home = mkdtempSync(join(root, 'linux-'));
  const bin = join(home, 'bin'), apps = join(home, 'apps');
  // A browser Helm has never heard of.
  const wave = chromiumProgram(join(bin, 'wave'), 'wavebrowser');
  const note = electronProgram(join(bin, 'note'), 'noteapp');
  const term = plainProgram(join(bin, 'term'), 'terminal');
  const entry = (file, exec, name) => writeFileSync(join(apps, file), `[Desktop Entry]\nName=${name}\nExec=${exec} %U\n`);
  mkdirSync(apps, { recursive: true });
  entry('wave.desktop', `${wave}`, 'Wave Browser');
  entry('note.desktop', `${note}`, 'Note'); // Electron: must be rejected
  entry('term.desktop', `${term}`, 'Terminal'); // not Chromium: must be rejected
  const opts = { home, entryDirs: [apps], flatpakDirs: [], pathDirs: [bin], run: () => { throw new Error('no default'); } };
  const found = discoverBrowsers({}, 'linux', opts);
  assert.deepEqual(found.map(b => b.name), ['Wave Browser'], 'only the real Chromium browser is found');
  assert.equal(found[0].program, wave);
  assert.equal(systemChromium({}, 'linux', opts), wave);
  // The system default browser is put first.
  const two = chromiumProgram(join(bin, 'two'), 'twobrowser');
  entry('two.desktop', `${two}`, 'Two');
  const ordered = discoverBrowsers({}, 'linux', { ...opts, run: (cmd) => cmd === 'xdg-settings' ? 'two.desktop\n' : (() => { throw new Error('x'); })() });
  assert.deepEqual(ordered.map(b => b.name), ['Two', 'Wave Browser'], 'the default browser comes first');
});

test('a start script is followed to the real Chromium program', () => {
  const home = mkdtempSync(join(root, 'script-'));
  const bin = join(home, 'bin'), libexec = join(home, 'libexec'), apps = join(home, 'apps');
  const real = chromiumProgram(libexec, 'surf');
  make(bin, { surf: `#!/bin/sh\nexec ${real} "$@"\n` });
  mkdirSync(apps, { recursive: true });
  writeFileSync(join(apps, 'surf.desktop'), `[Desktop Entry]\nName=Surf\nExec=surf %U\n`);
  const found = discoverBrowsers({}, 'linux', { home, entryDirs: [apps], flatpakDirs: [], pathDirs: [bin], run: () => { throw new Error('no default'); } });
  assert.deepEqual(found.map(b => b.program), [real], 'the wrapper is followed to the Chromium program');
});

test('macOS finds any .app with Chromium framework resources, and rejects Electron and non-Chromium apps', () => {
  const home = mkdtempSync(join(root, 'mac-'));
  const apps = join(home, 'Applications');
  const app = (name, { electron = false, pak = true, exe = name } = {}) => {
    const base = join(apps, `${name}.app`);
    const files = { 'Contents/Info.plist': `<plist><dict><key>CFBundleExecutable</key><string>${exe}</string></dict></plist>`, [`Contents/MacOS/${exe}`]: '#!/bin/sh\n' };
    if (pak) files[`Contents/Frameworks/${name} Framework.framework/Versions/A/Resources/resources.pak`] = '';
    if (electron) files['Contents/Resources/app.asar'] = '';
    make(base, files);
    return base;
  };
  app('Wave', {}); // unknown Chromium browser
  app('Note', { electron: true }); // Electron: rejected
  app('Plain', { pak: false }); // no framework resources: rejected
  const found = discoverBrowsers({}, 'darwin', { home, appDirs: [apps] });
  assert.deepEqual(found.map(b => b.name), ['Wave']);
  assert.equal(found[0].program, join(apps, 'Wave.app/Contents/MacOS/Wave'));
});

test('Windows finds a Chromium browser from the registry and rejects Electron and non-Chromium apps', () => {
  const home = mkdtempSync(join(root, 'win-'));
  const waveDir = join(home, 'Wave', 'Application');
  const waveExe = join(waveDir, 'wave.exe');
  make(join(waveDir, '120.0.1'), { 'resources.pak': '' }); // pak in a version subfolder
  writeFileSync(waveExe, '');
  const noteExe = join(home, 'Note', 'note.exe'); make(join(home, 'Note'), { 'note.exe': '', 'resources.pak': '', 'resources/app.asar': '' });
  const termExe = join(home, 'Term', 'term.exe'); make(join(home, 'Term'), { 'term.exe': '' });
  const base = 'HKLM\\SOFTWARE\\Clients\\StartMenuInternet';
  const run = (cmd, args) => {
    const key = args[1];
    if (args[0] === 'query' && key === base) return `${base}\\Wave\n${base}\\Note\n${base}\\Term\n`;
    if (key === `${base}\\Wave\\shell\\open\\command`) return `    (Default)    REG_SZ    "${waveExe}" -- "%1"\n`;
    if (key === `${base}\\Note\\shell\\open\\command`) return `    (Default)    REG_SZ    "${noteExe}"\n`;
    if (key === `${base}\\Term\\shell\\open\\command`) return `    (Default)    REG_SZ    "${termExe}"\n`;
    return '';
  };
  const found = discoverBrowsers({}, 'win32', { run });
  assert.deepEqual(found.map(b => b.name), ['Wave']);
  assert.equal(found[0].program, waveExe);
});

test('user-data folders are found by their "Local State" file a few levels deep', () => {
  const home = mkdtempSync(join(root, 'data-'));
  make(join(home, '.config/wavebrowser'), { 'Local State': '{}', 'Default/Preferences': '{}' });
  make(join(home, '.var/app/net.imput.helium/config/chromium'), { 'Local State': '{}' });
  make(join(home, '.config/not-a-browser'), { 'something.txt': '' });
  const dirs = chromiumUserDataDirs([join(home, '.config'), join(home, '.var/app')]);
  assert.ok(dirs.includes(join(home, '.config/wavebrowser')));
  assert.ok(dirs.includes(join(home, '.var/app/net.imput.helium/config/chromium')));
  assert.equal(dirs.length, 2);
});
