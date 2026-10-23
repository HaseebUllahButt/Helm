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

/** Sparse tail anchors must not replace richer events from an earlier page. */
function mergeEvent(existing: HelmEvent, incoming: HelmEvent): HelmEvent {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value === '' && merged[key]) continue;
    merged[key] = value;
  }
  return merged;
}

/** Open at the latest work. Fetch older events only when the reader asks. */
export function useSessionLog(client: Client, env: string, sessionId: string) {
  const [state, setState] = useState<LogState>(emptyLog);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(true);
  const [earlier, setEarlier] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const actions = useRef({ refresh: async () => {}, earlier: async () => {} });

  useEffect(() => {
    let stopped = false, fetching = false, pagingBack = false, renewing = false, refreshAgain = false;
    let log = emptyLog(), raw: HelmEvent[] = [], first = 0, windowVersion = 0, visibilityVersion = 0;
    let dirty = false, retryDelay = 1000, urgentPaint = false;
    let paint: ReturnType<typeof setTimeout> | undefined;
    let writer: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let networkRead = false;
    const buffered = new Map<number, HelmEvent>();
    const watchId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const visible = () => !stopped && !document.hidden;
    setState(log); setError(''); setSyncing(true); setEarlier(false); setLoadingEarlier(false);

    const publish = () => {
      clearTimeout(paint); paint = undefined; urgentPaint = false;
      if (visible()) setState({ ...log, pending: [...log.pending] });
    };
    const persist = () => {
      clearTimeout(writer); writer = undefined;
      if (!dirty || !raw.length) return;
      dirty = false;
      void saveCached(env, sessionId, log.last, [...raw], first);
    };
    const readable = (event: HelmEvent) => {
      if (!event.type.startsWith('item.')) return true;
      if (event.kind === 'text' || event.kind === 'error') return true;
      if (event.type !== 'item.delta') return false;
      return log.turns.some(turn => turn.items.some(item => item.id === event.id && item.kind === 'text'));
    };
    const changed = (events: HelmEvent[]) => {
      dirty = true;
      const urgent = events.some(readable);
      // Text can replace a waiting tool redraw. The reducer still sees every
      // event in order; priority changes painting, never conversation order.
      if (urgent && !urgentPaint) { clearTimeout(paint); paint = undefined; urgentPaint = true; }
      paint ??= setTimeout(publish, urgentPaint ? 16 : 150);
      writer ??= setTimeout(persist, 2000);
    };
    const consume = (events: HelmEvent[]) => {
      for (const event of events) {
        if (event.seq <= log.last) continue;
        if (event.type === 'history.reset') { raw = []; first = event.seq; windowVersion++; setEarlier(false); }
        raw.push(event); apply(log, event);
      }
    };
    const noteWindow = (logFirst?: number) => setEarlier(!!logFirst && !!first && logFirst < first);
    const rebuild = () => {
      const next = emptyLog();
      for (const event of raw) apply(next, event);
      log = next;
    };
    const scheduleRetry = () => {
      if (!visible() || retry) return;
      retry = setTimeout(() => { retry = undefined; void refresh(); }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, RENEW_MS);
    };
    const drain = () => {
      if (!visible() || !log.loaded || fetching) return;
      const next: HelmEvent[] = [];
      for (const event of [...buffered.values()].sort((a, b) => a.seq - b.seq)) {
        if (event.seq <= log.last) { buffered.delete(event.seq); continue; }
        if (event.seq !== log.last + 1) { if (next.length) changed(next); void refresh(); return; }
        consume([event]); buffered.delete(event.seq); next.push(event);
      }
      if (next.length) changed(next);
    };

    const refresh = async () => {
      if (!visible()) return;
      if (fetching) { refreshAgain = true; return; }
      fetching = true; networkRead = true; refreshAgain = false;
      const version = visibilityVersion;
      clearTimeout(retry); retry = undefined;
      setSyncing(true);
      let failed = false;
      try {
        // A saved cursor is not a request to replay an unattended chat.
        // One tail read serves cold opens, reconnects, and live gaps alike.
        const r = await client.rpc<History>(env, 'session.events', { id: sessionId, tail: TAIL }, 20_000);
        if (!visible() || version !== visibilityVersion) return;
        const boundary = r.firstSeq ?? r.events[0]?.seq ?? 0;
        const overlap = log.loaded && r.last >= log.last && boundary <= log.last + 1;
        if (!overlap) {
          raw = [...r.events]; first = boundary; windowVersion++;
        } else {
          const bySeq = new Map(raw.map(event => [event.seq, event]));
          for (const event of r.events) {
            const old = bySeq.get(event.seq);
            bySeq.set(event.seq, old ? mergeEvent(old, event) : event);
          }
          raw = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
        }
        if (r.last < log.last) buffered.clear();
        rebuild();
        log.loaded = true; log.pending = r.pending ?? [];
        if (r.session?.status) log.status = r.session.status;
        noteWindow(r.logFirst); publish();
        setError(''); setSyncing(false); retryDelay = 1000;
        dirty = true; persist();
      } catch (e: any) {
        failed = true;
        if (visible() && version === visibilityVersion) { setError(e.message); scheduleRetry(); }
      } finally {
        fetching = false;
        if (visible()) {
          if (refreshAgain) { refreshAgain = false; void refresh(); }
          else if (!failed) drain();
        }
      }
    };
    const release = () => {
      void client.rpc(env, 'session.unwatch', { id: sessionId, watchId }, 5000).catch(() => {});
    };
    const renew = async () => {
      if (!visible() || renewing) return;
      renewing = true;
      const version = visibilityVersion;
      try {
        const r = await client.rpc<{ last: number; status?: string }>(env, 'session.watch', { id: sessionId, watchId }, 10_000);
        if (!visible()) release();
        else if (version === visibilityVersion && !fetching && (!log.loaded || r.last !== log.last || (r.status && r.status !== log.status))) void refresh();
      } catch { if (visible()) scheduleRetry(); }
      finally {
        renewing = false;
        if (visible() && version !== visibilityVersion) void renew();
      }
    };
    const catchUp = () => { if (visible()) { void renew(); void refresh(); } };
    const hide = () => {
      visibilityVersion++; buffered.clear(); persist();
      clearTimeout(paint); paint = undefined; urgentPaint = false;
      clearTimeout(retry); retry = undefined;
      release();
    };
    const onVisibility = () => {
      if (document.hidden) hide();
      else catchUp();
    };
    const off = client.on((machine, kind, payload: any) => {
      if (!visible()) return;
      if (kind === 'session.event' && machine === env && payload?.id === sessionId) {
        for (const event of payload.events ?? []) buffered.set(event.seq, event);
        drain();
      }
      if ((kind === 'connection' && payload?.online)
        || (machine === env && ((kind === 'presence' && payload?.online) || kind === 'transport'))) catchUp();
      if (machine === env && kind === 'session.update' && payload?.session?.id === sessionId
        && !fetching && (payload.session.lastSeq > log.last || payload.session.status !== log.status)) void refresh();
    });
    client.subscribe(env);
    // Cached text can paint offline. It never controls the network cursor,
    // and a slow cache read cannot replace the fresh tail after it arrives.
    void loadCached(env, sessionId).then(cached => {
      if (stopped || networkRead && log.loaded || !cached?.events.length || raw.length) return;
      consume([...cached.events].sort((a, b) => a.seq - b.seq));
      if (!log.turns.length) { raw = []; log = emptyLog(); return; }
      log.loaded = true; first = cached.first || cached.events[0].seq; publish();
    });
    catchUp();

    const loadEarlier = async () => {
      if (!visible() || pagingBack || !first) return;
      pagingBack = true; setLoadingEarlier(true);
      const version = windowVersion;
      try {
        const r = await client.rpc<History>(env, 'session.events', { id: sessionId, before: first }, 30_000);
        if (!visible() || version !== windowVersion) return;
        setError('');
        if (!r.events.length) { setEarlier(false); return; }
        first = r.firstSeq ?? r.events[0].seq;
        noteWindow(r.logFirst);
        const bySeq = new Map(raw.map(event => [event.seq, event]));
        for (const event of r.events) {
          const existing = bySeq.get(event.seq);
          bySeq.set(event.seq, existing ? mergeEvent(existing, event) : event);
        }
        raw = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
        const { loaded, pending, status } = log;
        rebuild(); Object.assign(log, { loaded, pending, status });
        dirty = true; publish(); persist();
      } catch (e: any) { if (visible()) setError(e.message); }
      finally { pagingBack = false; if (!stopped) setLoadingEarlier(false); }
    };
    actions.current = { refresh, earlier: loadEarlier };
    const timer = setInterval(() => { if (visible()) void renew(); }, RENEW_MS);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', catchUp);
    window.addEventListener('pageshow', catchUp);
    window.addEventListener('online', catchUp);
    window.addEventListener('pagehide', hide);
    return () => {
      stopped = true;
      off(); clearInterval(timer); clearTimeout(paint); clearTimeout(retry);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', catchUp);
      window.removeEventListener('pageshow', catchUp);
      window.removeEventListener('online', catchUp);
      window.removeEventListener('pagehide', hide);
      persist(); release();
    };
  }, [client, env, sessionId]);

  const refresh = useCallback(() => actions.current.refresh(), []);
  const loadEarlier = useCallback(() => actions.current.earlier(), []);
  return { log: state, error, syncing, earlier, loadingEarlier, loadEarlier, refresh };
}
