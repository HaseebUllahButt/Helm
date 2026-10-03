import { useCallback, useEffect, useRef, useState } from 'react';
import type { Client } from '../client';
import { apply, emptyLog, type HelmEvent, type LogState, type Permission } from './types';
import { loadCached, saveCached } from './logCache';

const TAIL = 200;
const RENEW_MS = 10_000;
type History = {
  events: HelmEvent[]; pending: Permission[]; last: number; hasMore?: boolean;
  firstSeq?: number; logFirst?: number; session?: { status: string };
};

/** Cache for first paint, ordered history for truth, pushes for low latency. */
export function useSessionLog(client: Client, env: string, sessionId: string) {
  const [state, setState] = useState<LogState>(emptyLog);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(true);
  const [earlier, setEarlier] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const actions = useRef({ refresh: async () => {}, earlier: async () => {} });

  useEffect(() => {
    // All mutable state belongs to this mount. A late reply from another
    // chat (or a StrictMode cleanup) can never write into this conversation.
    let stopped = false, initialized = false, fetching = false, pagingBack = false;
    let log = emptyLog(), raw: HelmEvent[] = [], first = 0, windowVersion = 0;
    let dirty = false, retryDelay = 1000;
    let paint: ReturnType<typeof setTimeout> | undefined;
    let writer: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const buffered = new Map<number, HelmEvent>();
    const watchId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setState(log); setError(''); setSyncing(true); setEarlier(false); setLoadingEarlier(false);

    const publish = () => {
      clearTimeout(paint); paint = undefined;
      if (!stopped) setState({ ...log, pending: [...log.pending] });
    };
    const persist = () => {
      clearTimeout(writer); writer = undefined;
      if (!dirty || !raw.length) return;
      dirty = false;
      void saveCached(env, sessionId, log.last, [...raw], first);
    };
    const changed = () => {
      dirty = true;
      paint ??= setTimeout(publish, 50);
      writer ??= setTimeout(persist, 2000);
    };
    const consume = (events: HelmEvent[]) => {
      for (const event of events) {
        if (event.seq <= log.last) continue;
        raw.push(event);
        apply(log, event);
      }
    };
    const noteWindow = (logFirst?: number) => setEarlier(!!logFirst && !!first && logFirst < first);
    const reset = () => { log = emptyLog(); raw = []; first = 0; windowVersion++; };
    const scheduleRetry = () => {
      if (stopped || retry) return;
      retry = setTimeout(() => { retry = undefined; void refresh(); }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, RENEW_MS);
    };

    // Live frames wait behind cache/history reads. Advancing the cursor with
    // a newer push first would make the reducer discard the missing history.
    const drain = () => {
      if (!initialized || fetching || stopped) return;
      let advanced = false;
      for (const event of [...buffered.values()].sort((a, b) => a.seq - b.seq)) {
        if (event.seq <= log.last) { buffered.delete(event.seq); continue; }
        if (event.seq !== log.last + 1) { if (advanced) changed(); void refresh(); return; }
        consume([event]); buffered.delete(event.seq);
        advanced = true;
      }
      if (advanced) changed();
    };

    const refresh = async () => {
      if (stopped || !initialized || fetching) return;
      fetching = true;
      clearTimeout(retry); retry = undefined;
      setSyncing(true);
      let failed = false;
      try {
        let target: number | undefined;
        let resetOnce = false;
        for (;;) {
          const cursor = log.last;
          const cold = cursor === 0;
          const r = await client.rpc<History>(env, 'session.events', cold
            ? { id: sessionId, tail: TAIL }
            : { id: sessionId, since: cursor, limit: 500 }, 20_000);
          if (stopped) return;
          // The machine may have trimmed past this device's cache or restored
          // an older log. In either case take a complete fresh tail window.
          if (!cold && (r.last < cursor || (r.logFirst ?? 0) > cursor + 1)) {
            if (resetOnce) throw new Error('Chat history changed while syncing; retrying…');
            if (r.last < cursor) buffered.clear();
            reset(); resetOnce = true; target = undefined;
            continue;
          }
          target ??= r.last;
          consume(r.events);
          if (cold) first = r.firstSeq ?? r.events[0]?.seq ?? 0;
          noteWindow(r.logFirst);
          log.loaded = true;
          // These are authoritative even if the relevant status or permission
          // events fell outside the retained window. Apply before newer pushes.
          if (log.last >= r.last) {
            log.pending = r.pending ?? [];
            if (r.session?.status) log.status = r.session.status;
          }
          publish();
          if (!r.hasMore || log.last >= target) break;
          if (log.last <= cursor) throw new Error('Chat history did not advance; retrying…');
        }
        setError(''); setSyncing(false); retryDelay = 1000;
        dirty = true;
        persist();
      } catch (e: any) {
        failed = true;
        if (!stopped) { setError(e.message); scheduleRetry(); }
      } finally {
        fetching = false;
        if (!stopped && !failed) drain();
      }
    };

    const renew = async () => {
      try {
        const r = await client.rpc<{ last: number; status?: string }>(env, 'session.watch', { id: sessionId, watchId }, 10_000);
        if (!stopped && initialized && (!log.loaded || r.last !== log.last || (r.status && r.status !== log.status))) void refresh();
      } catch { if (!stopped) scheduleRetry(); }
    };
    const catchUp = () => { if (!stopped) { void renew(); void refresh(); } };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') persist();
      else catchUp();
    };
    const off = client.on((machine, kind, payload: any) => {
      if (stopped) return;
      if (kind === 'session.event' && machine === env && payload?.id === sessionId) {
        for (const event of payload.events ?? []) buffered.set(event.seq, event);
        drain();
      }
      if ((kind === 'connection' && payload?.online)
        || (machine === env && ((kind === 'presence' && payload?.online) || kind === 'transport'))) catchUp();
      if (machine === env && kind === 'session.update' && payload?.session?.id === sessionId
        && (payload.session.lastSeq > log.last || payload.session.status !== log.status)) void refresh();
    });
    client.subscribe(env);
    void renew();
    // Cache reads may be slower than pushes. Do not let either overwrite the
    // other: hydrate the cache first, then history, then buffered live events.
    void loadCached(env, sessionId).then((cached) => {
      if (stopped) return;
      if (cached?.events.length) {
        consume([...cached.events].sort((a, b) => a.seq - b.seq));
        if (!log.turns.length) reset();
        else { log.loaded = true; first = cached.first || cached.events[0].seq; publish(); }
      }
      initialized = true;
      void refresh();
    });

    const loadEarlier = async () => {
      if (stopped || pagingBack || !first) return;
      pagingBack = true; setLoadingEarlier(true);
      const version = windowVersion;
      try {
        const r = await client.rpc<History>(env, 'session.events', { id: sessionId, before: first }, 30_000);
        if (stopped || version !== windowVersion) return;
        if (!r.events.length) { setEarlier(false); return; }
        first = r.firstSeq ?? r.events[0].seq;
        noteWindow(r.logFirst);
        raw = [...new Map([...r.events, ...raw].map(e => [e.seq, e])).values()].sort((a, b) => a.seq - b.seq);
        const rebuilt = emptyLog();
        for (const event of raw) apply(rebuilt, event);
        rebuilt.loaded = log.loaded; rebuilt.pending = log.pending; rebuilt.status = log.status;
        log = rebuilt;
        dirty = true; publish(); persist();
      } catch (e: any) { if (!stopped) setError(e.message); }
      finally { pagingBack = false; if (!stopped) setLoadingEarlier(false); }
    };
    actions.current = { refresh, earlier: loadEarlier };
    const timer = setInterval(() => { if (!document.hidden) void renew(); }, RENEW_MS);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', catchUp);
    window.addEventListener('pageshow', catchUp);
    window.addEventListener('online', catchUp);
    window.addEventListener('pagehide', persist);
    return () => {
      stopped = true;
      off(); clearInterval(timer); clearTimeout(paint); clearTimeout(retry);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', catchUp);
      window.removeEventListener('pageshow', catchUp);
      window.removeEventListener('online', catchUp);
      window.removeEventListener('pagehide', persist);
      persist();
      void client.rpc(env, 'session.unwatch', { id: sessionId, watchId }, 5000).catch(() => {});
    };
  }, [client, env, sessionId]);

  const refresh = useCallback(() => actions.current.refresh(), []);
  const loadEarlier = useCallback(() => actions.current.earlier(), []);
  return { log: state, error, syncing, earlier, loadingEarlier, loadEarlier, refresh };
}
