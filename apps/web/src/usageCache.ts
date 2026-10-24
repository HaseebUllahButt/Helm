import { txn } from './idb';
import type { UsageReport } from './client';

/**
 * A machine's usage figures, remembered on the device.
 *
 * The first `usage.report` on a machine with a long history reads every
 * transcript its CLIs ever wrote - seconds, not milliseconds - and every call
 * after that is answered from the daemon's own index. Neither helps a phone
 * that has just opened the tab over a relayed connection, which is the case
 * that matters: the numbers are the screen.
 *
 * So the same shape as the chat and model caches: paint what we had, ask
 * anyway, replace when the answer lands. Usage changes as you work, so what is
 * shown from here is marked as remembered until the live answer arrives.
 */

/** Old enough that showing it without saying so would be a guess, not a memory. */
const KEEP_MS = 7 * 24 * 60 * 60_000;

const key = (env: string, scope: string) => `usage:${env}:${scope}`;

interface Stored { at: number; report: UsageReport; since?: string }

/** What this device last heard from that machine, or null. Never throws. */
export async function loadUsage(env: string, scope = 'all', since?: string): Promise<{ report: UsageReport; at: number } | null> {
  try {
    const rec = await txn<Stored | undefined>('kv', 'readonly', (s) => s.get(key(env, scope)));
    if (!rec?.report || Date.now() - rec.at > KEEP_MS) return null;
    // Rolling windows need the same calendar boundary, without accumulating
    // a new permanent cache key for every day the app is opened.
    if (since !== undefined && rec.since !== since) return null;
    return { report: rec.report, at: rec.at };
  } catch { return null; }
}

/** Remember what the machine just said. Never throws. */
export async function saveUsage(env: string, report: UsageReport, scope = 'all', since?: string): Promise<void> {
  try {
    await txn('kv', 'readwrite', (s) => s.put({ at: Date.now(), report, since } satisfies Stored, key(env, scope)));
  } catch { /* a browser that will not store is not a reason to fail a screen */ }
}

/**
 * Add machines together for the global view.
 *
 * A machine that did not answer is not zero - it is unknown, and the caller is
 * told which ones are missing so the screen can say "3 of 4 reporting" rather
 * than quietly under-reporting. That is the same courtesy `helm digest` pays a
 * sleeping machine.
 */
export function mergeReports(parts: { env: string; report: UsageReport }[]): UsageReport {
  const totals = blank();
  const daily = new Map<string, ReturnType<typeof blank> & { date: string }>();
  const groups = new Map<string, any>();
  const accounts: UsageReport['accounts'] = [];
  const scan: Record<string, number> = {};
  let at = 0;
  const estimates = new Map<string, NonNullable<UsageReport['estimates']>[number]>();

  for (const { report } of parts) {
    add(totals, report.totals);
    at = Math.max(at, report.at || 0);
    for (const d of report.daily || []) {
      const cur = daily.get(d.date) || { ...blank(), date: d.date };
      add(cur, d);
      daily.set(d.date, cur);
    }
    for (const g of report.groups || []) {
      // Group identity is whatever dimensions the daemon was asked for, so the
      // key is built from the ones actually present rather than a fixed list.
      const k = ['engine', 'account', 'model', 'provider', 'project']
        .map((d) => (g as any)[d] ?? '').join('\0');
      const cur = groups.get(k) || { ...g, ...blank() };
      add(cur, g);
      groups.set(k, cur);
    }
    // A Claude folder copied between machines brings the same daily totals,
    // so two machines can estimate one deleted day. The second copy comes
    // back out of every figure it went into.
    for (const e of report.estimates || []) {
      if (!estimates.has(e.id)) { estimates.set(e.id, e); continue; }
      add(totals, e, -1);
      const day = daily.get(e.date);
      if (day) add(day, e, -1);
      const group = groups.get(['engine', 'account', 'model', 'provider', 'project'].map((d) => (e as any)[d] ?? '').join('\0'));
      if (group) add(group, e, -1);
    }
    accounts.push(...(report.accounts || []));
    for (const [k, v] of Object.entries(report.scan || {})) {
      if (typeof v === 'number') scan[k] = (scan[k] || 0) + v;
    }
  }

  return {
    totals,
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    groups: [...groups.values()].sort((a, b) => b.costUsd - a.costUsd),
    accounts,
    scan,
    at,
    ...(estimates.size ? { estimates: [...estimates.values()] } : {}),
  };
}

function blank() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, turns: 0,
    costUsd: 0, unpriced: false, cacheSavedUsd: 0, cacheWritePremiumUsd: 0,
  };
}

function add(acc: ReturnType<typeof blank>, b: Partial<ReturnType<typeof blank>>, sign = 1) {
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total', 'turns',
    'costUsd', 'cacheSavedUsd', 'cacheWritePremiumUsd'] as const) {
    acc[k] += sign * ((b as any)[k] || 0);
  }
  if (b.unpriced) acc.unpriced = true;
}

/** Local calendar dates, because a bill is read in the timezone you live in. */
export const today = () => {
  const n = new Date();
  return new Date(n.getTime() - n.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

export const daysAgo = (n: number) => {
  const d = new Date(Date.parse(today()) - n * 86400000);
  return d.toISOString().slice(0, 10);
};
