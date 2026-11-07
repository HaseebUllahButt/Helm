// Extended mode: Helm's agents use the owner's own browser through Helm's
// add-on, with the owner's real logins, instead of Helm's own window.
//
// The add-on ships with Helm and is copied to ~/.helm/browser/extension.
// An agent sets it up itself where the browser allows it: a browser started
// through a launcher with a flags file (Arch Chromium, Brave, Helium) loads
// the folder on every start once it is named there. Google Chrome and Edge
// ignore that flag, so there the owner adds the folder once by hand.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
export function readMode(directory) {
  try { const { mode } = JSON.parse(readFileSync(join(directory, 'mode.json'), 'utf8')); return MODES.includes(mode) ? mode : 'window'; } catch { return 'window'; }
}
export function writeMode(directory, mode) {
  if (!MODES.includes(mode)) throw new Error(`choose a browser mode: ${MODES.join(' or ')}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, 'mode.json'), JSON.stringify({ mode }), { mode: 0o600 });
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
/** Name Helm's add-on in the flags file (add) or take it out. Returns the file, or null when the browser has none. */
export function setFlags(launcher, folder, add = true, env = process.env) {
  const file = flagsFile(launcher, env); if (!file) return null;
  let text = ''; try { text = readFileSync(file, 'utf8'); } catch { if (!add) return file; }
  const next = withExtension(text, folder, add);
  if (next !== text) { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, next); }
  return file;
}

// ---------- The owner's running browser ----------
const real = path => { try { return realpathSync(path); } catch { return path; } };
/**
 * The main process of the owner's own browser: the program runs with no
 * other profile folder named (Helm's window and tests name their own).
 */
export function ownBrowserPids(program) {
  if (process.platform !== 'linux' || !program) return [];
  const want = real(program), found = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let exe; try { exe = readlinkSync(`/proc/${name}/exe`); } catch { continue; }
    if (exe !== want) continue;
    let args; try { args = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0'); } catch { continue; }
    if (args.some(arg => arg.startsWith('--type=') || arg.startsWith('--user-data-dir='))) continue;
    found.push(Number(name));
  }
  return found;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
/**
 * Close the owner's browser and open it again with its last tabs, so it
 * loads the add-on named in its flags file. Only when the owner agreed.
 */
export async function restartOwnBrowser({ program, launcher, env = process.env, screen = {} }) {
  const pids = ownBrowserPids(program);
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  for (const until = Date.now() + 15000; Date.now() < until && pids.some(alive);) await new Promise(done => setTimeout(done, 100));
  if (pids.some(alive)) throw new Error('Your browser did not close. Close it yourself, then open it again.');
  const command = launcher || program, args = ['--restore-last-session'];
  const scoped = !env.HELM_NO_SERVICE && ['/usr/bin/systemd-run', '/bin/systemd-run'].find(existsSync);
  const [file, list] = scoped ? [scoped, ['--user', '--scope', '--collect', '--quiet', command, ...args]] : [command, args];
  const child = spawn(file, list, { detached: true, stdio: 'ignore', env: { ...env, ...screen } });
  child.on('error', () => {}); child.unref();
  return { closed: pids.length };
}

/** What the owner does by hand where the browser ignores flags files. */
export const manualSteps = folder => [
  'Open chrome://extensions in your browser.',
  'Turn on Developer mode (top right).',
  `Click Load unpacked, then choose this folder: ${folder}`,
];
