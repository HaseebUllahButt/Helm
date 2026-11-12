// Extended mode: Helm's agents use the owner's own browser through Helm's
// add-on, with the owner's real logins, instead of Helm's own window.
//
// The add-on ships with Helm and is copied to ~/.helm/browser/extension.
// Helm sets it up itself where the browser allows it: a browser started
// through a launcher with a flags file (Arch Chromium, Brave, Helium) loads
// the folder on every start once it is named there. The Helm service names it
// at each start. Google Chrome and Edge ignore that flag, so there the owner
// adds the folder once by hand.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, unlinkSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionIdFromKey } from './browser-relay.js';

export const EXTENSION_SOURCE = fileURLToPath(new URL('../browser-extension/', import.meta.url));
const FILES = ['manifest.json', 'background.js'];
export const EXTENSION_ID = extensionIdFromKey(JSON.parse(readFileSync(join(EXTENSION_SOURCE, 'manifest.json'), 'utf8')).key);
export const extensionFolder = directory => join(directory, 'extension');
export const linkFile = directory => join(extensionFolder(directory), 'helm-link.json');

/**
 * Copy the add-on into Helm's folder. True when an older copy changed, so a
 * browser that loaded it must reload it. A first copy needs no reload.
 */
export function syncExtension(directory) {
  const folder = extensionFolder(directory); mkdirSync(folder, { recursive: true, mode: 0o700 });
  let changed = false;
  for (const name of FILES) {
    const body = readFileSync(join(EXTENSION_SOURCE, name));
    let old = null; try { old = readFileSync(join(folder, name)); } catch { /* new */ }
    if (!old || !old.equals(body)) { writeFileSync(join(folder, name), body); if (old) changed = true; }
  }
  return changed;
}

export const MODES = ['window', 'extended'];
/**
 * Extended mode is the default: agents use the owner's own browser. Only a
 * choice the owner saved with `helm browser mode` (version 2) counts. An
 * earlier file without a version came from a test of the first add-on.
 */
export function readMode(directory) {
  try { const { mode, v } = JSON.parse(readFileSync(join(directory, 'mode.json'), 'utf8')); return v === 2 && MODES.includes(mode) ? mode : 'extended'; } catch { return 'extended'; }
}
export function writeMode(directory, mode) {
  if (!MODES.includes(mode)) throw new Error(`choose a browser mode: ${MODES.join(' or ')}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, 'mode.json'), JSON.stringify({ ...readChoice(directory), mode, v: 2 }), { mode: 0o600 });
}

export function readChoice(directory) {
  try { const value = JSON.parse(readFileSync(join(directory, 'mode.json'), 'utf8')); return value.v === 2 ? value : {}; } catch { return {}; }
}
export function writeMain(directory, main, extensionMain = main) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, 'mode.json'), JSON.stringify({ ...readChoice(directory), mode: readMode(directory), main, extensionMain, v: 2 }), { mode: 0o600 });
}
// These vendors removed command-line loading. Other Chromium browsers keep it.
export const manualBrowser = browser => /^(?:google[ -]?)?chrome(?:[ -].*)?$|^(?:microsoft[ -]?)?edge(?:[ -].*)?$|^msedge$/i.test(browser?.name || '')
  || /google-chrome|[/\\]google[/\\]chrome[/\\]|msedge(?:\.exe)?$/i.test(browser?.program || '');
export function extensionArgs(folder, manual = false, launcher, args = [], env = process.env) {
  if (!folder || manual) return args;
  let flags = ''; try { flags = readFileSync(flagsFile(launcher, env), 'utf8'); } catch { /* no flags file */ }
  const list = [...flags.matchAll(/^\s*--load-extension=(.*)$/gm)].flatMap(m => m[1].trim().split(','));
  const kept = args.filter(arg => { if (!arg.startsWith('--load-extension=')) return true; list.push(...arg.slice(17).split(',')); return false; });
  return [...kept, `--load-extension=${[...new Set([...list, folder].filter(Boolean))].join(',')}`, QUIET_FLAG];
}

// A user menu entry overrides the package entry. Save the exact original so
// removal can restore it. If the owner edits it, remove only Helm's flags.
const MENU_NOTE = '# Helm browser entry: ';
function menuExec(text, folder, add) {
  return text.replace(/^Exec=(.*)$/gm, (_, command) => {
    let value = command.replace(/(?:"--load-extension=([^"\n]*)"|--load-extension=([^\s"\n]+))/g, (flag, quoted, plain) => {
      const list = (quoted ?? plain).split(',').filter(p => p !== folder);
      if (add) list.push(folder);
      return list.length ? `"--load-extension=${list.join(',')}"` : '';
    });
    if (add && !value.includes('--load-extension=')) value += ` "--load-extension=${folder}"`;
    if (add && !value.includes(QUIET_FLAG)) value += ` ${QUIET_FLAG}`;
    return `Exec=${value}`;
  });
}
export function setDesktop(browser, folder, add = true, env = process.env, platform = process.platform) {
  if (platform !== 'linux' || !browser?.desktopFile || manualBrowser(browser)) return null;
  const target = join(env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local/share'), 'applications', basename(browser.desktopFile));
  let text; try { text = readFileSync(target, 'utf8'); } catch { if (!add) return null; text = readFileSync(browser.desktopFile, 'utf8'); }
  const marker = text.split('\n').find(line => line.startsWith(MENU_NOTE));
  if (add) {
    if (marker) return target;
    const record = { original: text, created: !existsSync(target) };
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, MENU_NOTE + Buffer.from(JSON.stringify(record)).toString('base64') + '\n' + menuExec(text, folder, true));
  } else if (marker) {
    const record = JSON.parse(Buffer.from(marker.slice(MENU_NOTE.length), 'base64').toString());
    const body = text.replace(marker + '\n', '');
    if (body === menuExec(record.original, folder, true)) {
      if (record.created) unlinkSync(target); else writeFileSync(target, record.original);
    } else {
      const cleaned = menuExec(body, folder, false).split('\n').map((line, i) => {
        const original = record.original.split('\n')[i] || '';
        return line.startsWith('Exec=') && !original.includes(QUIET_FLAG) ? line.replace(` ${QUIET_FLAG}`, '') : line;
      }).join('\n');
      writeFileSync(target, cleaned);
    }
  }
  return target;
}
export function setBrowserExtension(browser, folder, add = true) {
  if (!browser || manualBrowser(browser)) return null;
  return setFlags(browser.launcher || browser.program, folder, add) || setDesktop(browser, folder, add);
}

// ---------- The browser's flags file ----------
const configHome = (env = process.env) => env.XDG_CONFIG_HOME || join(homedir(), '.config');
/** The flags file a launcher reads, found by the name inside it ("chromium-flags.conf"), or null. */
export function flagsFile(launcher, env = process.env) {
  if (!launcher) return null;
  let text; try { if (statSync(launcher).size > 4 * 1024 * 1024) return null; text = readFileSync(launcher).toString('latin1'); } catch { return null; }
  const name = /([\w.+-]+-flags\.conf)/.exec(text)?.[1];
  return name ? join(configHome(env), name) : null;
}
/** The flags text with Helm's folder added to (or removed from) its add-on list; other add-ons stay. */
export function withExtension(text, folder, add = true) {
  const lines = text ? text.split('\n') : [];
  const at = lines.findIndex(line => /^\s*--load-extension=/.test(line));
  const list = at < 0 ? [] : lines[at].trim().slice('--load-extension='.length).split(',').filter(Boolean);
  const kept = list.filter(path => path !== folder);
  const next = add ? [...kept, folder] : kept;
  if (at >= 0) { if (next.length) lines[at] = `--load-extension=${next.join(',')}`; else lines.splice(at, 1); }
  else if (add) { if (lines.length && lines.at(-1) === '') lines.splice(-1, 0, `--load-extension=${folder}`); else lines.push(`--load-extension=${folder}`); }
  const out = lines.join('\n');
  return out && !out.endsWith('\n') ? `${out}\n` : out;
}
/**
 * Chromium shows a bar on every tab ("Helm started debugging this browser")
 * while the add-on drives a tab. This flag hides it. Helm marks its own line,
 * so the way back takes out only what Helm added.
 */
export const QUIET_FLAG = '--silent-debugger-extension-api';
const QUIET_NOTE = '# Added by Helm: no debugging bar while agents work in your browser.';
export function withQuiet(text, add = true) {
  const lines = text ? text.split('\n') : [];
  const at = lines.indexOf(QUIET_NOTE);
  if (!add) {
    if (at >= 0 && lines[at + 1]?.trim() === QUIET_FLAG) lines.splice(at, 2);
    else if (at >= 0) lines.splice(at, 1);
    return lines.join('\n');
  }
  if (lines.some(line => line.trim() === QUIET_FLAG)) return text;
  const end = lines.length && lines.at(-1) === '' ? lines.length - 1 : lines.length;
  lines.splice(end, 0, QUIET_NOTE, QUIET_FLAG);
  const out = lines.join('\n');
  return out.endsWith('\n') ? out : `${out}\n`;
}
/** Name Helm's add-on in the flags file (add) or take it out. Returns the file, or null when the browser has none. */
export function setFlags(launcher, folder, add = true, env = process.env) {
  const file = flagsFile(launcher, env); if (!file) return null;
  let text = ''; try { text = readFileSync(file, 'utf8'); } catch { if (!add) return file; }
  const next = withQuiet(withExtension(text, folder, add), add);
  if (next !== text) { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, next); }
  return file;
}

// ---------- The owner's running browser ----------
const real = path => { try { return realpathSync(path); } catch { return path; } };
/**
 * True for the main process of the owner's browser: not a helper process
 * (--type=) and not a browser with its own profile folder (Helm's window, the
 * Helm app window, tests). Chromium rewrites its command line as one line
 * with spaces, so the flags are found after a space or a NUL.
 */
export const ownBrowserCommand = text => !/(^|[\0\s"])--(type|user-data-dir)(?:=|[\0\s"])/.test(text);
/**
 * The main process of the owner's own browser: the program runs with no
 * other profile folder named (Helm's window and tests name their own).
 */
export function ownBrowserPids(program, { platform = process.platform, run = execFileSync } = {}) {
  if (!program) return [];
  if (platform !== 'linux') {
    try {
      if (platform === 'darwin') {
        const text = run('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 5000 });
        return text.split('\n').flatMap(line => {
          const match = /^\s*(\d+)\s+(.*)$/.exec(line);
          return match && match[2].startsWith(program) && ownBrowserCommand(match[2]) ? [Number(match[1])] : [];
        });
      }
      const text = run('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', timeout: 5000 });
      const rows = JSON.parse(text);
      return (Array.isArray(rows) ? rows : [rows]).filter(row => row.ExecutablePath?.toLowerCase() === program.toLowerCase() && ownBrowserCommand(row.CommandLine || '')).map(row => row.ProcessId);
    } catch { return []; }
  }
  const want = real(program), found = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let exe; try { exe = readlinkSync(`/proc/${name}/exe`); } catch { continue; }
    if (exe !== want) continue;
    let text; try { text = readFileSync(`/proc/${name}/cmdline`, 'utf8'); } catch { continue; }
    if (ownBrowserCommand(text)) found.push(Number(name));
  }
  return found;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
/**
 * Close the owner's browser and open it again with its last tabs, so it
 * loads the add-on named in its flags file. Only when the owner agreed.
 */
/**
 * Start the owner's closed browser with no window, so the add-on connects
 * and agents work in the owner's real profile, not in a copy. The first
 * agent tab opens a background window there.
 */
export function startOwnBrowser({ program, launcher, processProgram, args = [], folder, manual = false, env = process.env, screen = {} }) {
  const command = launcher || program; if (!command) return false;
  const scoped = process.platform === 'linux' && !env.HELM_NO_SERVICE && ['/usr/bin/systemd-run', '/bin/systemd-run'].find(existsSync);
  const [file, list] = scoped ? [scoped, ['--user', '--scope', '--collect', '--quiet', command, ...extensionArgs(folder, manual, command, args, env), '--no-startup-window']] : [command, [...extensionArgs(folder, manual, command, args, env), '--no-startup-window']];
  try { const child = spawn(file, list, { detached: true, stdio: 'ignore', env: { ...env, ...screen } }); child.on('error', () => {}); child.unref(); return true; } catch { return false; }
}

export async function restartOwnBrowser({ program, launcher, processProgram, args = [], folder, manual = false, env = process.env, screen = {} }) {
  const pids = ownBrowserPids(processProgram || program);
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  for (const until = Date.now() + 15000; Date.now() < until && pids.some(alive);) await new Promise(done => setTimeout(done, 100));
  if (pids.some(alive)) throw new Error('Your browser did not close. Close it yourself, then open it again.');
  const command = launcher || program; args = [...extensionArgs(folder, manual, command, args, env), '--restore-last-session'];
  const scoped = process.platform === 'linux' && !env.HELM_NO_SERVICE && ['/usr/bin/systemd-run', '/bin/systemd-run'].find(existsSync);
  const [file, list] = scoped ? [scoped, ['--user', '--scope', '--collect', '--quiet', command, ...args]] : [command, args];
  const child = spawn(file, list, { detached: true, stdio: 'ignore', env: { ...env, ...screen } });
  child.on('error', () => {}); child.unref();
  return { closed: pids.length };
}

/**
 * Open the add-ons page in the owner's browser, for the one step Google
 * Chrome and Edge leave to the owner. Only when the owner asked.
 */
export function openExtensionsPage({ program, launcher, processProgram, args = [], folder, manual = false, env = process.env, screen = {} }) {
  const command = launcher || program; if (!command) return false;
  const scoped = process.platform === 'linux' && !env.HELM_NO_SERVICE && ['/usr/bin/systemd-run', '/bin/systemd-run'].find(existsSync);
  const [file, list] = scoped ? [scoped, ['--user', '--scope', '--collect', '--quiet', command, ...args, 'chrome://extensions']] : [command, [...args, 'chrome://extensions']];
  try { const child = spawn(file, list, { detached: true, stdio: 'ignore', env: { ...env, ...screen } }); child.on('error', () => {}); child.unref(); return true; } catch { return false; }
}

/** Put text on the owner's clipboard, so they paste the add-on's folder. True when it worked. */
export async function copyText(text, { env = process.env, platform = process.platform } = {}) {
  const tools = platform === 'darwin' ? [['pbcopy', []]] : platform === 'win32' ? [['clip', []]]
    : [...(env.WAYLAND_DISPLAY ? [['wl-copy', []]] : []), ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [tool, args] of tools) {
    const ok = await new Promise(resolve => {
      let child; try { child = spawn(tool, args, { stdio: ['pipe', 'ignore', 'ignore'], env }); } catch { resolve(false); return; }
      child.on('error', () => resolve(false));
      // wl-copy stays to serve the clipboard: written is enough.
      child.stdin.end(text, () => setTimeout(() => resolve(child.exitCode == null || child.exitCode === 0), 300));
    });
    if (ok) return true;
  }
  return false;
}

/** The keys that paste a folder into the browser's folder picker. */
const pasteStep = (platform = process.platform) => platform === 'darwin' ? 'Press Cmd+Shift+G, then Cmd+V and Return.'
  : platform === 'win32' ? 'Click the Folder box, press Ctrl+V, then click Select Folder.' : 'Press Ctrl+L, then Ctrl+V and Enter.';
/** The owner's one step, after Helm opened the add-ons page and copied the folder. */
export const pasteSteps = (platform = process.platform) => [
  'Turn on Developer mode (top right).',
  'Click Load unpacked.',
  pasteStep(platform),
];

/** What the owner does by hand where the browser ignores flags files. */
export const manualSteps = folder => [
  'Open chrome://extensions in your browser.',
  'Turn on Developer mode (top right).',
  `Click Load unpacked, then choose this folder: ${folder}`,
];
