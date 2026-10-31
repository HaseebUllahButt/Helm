import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { execFile as exec } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { readFile, lstat, mkdtemp, chmod, writeFile, rm } from 'node:fs/promises';
import { chromiumUserDataDirs } from './chromium-find.js';

const execFile = promisify(exec);
const label = p => `${p.browserName}: ${p.name} (${p.directory})`;
const plain = value => String(value).toLowerCase().replace(/\s+/g, ' ').trim();
// Folder parts that name no browser, so the next part names it.
const GENERIC = new Set(['user data', 'config', 'common', 'default']);
// A browser's name and slug from one folder part: a reverse-DNS app id keeps
// its last label ("net.imput.helium" -> "Helium"); separators become spaces;
// "Software" and "Browser" drop ("Brave-Browser" -> "Brave").
function cleanLabel(part) {
  const seg = /^[\w-]+(\.[\w-]+){2,}$/.test(part) ? part.split('.').pop() : part;
  const words = seg.replace(/[._-]+/g, ' ').replace(/\b(software|browser)\b/ig, '').trim().replace(/\s+/g, ' ');
  const name = words.split(' ').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ') || seg;
  return { name, slug: plain(name).replace(/\s+/g, '-') };
}
// Name a user-data folder by the browser it belongs to: the reverse-DNS app
// id of a Flatpak or Snap, else the last folder part that names a browser.
function describeDir(dir, root) {
  const rel = relative(root, dir).split(sep).filter(Boolean);
  const dns = rel.find(seg => /^[\w-]+(\.[\w-]+){2,}$/.test(seg));
  if (dns) return cleanLabel(dns);
  const meaningful = rel.filter(seg => !GENERIC.has(seg.toLowerCase()));
  return cleanLabel(meaningful.pop() || rel.pop() || basename(dir));
}
// The keyring names to try for a browser, from its own name: the full name,
// each leading and trailing run of words, each single word, and "Chromium" as
// a shared fallback (many forks store their key under the base name, e.g.
// Helium under "chromium", Chrome Beta under "chrome"). So an unknown browser
// is still tried without a built-in brand list.
function identityNames(name, slug) {
  const words = name.split(' ').filter(Boolean);
  const set = new Set([name]);
  for (let i = 0; i < words.length; i++) { set.add(words.slice(i).join(' ')); set.add(words.slice(0, i + 1).join(' ')); set.add(words[i]); }
  set.add('Chromium');
  const names = [...set].filter(Boolean);
  const slugs = [...new Set([slug, ...names.map(n => plain(n).replace(/\s+/g, '-'))])];
  return { names, slugs };
}
// Folder parts that only say where a browser is packaged, not which it is;
// dropped so a key is derived from the browser-naming parts of its full path.
const SLUG_SKIP = new Set(['.config', '.var', '.local', 'share', 'app', 'snap', 'common', 'config', 'user data', 'library', 'application support', 'appdata', 'local', 'roaming', 'default']);
// A key that stays the same for a data folder however many other browsers
// appear: derived from the folder's own path, not from scan order. So a saved
// default or cookie cache never moves to another account when an install is
// added. A reverse-DNS app id keeps its last label.
function stableSlug(dir, home) {
  const parts = relative(home, dir).split(sep).filter(Boolean)
    .filter(s => !SLUG_SKIP.has(s.toLowerCase()))
    .map(s => /^[\w-]+(\.[\w-]+){2,}$/.test(s) ? s.split('.').pop() : s)
    .map(s => plain(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')).filter(Boolean);
  return parts.join('-') || plain(basename(dir)).replace(/[^a-z0-9]+/g, '-') || 'browser';
}
const systemDefault = async (run, platform) => {
  if (platform !== 'linux') return null;
  for (const [command, args] of [['xdg-settings', ['get', 'default-web-browser']], ['xdg-mime', ['query', 'default', 'x-scheme-handler/https']]]) {
    try { const { stdout } = await run(command, args, { timeout: 1500, maxBuffer: 4096 }); const raw = stdout.trim().split('\n')[0].trim().replace(/\.desktop$/, ''); if (raw) return cleanLabel(raw).slug; } catch { /* not installed */ }
  }
  return null;
};
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

export function createLoginReader({ home = homedir(), platform = process.platform, configHome = process.env.XDG_CONFIG_HOME || join(home, '.config'), localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), run = execFile, now = Date.now, defaultBrowser = () => systemDefault(execFile, platform) } = {}) {
  // The config roots to search for user-data folders: a few levels deep, so
  // native, Flatpak (~/.var/app) and Snap (~/snap) installs are all covered.
  const roots = platform === 'darwin' ? [join(home, 'Library', 'Application Support')]
    : platform === 'win32' ? [localAppData]
    : [...new Set([configHome, join(home, '.var', 'app'), join(home, 'snap')])];
  const cache = new Map();
  let usual; const usualBrowser = () => (usual ??= Promise.resolve().then(defaultBrowser).catch(() => null));
  // Every Chromium user-data folder (holds a "Local State" file), named by its
  // folder. Slugs are kept unique so two installs never share a key.
  function discover() {
    const found = [];
    for (const root of roots) for (const dir of chromiumUserDataDirs([root])) found.push({ dir, root });
    // Sort by path so the few same-slug collisions resolve the same way every
    // run, not by disk-listing order.
    found.sort((a, b) => a.dir.localeCompare(b.dir));
    const seen = new Set(), bySlug = new Map(), out = [];
    for (const { dir, root } of found) {
      if (seen.has(dir)) continue; seen.add(dir);
      const { name } = describeDir(dir, root);
      let slug = stableSlug(dir, home);
      if (bySlug.has(slug)) { let n = 2; while (bySlug.has(`${slug}-${n}`)) n++; slug = `${slug}-${n}`; }
      bySlug.set(slug, dir);
      out.push({ dir, root, slug, name });
    }
    return out;
  }
  async function passwordStore(b) {
    // Only this browser's own launcher flags, from its slug and name words.
    // Never a shared chromium-flags.conf (unless this browser IS Chromium),
    // which would wrongly make another browser's store "basic".
    const own = new Set([b.slug, ...plain(b.name).split(' ').filter(Boolean)]);
    const files = [...new Set([...own].flatMap(s => [`${s}-flags.conf`, `${s}-browser-flags.conf`]))];
    for (const file of files) {
      try { const contents = await readFile(await privatePath(b.root, join(b.root, file)), 'utf8'); const match = /(?:^|\s)--password-store=([\w-]+)/m.exec(contents.replace(/^\s*#.*$/gm, '')); if (match) return match[1]; } catch {}
    }
    return 'auto';
  }
  async function listProfiles() {
    const profiles = [], usualId = await usualBrowser();
    for (const b of discover()) {
      try {
        const state = JSON.parse(await readFile(await privatePath(b.dir, join(b.dir, 'Local State')), 'utf8')).profile || {};
        const store = platform === 'linux' ? await passwordStore(b) : platform === 'darwin' ? 'keychain' : 'app-bound';
        for (const [directory, info] of Object.entries(state.info_cache || {})) {
          if (!validDirectory(directory)) continue;
          const path = await privatePath(b.dir, join(b.dir, directory)); if (!(await lstat(path)).isDirectory()) continue;
          const email = typeof info.user_name === 'string' && info.user_name.length <= 320 ? info.user_name : '';
          profiles.push({ key: `${b.slug}:${directory}`, browser: b.slug, browserName: b.name, dataDir: b.dir, directory, name: String(info.name || directory), ...(email ? { email } : {}), lastUsed: directory === state.last_used, usedAt: Number.isFinite(info.active_time) ? Math.round(info.active_time * 1000) : 0, ...(b.slug === usualId ? { defaultBrowser: true } : {}), passwordStore: store, readable: platform !== 'win32', ...(platform === 'win32' ? { reason: 'Windows browser logins use app-bound encryption and cannot be copied here.' } : {}) });
        }
      } catch { /* browser absent or unsafe */ }
    }
    // The owner's everyday browser first, then the profiles used most lately.
    return profiles.sort((a, b) => !!b.defaultBrowser - !!a.defaultBrowser || b.usedAt - a.usedAt);
  }
  /**
   * The profile a person means. They may name the browser ("helium", "Brave"),
   * the profile ("work", "Profile 7", an email), both in any order ("helium
   * work", "work in Chrome", "brave:Default"), or paste a line from the list.
   * When two profiles fit, the everyday browser and then the latest used wins.
   */
  async function resolveProfile(wanted) {
    const choices = await listProfiles(); const value = typeof wanted === 'object' ? wanted?.key : wanted;
    if (typeof value !== 'string' || value.length > 400) throw new Error('choose a browser profile');
    const asked = plain(value);
    const exact = choices.find(p => plain(p.key) === asked || plain(label(p)) === asked);
    if (exact) return exact;
    // Every word the found browsers go by (slug, full name and each name word),
    // longest first so "google chrome" wins over "chrome".
    const byBrowser = new Map(choices.map(p => [p.browser, p.browserName]));
    const browserWords = [...byBrowser].flatMap(([slug, name]) => [...new Set([slug, plain(name), ...plain(name).split(' ')])].filter(w => w.length >= 2).map(w => [w, slug]))
      .sort((a, b) => b[0].length - a[0].length);
    let browser = null, rest = asked;
    const colon = asked.indexOf(':');
    if (colon > 0 && browserWords.some(([word]) => word === asked.slice(0, colon).trim())) { browser = browserWords.find(([word]) => word === asked.slice(0, colon).trim())[1]; rest = asked.slice(colon + 1); }
    else for (const [word, id] of browserWords) {
      const at = asked.startsWith(`${word} `) || asked.startsWith(`${word}/`) || asked === word ? 0 : asked.endsWith(` ${word}`) ? asked.length - word.length : asked.endsWith(`(${word})`) ? asked.length - word.length - 2 : -1;
      if (at < 0) continue;
      browser = id; rest = (at ? asked.slice(0, at) : asked.slice(word.length)).replace(/[()]/g, ' ').trim().replace(/\s(in|on|from)$/, '').replace(/^\s*[/-]\s*/, ''); break;
    }
    rest = rest.replace(/[\s/:-]+$/, '').replace(/^[\s/:-]+/, '').trim();
    // A profile's own name comes first: "Main" is a profile called Main
    // when there is one, else the browser's default profile.
    const tries = [...new Set([rest, rest.replace(/ profile$/, ''), rest.replace(/^(the )?(default|main)( profile)?$/, 'default')])];
    const pool = choices.filter(p => !browser || p.browser === browser);
    const names = p => [p.directory, p.name, p.email].filter(Boolean).map(plain);
    const matches = !rest ? pool.filter(p => p.lastUsed)
      : [(v, t) => v === t, (v, t) => v.startsWith(t), (v, t) => v.includes(t)]
        .flatMap(fits => tries.map(t => pool.filter(p => names(p).some(v => fits(v, t))))).find(found => found.length) || [];
    if (browser && !pool.length) throw new Error(`${byBrowser.get(browser) || browser} has no profiles on this machine. Profiles here: ${choices.map(label).join('; ') || 'none'}`);
    if (!matches.length) throw new Error(`No browser profile matches "${value}". Profiles here: ${choices.map(label).join('; ') || 'none'}`);
    return matches.find(p => p.readable) ? matches.filter(p => p.readable)[0] : matches[0];
  }
  // The keyring stores the key under the browser's own branding. This yields
  // each candidate key in turn (lazily, so the lookup stops at the first that
  // works); the caller checks each against a real cookie, so a key that merely
  // exists but belongs to another browser is not used by mistake.
  async function* secretKeys(profile) {
    const { names, slugs } = identityNames(profile.browserName, profile.browser);
    const seen = new Set();
    const give = async (command, args) => {
      try { const { stdout } = await run(command, args, { timeout: 2500, maxBuffer: 65536, windowsHide: true }); const v = stdout.replace(/\r?\n$/, '') || null; return v && !seen.has(v) ? (seen.add(v), v) : null; } catch { return null; }
    };
    if (platform === 'darwin') { for (const title of names) { const v = await give('security', ['find-generic-password', '-w', '-s', `${title} Safe Storage`]); if (v) yield v; } return; }
    if (profile.passwordStore === 'basic') return;
    if (profile.passwordStore === 'auto' || /gnome|libsecret/.test(profile.passwordStore)) {
      // Chromium's v2 schema stores one key per application's branding.
      for (const app of slugs) for (const args of [['application', app, 'xdg:schema', 'chrome_libsecret_os_crypt_password_v2'], ['application', app]]) {
        const v = await give('secret-tool', ['lookup', ...args]); if (v) yield v;
      }
    }
    if (profile.passwordStore === 'auto' || /kwallet/.test(profile.passwordStore)) {
      for (const title of names) for (const wallet of ['kdewallet', 'default']) { const v = await give('kwallet-query', ['-r', `${title} Safe Storage`, '-f', `${title} Keys`, wallet]); if (v) yield v; }
    }
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
      try { dbPath = await privatePath(profile.dataDir, join(profile.dataDir, profile.directory, file)); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!dbPath) throw new Error('This profile has no saved cookies yet.');
    // Check auxiliary files too: SQLite can otherwise follow a WAL or journal symlink.
    for (const suffix of ['-wal', '-shm', '-journal']) { try { await privatePath(profile.dataDir, dbPath + suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
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
      // Keyring-encrypted cookies: v10 on macOS, v11 on Linux (Linux v10 uses
      // the fixed "peanuts" key). Pick the keyring key that actually decrypts a
      // sample cookie, so the wrong browser's key is never used.
      const secretPrefix = platform === 'darwin' ? 'v10' : 'v11';
      const sample = rows.find(r => Buffer.from(r.encrypted_value || []).subarray(0, 3).toString() === secretPrefix);
      const needsSecret = !!sample;
      let password = null;
      if (sample) {
        const decodesWith = pass => {
          try {
            const encrypted = Buffer.from(sample.encrypted_value);
            const decipher = createDecipheriv('aes-128-cbc', key(pass, platform), Buffer.alloc(16, ' '));
            let plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
            if (version >= 24) { const hash = createHash('sha256').update(sample.host_key).digest(); if (plain.length < 32 || !plain.subarray(0, 32).equals(hash)) return false; plain = plain.subarray(32); }
            new TextDecoder('utf-8', { fatal: true }).decode(plain); return true;
          } catch { return false; }
        };
        for await (const candidate of secretKeys(profile)) { if (decodesWith(candidate)) { password = candidate; break; } }
      }
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
