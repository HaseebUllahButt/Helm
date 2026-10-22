import type { Account } from '../accounts';
import type { Session } from '../client';

export const shortPath = (p: string) => {
  const parts = p.replace(/\/$/, '').split('/');
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : p;
};

export const byRecent = (a: Session, b: Session) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);

/** A terminal helm opened and still holds - not a shell someone runs at the keyboard. */
export const ownTerminal = (s: Session) => s.engine === 'shell' && !s.archived && s.alive !== false && !s.adopted;

export const startSummary = (a: Account) => {
  const values = [
    a.prefs?.default?.replace(/^[^/]+\//, ''),
    a.defaults?.effort,
    a.defaults?.mode,
    a.defaults?.speed,
  ].filter(Boolean);
  return values.length ? `Starts with ${values.join(' · ')}` : "Uses agent defaults";
};

export function ago(ts: number | null | undefined) {
  if (!ts || !Number.isFinite(ts)) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 0 || s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
