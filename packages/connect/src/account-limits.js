import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { limitWindows } from '@helm/protocol/limits';
import { HELM_DIR } from './paths.js';
import { accountKey } from './settings.js';

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
      accounts.set(key, { account: key, engine: p.engine,
        label: suffix || (p.wraps ? p.id : 'default'), aliases: [p.id],
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
