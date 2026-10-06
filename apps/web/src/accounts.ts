import type { ModelPrefs, Profile } from './client';

/**
 * An account is a CLI plus the home directory (or credential) it runs with.
 * A shell full of aliases yields the same account many times over, each with
 * different flags - `d`, `codexp`, `codexpx` are all "Codex, personal". The
 * flags are choices to make when starting, not separate things to pick from,
 * so collapse the aliases to accounts and keep the plainest alias of each as
 * the one to launch.
 */
export interface Account {
  key: string;
  engine: string;
  account: string;
  token: boolean;
  profile: Profile;
  aliases: string[];
  prefs?: ModelPrefs | null;
  defaults?: { effort?: string; mode?: string; speed?: string } | null;
}

export function accountsFrom(profiles: Profile[]): Account[] {
  const by = new Map<string, Account>();
  for (const p of profiles) {
    if (p.engine === 'shell' || (p as any).disabled) continue;
    const home = Object.values(p.env ?? {}).find((v) => /^[~/]/.test(v));
    // Engine + home + credential is what makes an account; an alias that
    // also unsets a variable is the same account with a different mood. The
    // daemon computes the same key, which is what its model prefs index by.
    const key = p.account ?? [p.engine, home ?? '', [...(p.envFrom ?? [])].sort().join(',')].join('|');
    const leaf = home?.split('/').pop() ?? '';
    const suffix = leaf.replace(/^\.?(claude|codex|opencode2|opencode|devin|config|grok|cursor|rovodev|gemini|kimi-code|kimi|muse|omp|pi|agent)-?/, '');
    const existing = by.get(key);
    if (existing) {
      existing.aliases.push(p.id);
      existing.prefs ??= p.prefs;
      existing.defaults ??= p.defaults;
      // Fewest arguments = the plainest way to launch this account.
      if ((p.args ?? []).length < (existing.profile.args ?? []).length) existing.profile = p;
      continue;
    }
    by.set(key, {
      key, engine: p.engine,
      // A wrapper account has no home to name it by; its alias (a1) is the name.
      account: suffix || (p.wraps ? p.id : 'default'),
      token: (p.envFrom ?? []).some((k) => /TOKEN|KEY/i.test(k)),
      profile: p, aliases: [p.id], prefs: p.prefs, defaults: p.defaults,
    });
  }
  const order = ['claude', 'codex', 'opencode', 'opencode2', 'devin', 'grok', 'cursor', 'pi', 'omp', 'rovo', 'antigravity', 'agy', 'gemini', 'kimi', 'muse'];
  const rank = (e: string) => { const i = order.indexOf(e); return i < 0 ? order.length : i; };
  return [...by.values()].sort((a, b) =>
    (rank(a.engine) - rank(b.engine)) || a.account.localeCompare(b.account));
}

/**
 * Which agents the picker shows and which one was used last. A machine new
 * enough keeps these itself (`picker.prefs`), so every phone and laptop sees
 * the same list; this browser's copy is only for older machines, and is
 * moved onto the machine the first time a newer one is opened.
 */
const PREFS = 'helm.prefs';
export type Prefs = Record<string, { account?: string; hidden?: string[] }>;
export interface PickerPrefs { hidden: string[]; last: string | null; agent?: string | null; favs?: Record<string, string[]> }
export const loadPrefs = (): Prefs => { try { return JSON.parse(localStorage.getItem(PREFS) || '{}'); } catch { return {}; } };
export const savePrefs = (p: Prefs) => { try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch { /* full */ } };

/**
 * The folders a session last started in on a machine, newest first. Both
 * ways of starting one - the folder screen and the new-chat popup - read and
 * add to the same list.
 */
export const recentFolders = (envId: string): string[] => {
  try { return JSON.parse(localStorage.getItem(`helm-folders:${envId}`) || '[]'); } catch { return []; }
};
export const rememberFolder = (envId: string, path: string) => {
  try {
    const next = [path, ...recentFolders(envId).filter((r) => r !== path)].slice(0, 6);
    localStorage.setItem(`helm-folders:${envId}`, JSON.stringify(next));
  } catch { /* full */ }
};
