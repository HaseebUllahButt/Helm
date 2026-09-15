import { useCallback, useEffect, useRef, useState } from 'react';
import type { Client } from '../client';
import { apply, emptyLog, type HelmEvent, type LogState } from './types';

/**
 * A live view of one headless session.
 *
 * Loads the log once, then applies pushes as they arrive - in sequence
 * order, and if a push ever skips a number (a socket that dropped for a
 * moment) the gap is refetched rather than guessed at. The daemon only
 * pushes while we keep saying we are watching, so the watch is renewed
 * while this hook is mounted, and re-done after a reconnect.
 */
export function useSessionLog(client: Client, env: string, sessionId: string) {
  const log = useRef<LogState>(emptyLog());
  const [state, setState] = useState<LogState>(log.current);
  const [error, setError] = useState('');
  const fetching = useRef<Promise<void> | null>(null);

  const publish = useCallback(() => setState({ ...log.current, turns: log.current.turns, pending: [...log.current.pending] }), []);

  const fetchSince = useCallback((since: number) => {
    if (fetching.current) return fetching.current;
    fetching.current = (async () => {
      // Page through: an old chat can hold 2000 events and one reply that
      // large exceeds the data-channel message limit.
      let cursor = since;
      for (let pages = 0; pages < 8; pages++) {
        const r = await client
          .rpc<{ events: HelmEvent[]; pending: any[]; last: number; hasMore?: boolean }>(
            env, 'session.events', { id: sessionId, since: cursor, limit: 500 }, 20_000);
        for (const e of r.events) apply(log.current, e);
        if (r.events.length) cursor = r.events[r.events.length - 1].seq;
        if (!r.hasMore) break;
      }
      log.current.loaded = true;
      setError('');
      publish();
    })()
      .catch((e: any) => setError(e.message))
      .finally(() => { fetching.current = null; });
    return fetching.current;
  }, [client, env, sessionId, publish]);

  useEffect(() => {
    log.current = emptyLog();
    setState(log.current);
    let stopped = false;

    const watch = () => client.rpc(env, 'session.watch', { id: sessionId }, 10_000).catch(() => {});
    watch();
    fetchSince(0);
    const renew = setInterval(watch, 25_000);

    const off = client.on((e, kind, payload) => {
      if (stopped) return;
      if (kind === 'session.event' && e === env && payload?.id === sessionId) {
        const events: HelmEvent[] = payload.events ?? [];
        for (const ev of events) {
          if (ev.seq > log.current.last + 1 && log.current.loaded) {
            // Something was missed; ask for everything after what we have.
            fetchSince(log.current.last);
            return;
          }
          apply(log.current, ev);
        }
        publish();
      }
      if (kind === 'connection' && payload?.online) { watch(); fetchSince(log.current.last); }
    });

    return () => {
      stopped = true;
      clearInterval(renew);
      off();
      client.rpc(env, 'session.unwatch', { id: sessionId }, 5_000).catch(() => {});
    };
  }, [client, env, sessionId, fetchSince, publish]);

  return { log: state, error, refresh: () => fetchSince(log.current.last) };
}
