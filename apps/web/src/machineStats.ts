import { useEffect, useState } from 'react';
import type { Client, Environment } from './client';

/** One machine's answer to `machine.stats` (machine-stats.js). Bytes and percents. */
export interface MachineStats {
  at: number;
  cpu: { cores: number; model: string | null; used: number | null };
  load: number[] | null;
  memory: { total: number; used: number };
  disk: { total: number; free: number } | null;
  gpus: { name: string; used: number | null; memory: { total: number; used: number } | null }[];
  uptime: number;
}

/** A machine that answered, one that runs a Helm without stats, or one that did not answer. */
export type StatsState = MachineStats | 'old' | 'silent';

/**
 * Each online machine's load, asked again every `everyMs` while the page is
 * in sight. Nothing runs on a machine between asks.
 */
export function useMachineStats(client: Client, envs: Environment[], everyMs: number): Record<string, StatsState> {
  const [stats, setStats] = useState<Record<string, StatsState>>({});
  const online = envs.filter((e) => e.online).map((e) => e.id);
  useEffect(() => {
    let live = true;
    const busy = new Set<string>();
    const ask = () => {
      if (document.hidden) return;
      for (const id of online) {
        if (busy.has(id)) continue;
        busy.add(id);
        client.rpc<MachineStats>(id, 'machine.stats', {}, 8_000)
          .then((s) => { if (live) setStats((all) => ({ ...all, [id]: s })); })
          .catch((e: unknown) => {
            const old = /unknown method/i.test(String((e as Error)?.message ?? e));
            if (live) setStats((all) => ({ ...all, [id]: old ? 'old' : (typeof all[id] === 'object' ? all[id] : 'silent') }));
          })
          .finally(() => busy.delete(id));
      }
    };
    ask();
    const timer = setInterval(ask, everyMs);
    document.addEventListener('visibilitychange', ask);
    return () => { live = false; clearInterval(timer); document.removeEventListener('visibilitychange', ask); };
  }, [client, online.join(','), everyMs]); // eslint-disable-line react-hooks/exhaustive-deps
  return stats;
}

export const memoryShare = (s: MachineStats) => s.memory.total ? Math.round((s.memory.used / s.memory.total) * 100) : null;

/** "31 GB", "512 MB", "1.5 TB". */
export function bytes(n: number) {
  if (n >= 1e12) return `${Math.round(n / 1e11) / 10} TB`;
  if (n >= 1e9) return `${n >= 1e11 ? Math.round(n / 1e9) : Math.round(n / 1e8) / 10} GB`;
  return `${Math.round(n / 1e6)} MB`;
}

/** "CPU 12% · memory 40%", for a machine row. */
export function loadPhrase(s: StatsState | undefined) {
  if (!s || typeof s !== 'object') return '';
  const parts = [];
  if (s.cpu.used !== null) parts.push(`CPU ${Math.round(s.cpu.used)}%`);
  const mem = memoryShare(s);
  if (mem !== null) parts.push(`memory ${mem}%`);
  for (const g of s.gpus) if (g.used !== null) parts.push(`GPU ${Math.round(g.used)}%`);
  return parts.join(' · ');
}
