import { useEffect, useMemo, useState } from 'react';
import type { Client } from '../client';
import { current, limitWindows, rememberLimits, rememberedLimits, reportsLimits, type LimitWindow } from './limits';

/** Shared by driven chats and terminals, using the actual account rather than a default login. */
export function useAccountLimits(client: Client, env: string, engine: string, profileId?: string | null, live?: unknown) {
  const key = `${env}:${profileId}`;
  const liveWindows = useMemo(() => limitWindows(live), [live]);
  const [machine, setMachine] = useState<{ key: string; windows: LimitWindow[] } | null>(null);
  useEffect(() => { if (profileId) rememberLimits(key, liveWindows); }, [key, profileId, liveWindows]);
  useEffect(() => {
    if (!profileId || engine === 'shell') return;
    let active = true;
    const read = () => client.rpc<{ accounts: { engine: string; aliases: string[]; windows: LimitWindow[] }[] }>(env, 'usage.limits', {}, 15_000)
      .then(result => {
        const windows = result.accounts.find(a => a.engine === engine && a.aliases.includes(profileId))?.windows ?? [];
        if (active) { setMachine({ key, windows }); rememberLimits(key, windows); }
      }).catch(() => {});
    void read();
    const timer = setInterval(read, 120_000);
    const off = client.on((machine, kind, payload) => {
      if ((kind === 'connection' && payload?.online) || (machine === env && kind === 'presence' && payload?.online)
        || (machine === env && kind === 'session.event' && reportsLimits(payload))) void read();
    });
    return () => { active = false; clearInterval(timer); off(); };
  }, [client, env, engine, profileId, key]);
  if (!profileId) return [];
  const fromMachine = machine?.key === key ? current(machine.windows) : [];
  const fromLive = current(liveWindows);
  return fromLive.length ? fromLive : fromMachine.length ? fromMachine : current(rememberedLimits(key));
}
