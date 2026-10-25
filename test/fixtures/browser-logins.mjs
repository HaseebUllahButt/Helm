import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto';

export const unixToChrome = seconds => BigInt(Math.round((seconds + 11644473600) * 1000000));
export function encrypted(value, { password = 'peanuts', prefix = 'v10', host = '.example.test', version = 24, platform = 'linux' } = {}) {
  const cipher = createCipheriv('aes-128-cbc', pbkdf2Sync(password, 'saltysalt', platform === 'darwin' ? 1003 : 1, 16, 'sha1'), Buffer.alloc(16, ' '));
  const bytes = Buffer.concat([...(version >= 24 ? [createHash('sha256').update(host).digest()] : []), Buffer.from(value)]);
  return Buffer.concat([Buffer.from(prefix), cipher.update(bytes), cipher.final()]);
}
export async function fixture(root, { browserPath = 'chromium', directory = 'Default', name = 'Personal', info = {}, version = 24, network = true, wal = false } = {}) {
  const browser = join(root, browserPath), profile = join(browser, directory);
  await mkdir(network ? join(profile, 'Network') : profile, { recursive: true });
  let state; try { state = JSON.parse(await (await import('node:fs/promises')).readFile(join(browser, 'Local State'), 'utf8')); } catch { state = { profile: { info_cache: {} } }; }
  state.profile.info_cache[directory] = { name, ...info }; state.profile.last_used = directory;
  await writeFile(join(browser, 'Local State'), JSON.stringify(state));
  const db = new DatabaseSync(join(profile, network ? 'Network/Cookies' : 'Cookies'));
  if (wal) db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE meta(key TEXT, value TEXT); CREATE TABLE cookies(host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, has_expires INTEGER, top_frame_site_key TEXT)');
  db.prepare('INSERT INTO meta VALUES (?, ?)').run('version', String(version));
  const insert = ({ host = '.example.test', name = 'fixture', value = '', bytes = encrypted('synthetic'), path = '/', expires = -1, secure = true, httpOnly = true, sameSite = 1, partitionKey = '' } = {}) => db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(host, name, value, bytes, path, expires === -1 ? 0n : unixToChrome(expires), +secure, +httpOnly, sameSite, +(expires !== -1), partitionKey);
  return { db, insert, profile, browser };
}
