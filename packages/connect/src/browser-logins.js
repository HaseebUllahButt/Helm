import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { execFile as exec } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { readFile, lstat, mkdtemp, chmod, writeFile, rm } from 'node:fs/promises';

const execFile = promisify(exec);
const BROWSERS = [
  ['chromium', 'Chromium', 'chromium', 'Chromium', 'Chromium', 'chromium'],
  ['chrome', 'Chrome', 'google-chrome', 'Google/Chrome', 'Google/Chrome/User Data', 'chrome'],
  ['chrome-beta', 'Chrome Beta', 'google-chrome-beta', 'Google/Chrome Beta', 'Google/Chrome Beta/User Data', 'chrome'],
  ['chrome-unstable', 'Chrome Dev', 'google-chrome-unstable', 'Google/Chrome Dev', 'Google/Chrome Dev/User Data', 'chrome'],
  ['brave', 'Brave', 'BraveSoftware/Brave-Browser', 'BraveSoftware/Brave-Browser', 'BraveSoftware/Brave-Browser/User Data', 'brave'],
  ['edge', 'Edge', 'microsoft-edge', 'Microsoft Edge', 'Microsoft/Edge/User Data', 'microsoft-edge'],
  ['edge-dev', 'Edge Dev', 'microsoft-edge-dev', 'Microsoft Edge Dev', 'Microsoft/Edge Dev/User Data', 'microsoft-edge'],
  ['vivaldi', 'Vivaldi', 'vivaldi', 'Vivaldi', 'Vivaldi/User Data', 'vivaldi'],
];
const label = p => `${p.browserName}: ${p.name} (${p.directory})`;
const validDirectory = name => typeof name === 'string' && name !== '.' && name !== '..' && !/[\\/\x00-\x1f]/.test(name) && name.length <= 200;
const unixTime = value => Number(value) / 1000000 - 11644473600;
const key = (password, platform) => pbkdf2Sync(password, 'saltysalt', platform === 'darwin' ? 1003 : 1, 16, 'sha1');

// Refuse symlinks anywhere below the browser config root, including cookie databases.
async function privatePath(root, path) {
  const rel = relative(root, path); if (!rel || rel.startsWith(`..${sep}`) || rel === '..') throw new Error('unsafe browser profile path');
  let current = root;
  if ((await lstat(current)).isSymbolicLink()) throw new Error('browser config symlinks are not supported');
  for (const part of rel.split(sep)) { current = join(current, part); if ((await lstat(current)).isSymbolicLink()) throw new Error('browser profile symlinks are not supported'); }
  return path;
}

export function createLoginReader({ home = homedir(), platform = process.platform, configHome = process.env.XDG_CONFIG_HOME || join(home, '.config'), localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), run = execFile, now = Date.now } = {}) {
  const root = platform === 'darwin' ? join(home, 'Library', 'Application Support') : platform === 'win32' ? localAppData : configHome;
  const cache = new Map();
  const source = p => join(root, BROWSERS.find(b => b[0] === p.browser)[platform === 'darwin' ? 3 : platform === 'win32' ? 4 : 2]);
  async function passwordStore(browser) {
    const brand = BROWSERS.find(b => b[0] === browser)[5];
    for (const file of [`${browser}-flags.conf`, `${brand}-flags.conf`]) {
      try { const contents = await readFile(await privatePath(root, join(root, file)), 'utf8'); const match = /(?:^|\s)--password-store=([\w-]+)/m.exec(contents.replace(/^\s*#.*$/gm, '')); if (match) return match[1]; } catch {}
    }
    return 'auto';
  }
  async function listProfiles() {
    const profiles = [];
    for (const [browser, browserName] of BROWSERS) {
      try {
        const state = JSON.parse(await readFile(await privatePath(root, join(source({ browser }), 'Local State')), 'utf8')).profile || {};
        for (const [directory, info] of Object.entries(state.info_cache || {})) {
          if (!validDirectory(directory)) continue;
          const path = await privatePath(root, join(source({ browser }), directory)); if (!(await lstat(path)).isDirectory()) continue;
          profiles.push({ key: `${browser}:${directory}`, browser, browserName, directory, name: String(info.name || directory), lastUsed: directory === state.last_used, passwordStore: platform === 'linux' ? await passwordStore(browser) : platform === 'darwin' ? 'keychain' : 'app-bound', readable: platform !== 'win32', ...(platform === 'win32' ? { reason: 'Windows browser logins use app-bound encryption and cannot be copied here.' } : {}) });
        }
      } catch { /* browser absent or unsafe */ }
    }
    return profiles;
  }
  async function resolveProfile(wanted) {
    const choices = await listProfiles(); const value = typeof wanted === 'object' ? wanted?.key : wanted;
    if (typeof value !== 'string' || value.length > 400) throw new Error('choose a browser profile');
    const lower = value.toLowerCase(), colon = lower.indexOf(':');
    const matches = choices.filter(p => p.key.toLowerCase() === lower || ((colon < 0 || p.browser === lower.slice(0, colon)) && [p.directory, p.name].some(v => v.toLowerCase() === (colon < 0 ? lower : lower.slice(colon + 1)))));
    if (matches.length !== 1) throw new Error(`Profile ${matches.length ? 'is ambiguous' : 'was not found'}. Available: ${choices.map(label).join('; ') || 'none'}`);
    return matches[0];
  }
  async function secret(profile) {
    const brand = BROWSERS.find(b => b[0] === profile.browser)[5];
    const title = { chrome: 'Chrome', chromium: 'Chromium', brave: 'Brave', 'microsoft-edge': 'Microsoft Edge', vivaldi: 'Vivaldi' }[brand];
    const lookup = async (command, args) => {
      try { const { stdout } = await run(command, args, { timeout: 2500, maxBuffer: 65536, windowsHide: true }); return stdout.replace(/\r?\n$/, '') || null; } catch { return null; }
    };
    if (platform === 'darwin') return lookup('security', ['find-generic-password', '-w', '-s', `${title} Safe Storage`]);
    if (profile.passwordStore === 'basic') return null;
    if (profile.passwordStore === 'auto' || /gnome|libsecret/.test(profile.passwordStore)) {
      // Chromium's v2 schema stores one key per application's branding.
      for (const args of [['application', brand, 'xdg:schema', 'chrome_libsecret_os_crypt_password_v2'], ['application', brand]]) {
        const value = await lookup('secret-tool', ['lookup', ...args]); if (value) return value;
      }
    }
    if (profile.passwordStore === 'auto' || /kwallet/.test(profile.passwordStore)) {
      for (const wallet of ['kdewallet', 'default']) { const value = await lookup('kwallet-query', ['-r', `${title} Safe Storage`, '-f', `${title} Keys`, wallet]); if (value) return value; }
    }
    return null;
  }
  async function readLogins(wanted, { refresh = false } = {}) {
    const profile = await resolveProfile(wanted);
    if (!profile.readable) throw new Error(profile.reason);
    const previous = cache.get(profile.key);
    if (!refresh && previous && now() - previous.at < 10 * 60000) {
      const result = structuredClone(previous.result); result.cookies = result.cookies.filter(c => c.expires === -1 || c.expires > now() / 1000);
      result.sites = new Set(result.cookies.map(c => c.domain.replace(/^\./, ''))).size; return result;
    }
    let dbPath;
    for (const file of ['Network/Cookies', 'Cookies']) {
      try { dbPath = await privatePath(root, join(source(profile), profile.directory, file)); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!dbPath) throw new Error('This profile has no saved cookies yet.');
    // Check auxiliary files too: SQLite can otherwise follow a WAL or journal symlink.
    for (const suffix of ['-wal', '-shm', '-journal']) { try { await privatePath(root, dbPath + suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    let sqlite; try { sqlite = await import('node:sqlite'); } catch { throw new Error('Copying browser logins needs Node with node:sqlite (Node 22.16 or newer).'); }
    const folder = await mkdtemp(join(tmpdir(), 'helm-logins-')); await chmod(folder, 0o700);
    let original, copy;
    try {
      const file = join(folder, 'Cookies'); await writeFile(file, '', { mode: 0o600 });
      // VACUUM INTO reads one consistent snapshot, live WAL entries included,
      // into the empty private file. Not sqlite.backup(): Node resolves it only
      // when something else wakes the event loop, so a 1 ms copy waited for the
      // next unrelated timer - 30 s in a test, and as long in a quiet daemon.
      original = new sqlite.DatabaseSync(dbPath, { readOnly: true });
      original.prepare('VACUUM INTO ?').run(file); original.close(); original = null;
      copy = new sqlite.DatabaseSync(file, { readOnly: true });
      const version = Number(copy.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value || 0);
      const partitioned = copy.prepare('PRAGMA table_info(cookies)').all().some(c => c.name === 'top_frame_site_key');
      const query = copy.prepare(`SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, has_expires${partitioned ? ', top_frame_site_key' : ''} FROM cookies`); query.setReadBigInts(true); const rows = query.all();
      const needsSecret = rows.some(r => Buffer.from(r.encrypted_value || []).subarray(0, 3).toString() === (platform === 'darwin' ? 'v10' : 'v11'));
      const password = needsSecret ? await secret(profile) : null;
      const cookies = []; let failed = 0;
      for (const row of rows) {
        const expires = row.has_expires ? unixTime(row.expires_utc) : -1;
        if (expires !== -1 && expires <= now() / 1000) continue;
        try {
          let value = row.value; const encrypted = Buffer.from(row.encrypted_value || []);
          if (encrypted.length) {
            const prefix = encrypted.subarray(0, 3).toString();
            if (!['v10', 'v11'].includes(prefix) || (prefix === 'v11' && platform !== 'linux')) throw new Error('unsupported cookie encryption');
            const pass = platform === 'darwin' || prefix === 'v11' ? password : 'peanuts'; if (pass == null) throw new Error('key unavailable');
            const decipher = createDecipheriv('aes-128-cbc', key(pass, platform), Buffer.alloc(16, ' '));
            let plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
            if (version >= 24) { const hash = createHash('sha256').update(row.host_key).digest(); if (plain.length < 32 || !plain.subarray(0, 32).equals(hash)) throw new Error('wrong cookie key'); plain = plain.subarray(32); }
            value = new TextDecoder('utf-8', { fatal: true }).decode(plain);
          }
          if (!row.host_key || !row.path?.startsWith('/') || /[\x00-\x1f\x7f]/.test(value || '')) throw new Error('invalid cookie');
          if (row.top_frame_site_key && !/^https?:\/\//.test(row.top_frame_site_key)) throw new Error('unsupported cookie partition');
          cookies.push({ ...(row.top_frame_site_key ? { partitionKey: row.top_frame_site_key } : {}), name: row.name, value: value || '', domain: row.host_key, path: row.path, expires, httpOnly: !!row.is_httponly, secure: !!row.is_secure, sameSite: Number(row.samesite) === 0 ? 'None' : Number(row.samesite) === 2 ? 'Strict' : 'Lax' });
        } catch { failed++; }
      }
      const result = { cookies, sites: new Set(cookies.map(c => c.domain.replace(/^\./, ''))).size, failed, profile: label(profile), warnings: failed ? [password == null && needsSecret ? `${profile.passwordStore} key unavailable (keyring may be locked, missing, or use another store).` : 'Some cookies use unsupported encryption or could not be read.'] : [] };
      const entry = { at: now(), result }; cache.set(profile.key, entry); const timer = setTimeout(() => { if (cache.get(profile.key) === entry) cache.delete(profile.key); }, 10 * 60000); timer.unref?.();
      return structuredClone(result);
    } catch (error) {
      if (error.message.startsWith('browser ')) throw error;
      throw new Error('Could not read this profile’s cookie database. Close the browser and try again.');
    } finally { try { original?.close(); } finally { try { copy?.close(); } finally { await rm(folder, { recursive: true, force: true }); } } }
  }
  return { listProfiles, resolveProfile, readLogins };
}
const reader = createLoginReader();
export const listProfiles = reader.listProfiles;
export const resolveProfile = reader.resolveProfile;
export const readLogins = reader.readLogins;
