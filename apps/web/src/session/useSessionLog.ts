import { useCallback, useEffect, useRef, useState } from 'react';
import type { Client } from '../client';
import { apply, emptyLog, type HelmEvent, type LogState } from './types';
import { loadCached, saveCached } from './logCache';

/**
 * How much of a conversation an open asks for: the end of it.
 *
 * The machine budgets the reply in bytes as well, so this is only the count
 * at which even small events stop being worth fetching. Two hundred is a
 * handful of turns - more than a phone screen holds, and the rest is a tap.
 */
const TAIL = 200;

/**
 * A live view of one headless session.
 *
 * Opening paints instantly from the on-device cache when there is one,
 * then refreshes only what is new in the background - an old chat no
 * longer costs up to 8 relay round-trips before first paint.
 *
 * With no cache it asks for the *tail* rather than paging forward from the
 * first event. That is the difference between opening a chat and waiting for
 * one: a devin thread on the owner's VM held 822 events and 6.8MB, and the
 * old first page - 500 events, oldest first - was 5MB, which took 58 seconds
 * from the laptop and timed out at 20 on the phone, to render a screenful of
 * history nobody had asked to see. The machine now budgets a page in bytes
 * and answers from the end; what came before is counted, and fetched only if
 * the owner reaches for it.
 *
 * What is on screen is written back as it streams, not only when the view
 * closes. A phone does not close views: it is swiped away, or the tab is
 * evicted while it sits in the background, and React never unmounts - so
 * anything that arrived since the chat was opened was cached nowhere and
 * came back over the network. It is saved a beat after the stream goes
 * quiet, and again the moment the page is hidden. Loads the
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
  /**
   * Whether the machine holds anything before the oldest event on screen.
   * `firstSeq` is the front of our window; the daemon says where its own log
   * starts, and the two together answer it for a cached open as well as a
   * cold one.
   */
  const [earlier, setEarlier] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const firstSeq = useRef(0);
  const noteWindow = useCallback((logFirst?: number) => {
    setEarlier(!!logFirst && !!firstSeq.current && logFirst < firstSeq.current);
  }, []);

  const publish = useCallback(() => setState({ ...log.current, turns: log.current.turns, pending: [...log.current.pending] }), []);

  const dirty = useRef(false);
  const writer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = useCallback(() => {
    if (writer.current) { clearTimeout(writer.current); writer.current = null; }
    if (!dirty.current) return;
    dirty.current = false;
    if (log.current.last > 0 && raw.current.length) {
      saveCached(env, sessionId, log.current.last, raw.current, firstSeq.current).catch(() => {});
    }
  }, [env, sessionId]);

  /**
   * Save shortly after the stream goes quiet. Debounced because a live turn
   * is hundreds of deltas a second and each save rewrites the whole array;
   * short because the window between the last save and a phone killing the
   * app is exactly what gets lost.
   */
  const persistSoon = useCallback(() => {
    dirty.current = true;
    if (writer.current) return;
    writer.current = setTimeout(() => { writer.current = null; persist(); }, 2000);
  }, [persist]);

  const fetchSince = useCallback((since: number) => {
    if (fetching.current) return fetching.current;
    fetching.current = (async () => {
      // Nothing on screen yet: take the end of the conversation in one
      // budgeted reply. Otherwise page forward from what we already have,
      // which is only what happened while this device was away.
      const cold = since === 0 && !log.current.turns.length;
      let cursor = since;
      for (let pages = 0; pages < 8; pages++) {
        const r = await client
          .rpc<{ events: HelmEvent[]; pending: any[]; last: number; hasMore?: boolean; firstSeq?: number; logFirst?: number }>(
            env, 'session.events',
            cold && pages === 0
              ? { id: sessionId, tail: TAIL }
              : { id: sessionId, since: cursor, limit: 500 },
            20_000);
        for (const e of r.events) {
          if (e.seq > log.current.last) raw.current.push(e);
          apply(log.current, e);
        }
        if (cold && pages === 0) firstSeq.current = r.firstSeq ?? r.events[0]?.seq ?? 0;
        noteWindow(r.logFirst);
        if (r.events.length) cursor = r.events[r.events.length - 1].seq;
        publish();
        if (!r.hasMore) break;
      }
      log.current.loaded = true;
      setError('');
      publish();
      dirty.current = true;
      persist();
    })()
      .catch((e: any) => setError(e.message))
      .finally(() => { fetching.current = null; });
    return fetching.current;
  }, [client, env, sessionId, publish, persist, noteWindow]);

  /**
   * One more window of what came before, newest-first, on request.
   *
   * The events land in front of what is already reduced, so the log is rebuilt
   * from the whole array rather than patched: a turn that was half in the
   * window has to become whole, and `apply` only ever moves forward.
   */
  const loadEarlier = useCallback(async () => {
    if (loadingEarlier || !firstSeq.current) return;
    setLoadingEarlier(true);
    try {
      const r = await client.rpc<{ events: HelmEvent[]; firstSeq?: number; logFirst?: number }>(
        env, 'session.events', { id: sessionId, before: firstSeq.current }, 30_000);
      if (!r.events.length) { setEarlier(false); return; }
      firstSeq.current = r.firstSeq ?? r.events[0].seq;
      noteWindow(r.logFirst);
      raw.current = [...r.events, ...raw.current];
      const rebuilt = emptyLog();
      for (const e of raw.current) apply(rebuilt, e);
      rebuilt.loaded = true;
      rebuilt.pending = log.current.pending;
      log.current = rebuilt;
      publish();
      dirty.current = true;
      persist();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingEarlier(false);
    }
  }, [client, env, sessionId, loadingEarlier, publish, persist, noteWindow]);

  useEffect(() => {
    log.current = emptyLog();
    raw.current = [];
    firstSeq.current = 0;
    setEarlier(false);
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
        // A record that reduces to nothing is not a chat, it is a hole: every
        // event in it belongs to a turn that was cut off before it. Nothing
        // would ever repair it either, because its `last` is current and the
        // refresh behind it asks only for what is newer. Treat it as a miss
        // and take a fresh window, which is also how a device heals from a
        // window some earlier version of con cut badly.
        if (!log.current.turns.length) {
          log.current = emptyLog();
          raw.current = [];
        } else {
          log.current.loaded = true;
          firstSeq.current = cached.first || cached.events[0].seq;
          publish();
        }
      }
      fetchSince(log.current.last);
    });

    const renew = setInterval(watch, 25_000);

    // Being hidden is how a chat ends on a phone. The write is asynchronous
    // and may not finish if the app is killed in the same breath, which is
    // why the debounce above is the real guarantee and this is the last word.
    const onHide = () => { if (document.visibilityState === 'hidden') persist(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', persist);

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
        persistSoon();
      }
      if (kind === 'connection' && payload?.online) { watch(); fetchSince(log.current.last); }
    });

    return () => {
      stopped = true;
      clearInterval(renew);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', persist);
      off();
      persist();
      client.rpc(env, 'session.unwatch', { id: sessionId }, 5_000).catch(() => {});
    };
  }, [client, env, sessionId, fetchSince, publish, persist, persistSoon]);

  return { log: state, error, earlier, loadingEarlier, loadEarlier, refresh: () => fetchSince(log.current.last) };
}
