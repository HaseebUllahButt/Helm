// Find any Chromium-based browser program and its user-data folders by file
// evidence, never by a built-in list of brand names. So a browser Helm has
// never heard of still works, on Linux, macOS and Windows.
//
// What makes a program Chromium: a "resources.pak" or "chrome_100_percent.pak"
// sits beside it (on Windows also in a version subfolder; on macOS inside the
// app's framework). An Electron app has those files too, but also carries
// "resources/app.asar" (macOS: Contents/Resources/app.asar), so it is rejected.
// Firefox-based browsers have none of the pak files, so they never match.
//
// A user-data folder is any folder that holds a "Local State" file.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';

// These call the live node:fs exports so tests can replace them.
const isFile = p => { try { return statSync(p).isFile(); } catch { return false; } };
const listDir = p => { try { return readdirSync(p, { withFileTypes: true }); } catch { return []; } };
const readText = (p, max = 256 * 1024) => { try { return statSync(p).size <= max ? readFileSync(p, 'utf8') : ''; } catch { return ''; } };
const real = p => { try { return realpathSync(p); } catch { return p; } };
const hasAny = (dir, names) => names.some(name => existsSync(join(dir, name)));

const PAK = ['resources.pak', 'chrome_100_percent.pak'];
const ELECTRON = ['resources/app.asar', 'resources/app'];

/**
 * The engine of a program from the files beside it (Linux and the followed
 * target of a start script). 'chromium', 'electron' or null.
 */
function engineBeside(dir) {
  if (hasAny(dir, ELECTRON)) return 'electron';
  if (hasAny(dir, PAK)) return 'chromium';
  return null;
}
const isChromiumProgram = program => !!program && engineBeside(dirname(real(program))) === 'chromium';

// ---------- Linux ----------
// Discover from menu entries (.desktop files), following Exec through start
// scripts, Flatpak and Snap to the real program, then keep the Chromium ones.

function which(name, pathDirs) {
  if (name.includes('/')) return isFile(name) ? name : null;
  return pathDirs.map(dir => join(dir, name)).find(isFile) || null;
}
// Look under a Snap or Flatpak files folder for a program with Chromium resources.
function search(root, depth = 5) {
  const entries = listDir(root);
  if (entries.some(e => PAK.includes(e.name))) {
    const program = entries.find(e => e.isFile() && !e.name.includes('.') && engineBeside(join(root, e.name)) === 'chromium');
    if (program) return join(root, program.name);
  }
  if (depth <= 0) return null;
  for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) { const hit = search(join(root, e.name), depth - 1); if (hit) return hit; }
  return null;
}
// Follow a start script to the first absolute path in it that is Chromium.
function followScript(path) {
  const text = readText(path, 64 * 1024); if (!text.startsWith('#!')) return null;
  for (const [cand] of text.matchAll(/\/[\w@.+-]+(?:\/[\w@.+-]+)+/g)) if (isFile(cand) && engineBeside(dirname(real(cand))) === 'chromium') return cand;
  return null;
}
// Menu entries: each .desktop file once, the first folder wins, as the desktop does.
function desktopEntries(dirs) {
  const seen = new Map();
  for (const dir of dirs) for (const file of listDir(dir)) {
    if (file.name.endsWith('.desktop') && !seen.has(file.name)) seen.set(file.name, { file: file.name, text: readText(join(dir, file.name)) });
  }
  return [...seen.values()];
}
// The program and arguments of the main Exec line, without an env prefix.
function execWords(entryText) {
  const main = entryText.split(/\n(?=\[)/).find(group => group.startsWith('[Desktop Entry]')) || entryText;
  const line = /^Exec=(.*)$/m.exec(main)?.[1]; if (!line) return [];
  const words = line.match(/"[^"]*"|\S+/g)?.map(word => word.replace(/^"|"$/g, '')) || [];
  while (words[0] === 'env' || /^[A-Za-z_]\w*=/.test(words[0] || '')) words.shift();
  return words;
}
const entryName = entry => (/^Name=(.*)$/m.exec(entry.text)?.[1] || entry.file.replace(/\.desktop$/, '')).trim();

function linuxBrowsers({ env, home, run, entryDirs: entryOverride, flatpakDirs: flatpakOverride, pathDirs: pathOverride }) {
  const pathDirs = pathOverride || [...new Set([...(env.PATH || '').split(delimiter).filter(Boolean), '/usr/local/bin', '/usr/bin', '/snap/bin'])];
  const flatpakDirs = flatpakOverride || [join(home, '.local/share/flatpak/app'), '/var/lib/flatpak/app'];
  const entryDirs = entryOverride || [
    join(env.XDG_DATA_HOME || join(home, '.local/share'), 'applications'),
    join(home, '.local/share/flatpak/exports/share/applications'),
    ...(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean).map(dir => join(dir, 'applications')),
    '/var/lib/flatpak/exports/share/applications', '/var/lib/snapd/desktop/applications',
  ];
  const flatpak = id => { for (const dir of flatpakDirs) { const hit = search(join(dir, id, 'current/active/files')); if (hit) return hit; } return null; };
  const fromWords = words => {
    if (!words.length) return null;
    if (/(^|\/)flatpak$/.test(words[0])) { const id = words.find(w => /^[\w-]+(\.[\w-]+){2,}$/.test(w)); return id ? flatpak(id) : null; }
    const program = which(words[0], pathDirs); if (!program) return null;
    if (program.startsWith('/snap/bin/')) return search(join('/snap', program.slice('/snap/bin/'.length), 'current'));
    if (engineBeside(dirname(real(program))) === 'chromium') return program;
    return followScript(real(program));
  };
  const found = new Map();
  for (const entry of desktopEntries(entryDirs)) {
    const program = fromWords(execWords(entry.text));
    if (!isChromiumProgram(program)) continue;
    const key = real(program);
    if (!found.has(key)) found.set(key, { program, name: entryName(entry), entry: entry.file });
  }
  const defaultEntry = linuxDefaultEntry(run);
  // Order: the system default browser first, then the rest by name.
  return [...found.values()].sort((a, b) => (b.entry === defaultEntry) - (a.entry === defaultEntry) || a.name.localeCompare(b.name));
}
function linuxDefaultEntry(run) {
  for (const [command, args] of [['xdg-settings', ['get', 'default-web-browser']], ['xdg-mime', ['query', 'default', 'x-scheme-handler/https']]]) {
    try { const out = run(command, args, { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0].trim(); if (out) return out; } catch { /* not installed */ }
  }
  return null;
}

// ---------- macOS ----------
// Any *.app whose framework holds Chromium resources and that is not Electron.

function frameworkHasPak(frameworks, depth = 4) {
  for (const e of listDir(frameworks)) {
    if (!e.isDirectory()) continue;
    const dir = join(frameworks, e.name);
    if (e.name.endsWith('.framework') && treeHasPak(dir, depth)) return true;
  }
  return false;
}
function treeHasPak(dir, depth) {
  const entries = listDir(dir);
  if (entries.some(e => PAK.includes(e.name))) return true;
  if (depth <= 0) return false;
  for (const e of entries) if (e.isDirectory()) { if (treeHasPak(join(dir, e.name), depth - 1)) return true; }
  return false;
}
// The program is Contents/MacOS/<CFBundleExecutable>; fall back to the one file there.
function macExecutable(app) {
  const plist = readText(join(app, 'Contents/Info.plist'), 256 * 1024);
  const exec = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  const macOS = join(app, 'Contents/MacOS');
  if (exec && isFile(join(macOS, exec))) return join(macOS, exec);
  const files = listDir(macOS).filter(e => e.isFile());
  const fallback = files.find(e => e.name === basename(app).replace(/\.app$/, '')) || files[0];
  return fallback ? join(macOS, fallback.name) : null;
}
function macBrowsers({ home, appDirs }) {
  const dirs = appDirs || ['/Applications', join(home, 'Applications')];
  const found = [];
  const seen = new Set();
  for (const base of dirs) for (const e of listDir(base)) {
    if (!e.name.endsWith('.app') || seen.has(e.name)) continue;
    const app = join(base, e.name);
    if (existsSync(join(app, 'Contents/Resources/app.asar'))) continue; // Electron
    if (!frameworkHasPak(join(app, 'Contents/Frameworks'))) continue;
    const program = macExecutable(app);
    if (program) { seen.add(e.name); found.push({ program, name: e.name.replace(/\.app$/, '') }); }
  }
  // No name-free way to read the macOS default browser, so order by name.
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- Windows ----------
// The StartMenuInternet clients and App Paths give program paths; keep the ones
// with Chromium resources in the program folder or a version subfolder.

function regSubkeys(run, key) {
  try {
    return run('reg', ['query', key], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).map(line => line.trim()).filter(line => line.toUpperCase().startsWith(key.toUpperCase() + '\\')).map(line => line.slice(key.length + 1));
  } catch { return []; }
}
function regDefault(run, key) {
  try {
    const line = run('reg', ['query', key, '/ve'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/).find(l => /\(Default\)/.test(l) && /REG_/.test(l));
    return line ? line.replace(/^.*REG_(SZ|EXPAND_SZ)\s+/, '').trim() : null;
  } catch { return null; }
}
const exeFromCommand = cmd => { if (!cmd) return null; const m = cmd.match(/^"([^"]+\.exe)"|^(\S+\.exe)/i); return m ? (m[1] || m[2]) : null; };
function isChromiumWindows(exe) {
  if (!exe || !isFile(exe)) return false;
  const dir = dirname(exe);
  if (hasAny(dir, ELECTRON)) return false;
  if (hasAny(dir, PAK)) return true;
  // Chrome keeps the pak in a version subfolder beside chrome.exe.
  return listDir(dir).some(e => e.isDirectory() && hasAny(join(dir, e.name), PAK) && !hasAny(join(dir, e.name), ELECTRON));
}
function windowsBrowsers({ run }) {
  const exes = new Map(); // lower-case path -> { exe, name }
  for (const hive of ['HKCU', 'HKLM']) {
    const base = `${hive}\\SOFTWARE\\Clients\\StartMenuInternet`;
    for (const name of regSubkeys(run, base)) {
      const exe = exeFromCommand(regDefault(run, `${base}\\${name}\\shell\\open\\command`));
      if (exe && !exes.has(exe.toLowerCase())) exes.set(exe.toLowerCase(), { exe, name });
    }
    const paths = `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths`;
    for (const key of regSubkeys(run, paths)) {
      if (!/\.exe$/i.test(key)) continue;
      const exe = exeFromCommand(regDefault(run, `${paths}\\${key}`)) || regDefault(run, `${paths}\\${key}`);
      if (exe && !exes.has(exe.toLowerCase())) exes.set(exe.toLowerCase(), { exe, name: key.replace(/\.exe$/i, '') });
    }
  }
  const def = windowsDefault(run);
  const found = [...exes.values()].filter(c => isChromiumWindows(c.exe)).map(c => ({ program: c.exe, name: c.name }));
  // Order: the default browser first, then the rest by name.
  return found.sort((a, b) => (b.program.toLowerCase() === def) - (a.program.toLowerCase() === def) || a.name.localeCompare(b.name));
}
function windowsDefault(run) {
  const progId = regDefault(run, 'HKCU\\SOFTWARE\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice') // some reg builds list ProgId as a named value
    || (() => { try { return run('reg', ['query', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).find(l => /ProgId/i.test(l))?.replace(/^.*REG_SZ\s+/, '').trim() || null; } catch { return null; } })();
  if (!progId) return null;
  const exe = exeFromCommand(regDefault(run, `HKCR\\${progId}\\shell\\open\\command`));
  return exe ? exe.toLowerCase() : null;
}

/**
 * Every installed Chromium-based browser, best first, as { program, name }.
 * `program` is the executable path; `name` is a human name from the menu
 * entry, app bundle or registry. Preference order: the system default browser
 * first (where it can be read without names), then the rest by name.
 */
export function discoverBrowsers(env = process.env, platform = process.platform, { home = homedir(), run = execFileSync, appDirs, entryDirs, flatpakDirs, pathDirs } = {}) {
  if (platform === 'darwin') return macBrowsers({ home, appDirs });
  if (platform === 'win32') return windowsBrowsers({ run });
  return linuxBrowsers({ env, home, run, entryDirs, flatpakDirs, pathDirs });
}

/** The program path of the best installed Chromium-based browser, or undefined. */
export const systemChromium = (env = process.env, platform = process.platform, opts) => discoverBrowsers(env, platform, opts)[0]?.program;

/**
 * Every folder under the given roots (a few levels deep) that holds a
 * "Local State" file, so it is a Chromium user-data folder. Descent skips
 * hidden folders apart from ".config" (Snap keeps browser data below it).
 */
export function chromiumUserDataDirs(roots, depth = 4) {
  const found = [];
  const walk = (dir, left) => {
    const entries = listDir(dir);
    if (entries.some(e => e.name === 'Local State' && e.isFile())) { found.push(dir); return; }
    if (left <= 0) return;
    for (const e of entries) if (e.isDirectory() && (!e.name.startsWith('.') || e.name === '.config')) walk(join(dir, e.name), left - 1);
  };
  for (const root of roots) walk(root, depth);
  return found;
}
