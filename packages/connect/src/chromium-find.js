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

// ---------- Linux ----------
// Discover from menu entries (.desktop files), following Exec through start
// scripts, Flatpak and Snap to the real program, then keep the Chromium ones.

function which(name, pathDirs) {
  if (name.includes('/')) return isFile(name) ? name : null;
  return pathDirs.map(dir => join(dir, name)).find(isFile) || null;
}
// Look under a Snap or Flatpak files folder for the Chromium launcher: a folder
// that holds the pak files (and is not Electron) names its browser; the
// launcher is the extension-less program file in it.
function search(root, depth = 5) {
  const entries = listDir(root);
  if (engineBeside(root) === 'chromium') {
    const program = entries.find(e => e.isFile() && !e.name.includes('.'));
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

function linuxBrowsers({ env, home, run, entryDirs: entryOverride, flatpakDirs: flatpakOverride, pathDirs: pathOverride, snapRoot = '/snap' }) {
  const snapBin = join(snapRoot, 'bin') + '/';
  const pathDirs = pathOverride || [...new Set([...(env.PATH || '').split(delimiter).filter(Boolean), '/usr/local/bin', '/usr/bin', join(snapRoot, 'bin')])];
  const flatpakDirs = flatpakOverride || [join(home, '.local/share/flatpak/app'), '/var/lib/flatpak/app'];
  const entryDirs = entryOverride || [
    join(env.XDG_DATA_HOME || join(home, '.local/share'), 'applications'),
    join(home, '.local/share/flatpak/exports/share/applications'),
    ...(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean).map(dir => join(dir, 'applications')),
    '/var/lib/flatpak/exports/share/applications', '/var/lib/snapd/desktop/applications',
  ];
  // Keep each browser's own package launcher, so a Snap or Flatpak app starts
  // inside its runtime: Snap through its /snap/bin wrapper, Flatpak through
  // `flatpak run <id>`. A plain install runs its own binary with no prefix.
  const flatpakBin = () => which('flatpak', pathDirs) || '/usr/bin/flatpak';
  const flatpak = id => { for (const dir of flatpakDirs) { if (search(join(dir, id, 'current/active/files'))) return { program: flatpakBin(), args: ['run', id] }; } return null; };
  const fromWords = words => {
    if (!words.length) return null;
    if (/(^|\/)flatpak$/.test(words[0])) { const id = words.find(w => /^[\w-]+(\.[\w-]+){2,}$/.test(w)); return id ? flatpak(id) : null; }
    const program = which(words[0], pathDirs); if (!program) return null;
    if (program.startsWith(snapBin)) return search(join(snapRoot, program.slice(snapBin.length), 'current')) ? { program, args: [] } : null;
    if (engineBeside(dirname(real(program))) === 'chromium') return { program, args: [] };
    const target = followScript(real(program));
    return target ? { program: target, args: [] } : null;
  };
  const found = new Map();
  for (const entry of desktopEntries(entryDirs)) {
    const spec = fromWords(execWords(entry.text));
    if (!spec) continue;
    const key = `${real(spec.program)}\0${spec.args.join('\0')}`;
    if (!found.has(key)) found.set(key, { ...spec, name: entryName(entry), entry: entry.file });
  }
  if (!found.size) return [];
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
    // Electron, packed or unpacked: Contents/Resources/app.asar or app.
    if (hasAny(join(app, 'Contents/Resources'), ['app.asar', 'app'])) continue;
    if (!frameworkHasPak(join(app, 'Contents/Frameworks'))) continue;
    const program = macExecutable(app);
    if (program) { seen.add(e.name); found.push({ program, name: e.name.replace(/\.app$/, ''), args: [] }); }
  }
  // No name-free way to read the macOS default browser, so order by name.
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- Windows ----------
// The StartMenuInternet clients and App Paths give program paths; keep the ones
// with Chromium resources in the program folder or a version subfolder.

// `reg query` echoes the full hive name (HKEY_LOCAL_MACHINE), not the short
// form (HKLM) that is accepted as input, so keys are matched by their tail,
// which is the same either way.
const runReg = (run, args) => { try { return run('reg', args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }) || ''; } catch { return ''; } };
// Read a whole registry tree in one call and group each key's values.
function regTree(run, key) {
  const tree = new Map(); let current = null;
  for (const raw of runReg(run, ['query', key, '/s']).split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (!/^\s/.test(raw)) { current = raw.trim(); if (!tree.has(current)) tree.set(current, new Map()); continue; }
    const m = /^\s+(.*?)\s{2,}REG_\w+\s{2,}(.*)$/.exec(raw);
    if (m && current) tree.get(current).set(m[1] === '(Default)' ? '' : m[1], m[2].trim());
  }
  return tree;
}
const regDefault = (run, key) => { const line = runReg(run, ['query', key, '/ve']).split(/\r?\n/).find(l => /\(Default\)/.test(l) && /REG_/.test(l)); return line ? line.replace(/^.*REG_(?:SZ|EXPAND_SZ)\s{2,}/, '').trim() : null; };
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
    // One recursive read per base, instead of a query for every subkey.
    const clients = regTree(run, `${hive}\\SOFTWARE\\Clients\\StartMenuInternet`);
    for (const [key, values] of clients) {
      const m = /\\StartMenuInternet\\([^\\]+)\\shell\\open\\command$/i.exec(key);
      const exe = m && exeFromCommand(values.get(''));
      if (exe && !exes.has(exe.toLowerCase())) exes.set(exe.toLowerCase(), { exe, name: m[1] });
    }
    const appPaths = regTree(run, `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths`);
    for (const [key, values] of appPaths) {
      const m = /\\App Paths\\([^\\]+\.exe)$/i.exec(key); if (!m) continue;
      const exe = exeFromCommand(values.get('')) || values.get('');
      if (exe && !exes.has(exe.toLowerCase())) exes.set(exe.toLowerCase(), { exe, name: m[1].replace(/\.exe$/i, '') });
    }
  }
  const def = windowsDefault(run);
  const found = [...exes.values()].filter(c => isChromiumWindows(c.exe)).map(c => ({ program: c.exe, name: c.name, args: [] }));
  // Order: the default browser first, then the rest by name.
  return found.sort((a, b) => (b.program.toLowerCase() === def) - (a.program.toLowerCase() === def) || a.name.localeCompare(b.name));
}
function windowsDefault(run) {
  const userChoice = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice';
  const line = runReg(run, ['query', userChoice, '/v', 'ProgId']).split(/\r?\n/).find(l => /\sProgId\s{2,}REG_/i.test(l));
  const progId = line ? line.replace(/^.*ProgId\s{2,}REG_\w+\s{2,}/i, '').trim() : null;
  if (!progId) return null;
  const exe = exeFromCommand(regDefault(run, `HKCR\\${progId}\\shell\\open\\command`));
  return exe ? exe.toLowerCase() : null;
}

/**
 * Every installed Chromium-based browser, best first, as { program, name,
 * args }. `program` is the executable to start; `args` are the fixed leading
 * arguments its package launcher needs (empty for a plain install, `run <id>`
 * for Flatpak). `name` is a human name from the menu entry, app bundle or
 * registry. Preference order: the system default browser first (where it can
 * be read without names), then the rest by name.
 */
function discoverUncached(env, platform, { home = homedir(), run = execFileSync, appDirs, entryDirs, flatpakDirs, pathDirs, snapRoot } = {}) {
  if (platform === 'darwin') return macBrowsers({ home, appDirs });
  if (platform === 'win32') return windowsBrowsers({ run });
  return linuxBrowsers({ env, home, run, entryDirs, flatpakDirs, pathDirs, snapRoot });
}
// A short cache for the default case, so repeated readiness checks during chat
// setup do not rescan the disk (and re-run the xdg commands) each time.
let cached = null;
export function discoverBrowsers(env = process.env, platform = process.platform, opts) {
  if (opts || env !== process.env || platform !== process.platform) return discoverUncached(env, platform, opts);
  if (cached && Date.now() - cached.at < 5000) return cached.result;
  const result = discoverUncached(env, platform, {});
  cached = { at: Date.now(), result };
  return result;
}
/** Drop the cache, so the next call rescans (use after a browser is installed). */
export const refreshBrowsers = () => { cached = null; };

/**
 * The program path of the best installed Chromium-based browser, or undefined.
 * Browsers that need launcher arguments (Flatpak) are skipped here, because a
 * plain executable path cannot carry them; `launchTarget` keeps them.
 */
export const systemChromium = (env = process.env, platform = process.platform, opts) => discoverBrowsers(env, platform, opts).find(b => !b.args?.length)?.program;

/** How to start the best browser: { command, args } with any launcher prefix. */
export function launchTarget(env = process.env, platform = process.platform, opts) {
  const best = discoverBrowsers(env, platform, opts)[0];
  return best ? { command: best.program, args: best.args || [] } : null;
}

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
