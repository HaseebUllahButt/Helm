import { useCallback, useEffect, useRef, useState } from 'react';
import type { Client } from '../client';
import { apply, emptyLog, type HelmEvent, type LogState } from './types';
import { loadCached, saveCached } from './logCache';

/**
 * A live view of one headless session.
 *
 * Opening paints instantly from the on-device cache when there is one,
 * then refreshes only what is new in the background - an old chat no
 * longer costs up to 8 relay round-trips before first paint. Loads the
 * log once, then applies pushes as they arrive - in sequence order, and
 * if a push ever skips a number (a socket that dropped for a moment) the
 * gap is refetched rather than guessed at. The daemon only pushes while
 * we keep saying we are watching, so the watch is renewed while this
 * hook is mounted, and re-done after a reconnect.
 */
export function useSessionLog(client: Client, env: string, sessionId: string) {
  const log = useRef<LogState>(emptyLog());
  /** Raw events in seq order, mirroring what was applied - what gets cached. */
  const raw = useRef<HelmEvent[]>([]);
  const [state, setState] = useState<LogState>(log.current);
  const [error, setError] = useState('');
  const fetching = useRef<Promise<void> | null>(null);

  const publish = useCallback(() => setState({ ...log.current, turns: log.current.turns, pending: [...log.current.pending] }), []);

  const persist = useCallback(() => {
    if (log.current.last > 0 && raw.current.length) {
      saveCached(env, sessionId, log.current.last, raw.current).catch(() => {});
    }
  }, [env, sessionId]);

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
        for (const e of r.events) {
          if (e.seq > log.current.last) raw.current.push(e);
          apply(log.current, e);
        }
        if (r.events.length) cursor = r.events[r.events.length - 1].seq;
        publish();
        if (!r.hasMore) break;
      }
      log.current.loaded = true;
      setError('');
      publish();
      persist();
    })()
      .catch((e: any) => setError(e.message))
      .finally(() => { fetching.current = null; });
    return fetching.current;
  }, [client, env, sessionId, publish, persist]);

  useEffect(() => {
    log.current = emptyLog();
    raw.current = [];
    setState(log.current);
    let stopped = false;

    const watch = () => client.rpc(env, 'session.watch', { id: sessionId }, 10_000).catch(() => {});
    watch();
    // Instant paint from the device cache, then only-what-is-new behind it.
    loadCached(env, sessionId).then((cached) => {
      if (stopped) return;
      if (cached?.events.length) {
        for (const e of cached.events) {
          raw.current.push(e);
          apply(log.current, e);
        }
        log.current.loaded = true;
        publish();
      }
      fetchSince(log.current.last);
    });

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
          if (ev.seq > log.current.last) raw.current.push(ev);
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
      persist();
      client.rpc(env, 'session.unwatch', { id: sessionId }, 5_000).catch(() => {});
    };
  }, [client, env, sessionId, fetchSince, publish, persist]);

  return { log: state, error, refresh: () => fetchSince(log.current.last) };
}
