import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { limitWindows } from '@helm/protocol/limits';
import { HELM_DIR } from './paths.js';
import { accountKey } from './settings.js';

const expand = (p) => p.replace(/^~(?=\/|$)/, homedir());
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const fingerprint = (engine, id) => createHash('sha256').update(`${engine}\0${id}`).digest('hex').slice(0, 16);

/**
 * Who the provider bills, the same on every machine - so one account used
 * from the laptop and the VM is one row with the newest reading, not two.
 * The local account key cannot say this: it names a home folder, and the
 * same login lives in ~/.claude-personal here and ~/.claude there.
 *
 * - A saved token is already named by a hash of its value (`HELM_SECRET_…`),
 *   identical wherever the same token was added.
 * - A browser login carries the provider's account id: Claude's
 *   `.claude.json` oauthAccount, Codex's auth.json account_id.
 *
 * Only a one-way fingerprint leaves the machine. Null when nothing local
 * names the account; those rows stay per machine.
 */
export function accountIdentity(profile) {
  if (profile.wraps) return null;
  const token = Object.values(profile.secretRefs ?? {}).find((ref) => /^HELM_SECRET_[0-9a-f]{16,}$/.test(ref));
  if (token) return fingerprint(profile.engine, `token:${token}`);
  if ((profile.envFrom ?? []).length) return null;
  if (profile.engine === 'claude') {
    const dir = profile.env?.CLAUDE_CONFIG_DIR;
    const id = readJson(dir ? join(expand(dir), '.claude.json') : join(homedir(), '.claude.json'))?.oauthAccount?.accountUuid;
    return typeof id === 'string' && id ? fingerprint('claude', `account:${id}`) : null;
  }
  if (profile.engine === 'codex') {
    const auth = readJson(join(expand(profile.env?.CODEX_HOME ?? '~/.codex'), 'auth.json'));
    const id = auth?.tokens?.account_id;
    return typeof id === 'string' && id ? fingerprint('codex', `account:${id}`) : null;
  }
  return null;
}

/** Keep only quota readings, never the provider's credentials or raw payload. */
export class AccountLimits {
  constructor({ file = join(HELM_DIR, 'account-limits.json') } = {}) {
    this.file = file;
    try { this.rows = new Map(Object.entries(JSON.parse(readFileSync(file, 'utf8')))); }
    catch { this.rows = new Map(); }
  }

  record(account, event, at = Date.now(), persist = true) {
    if (!Number.isFinite(at) || at <= 0) return;
    const windows = limitWindows(event);
    if (!windows.length) return;
    const merged = new Map((this.rows.get(account) ?? []).map(w => [w.label, w]));
    let changed = false;
    for (const w of windows) {
      if ((merged.get(w.label)?.at ?? 0) >= at) continue;
      merged.set(w.label, { ...w, at });
      changed = true;
    }
    if (!changed) return;
    this.rows.set(account, [...merged.values()]);
    if (persist) this.save();
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(Object.fromEntries(this.rows)), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
  }

  /** One migration of recent retained events, without loading chat attachments. */
  async seed(sessions, profiles, eventsDir) {
    const keys = new Map(profiles.map(p => [p.id, accountKey(p)]));
    const count = new Map();
    for (const s of [...sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))) {
      const key = keys.get(s.profileId);
      if (!key || !['claude', 'codex'].includes(s.engine) || !/^[\w-]+$/.test(s.id)) continue;
      const n = count.get(key) ?? 0;
      if (n >= 3) continue;
      count.set(key, n + 1);
      try {
        const content = await readFile(join(eventsDir, `${s.id}.jsonl`), 'utf8');
        for (const line of content.split('\n')) {
          if (!line.includes('"limits"')) continue;
          try {
            const e = JSON.parse(line);
            if (e.type === 'limits' && Number.isFinite(e.at)) this.record(key, e, e.at, false);
          } catch { /* a torn last event is not a reading */ }
        }
      } catch { /* no retained history for this session */ }
    }
    this.save();
  }

  report(profiles) {
    const accounts = new Map();
    let unsupported = 0;
    for (const p of profiles) {
      if (p.disabled || p.engine === 'shell') continue;
      const key = accountKey(p);
      if (accounts.has(key)) { accounts.get(key).aliases.push(p.id); continue; }
      const home = Object.values(p.env ?? {}).find(v => /^[~/]/.test(v));
      const suffix = (home?.split('/').pop() ?? '').replace(/^\.?(claude|codex)-?/, '');
      const identity = ['claude', 'codex'].includes(p.engine) ? accountIdentity(p) : null;
      accounts.set(key, { account: key, engine: p.engine,
        label: suffix || (p.wraps ? p.id : 'default'), aliases: [p.id],
        ...(identity ? { identity } : {}),
        windows: this.rows.get(key) ?? [] });
    }
    const supported = [...accounts.values()].filter(a => {
      if (['claude', 'codex'].includes(a.engine)) return true;
      unsupported++;
      return false;
    });
    for (const a of supported) {
      if ([...accounts.values()].filter(b => b.engine === a.engine && b.label === a.label).length > 1) {
        a.displayLabel = `${a.label} (${a.aliases[0]})`;
      }
    }
    supported.sort((a, b) => Number(!!b.windows.length) - Number(!!a.windows.length)
      || a.engine.localeCompare(b.engine) || a.label.localeCompare(b.label));
    return { accounts: supported, unsupported };
  }
}
