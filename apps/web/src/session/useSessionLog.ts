import { errorMessage } from '../errors';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Client } from '../client';
import { apply, emptyLog, type HelmEvent, type LogState, type Permission } from './types';
import { loadCached, saveCached } from './logCache';

const TAIL = 200;
const CATCH_UP = 1000;
const CATCH_UP_PAGES = 10;
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

/**
 * Open at the latest work, then fetch the rest of the chat behind it, one
 * page at a time. The owner reads whole chats on the phone to learn from
 * them, so the history must not stop at the first screen; the device keeps
 * what it has fetched (logCache), and the next open only adds what is new.
 */
export function useSessionLog(client: Client, env: string, sessionId: string, { wholeChat = true } = {}) {
  const [state, setState] = useState<LogState>(emptyLog);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(true);
  const [earlier, setEarlier] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const actions = useRef({ refresh: async () => {}, earlier: async () => {} });

  useEffect(() => {
    let stopped = false, fetching = false, pagingBack = false, renewing = false, refreshAgain = false;
    let log = emptyLog(), raw: HelmEvent[] = [], first = 0, windowVersion = 0, visibilityVersion = 0;
    let needsPaint = false;
    let dirty = false, retryDelay = 1000, urgentPaint = false;
    let paint: ReturnType<typeof setTimeout> | undefined;
    let writer: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let networkRead = false, more = false, filling = false, logFirst = 0, liveVersion = 0;
    let stale = true, fetchVersion = 0;
    let updateCheck: ReturnType<typeof setTimeout> | undefined;
    let announced: { lastSeq: number; status?: string } | undefined;
    let watchTarget: { last: number; status?: string } | undefined;
    const buffered = new Map<number, HelmEvent>();
    const watchId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const visible = () => !stopped && !document.hidden;
    setState(log); setError(''); setSyncing(true); setEarlier(false); setLoadingEarlier(false);

    const publish = () => {
      clearTimeout(paint); paint = undefined; urgentPaint = false;
      if (visible()) { needsPaint = false; setState({ ...log, pending: [...log.pending] }); }
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
      dirty = true; needsPaint = true;
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
    const noteWindow = (front?: number) => {
      if (front) logFirst = front;
      more = !!logFirst && !!first && logFirst < first; setEarlier(more);
    };
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
      if (!visible() || !log.loaded) return;
      const next: HelmEvent[] = [];
      for (const event of [...buffered.values()].sort((a, b) => a.seq - b.seq)) {
        if (event.seq <= log.last) { buffered.delete(event.seq); continue; }
        if (event.seq !== log.last + 1) { if (next.length) changed(next); if (!fetching) void refresh(); return; }
        consume([event]); liveVersion++; buffered.delete(event.seq); next.push(event);
      }
      if (next.length) changed(next);
    };

    // A chat already on screen asks only for what came after it: each focus
    // and reconnect sent the last TAIL events again, many times a reply on a
    // slow link. A gap of a few pages is read page by page: opening at the
    // end instead drops the history behind it, and the reader who was up
    // there lands at the front of the new window. Only a reset log or a very
    // long gap opens at the end.
    const read = async (): Promise<History> => {
      if (log.loaded && log.last > 0) {
        const after = log.last;
        const events: HelmEvent[] = [];
        for (let page = 0; page < CATCH_UP_PAGES; page++) {
          const since = events.at(-1)?.seq ?? after;
          const r = await client.rpc<History>(env, 'session.events', { id: sessionId, since, limit: CATCH_UP }, 20_000);
          const joins = r.last === since ? !r.events.length : r.events[0]?.seq === since + 1;
          if (!joins || r.events.some(event => event.type === 'history.reset')) break;
          events.push(...r.events);
          if (!r.hasMore && (events.at(-1)?.seq ?? after) === r.last) return { ...r, events, firstSeq: after + 1 };
          if (!r.events.length) break;
        }
      }
      return client.rpc<History>(env, 'session.events', { id: sessionId, tail: TAIL }, 20_000);
    };

    const refresh = async () => {
      if (!visible()) return;
      if (fetching) { refreshAgain = true; return; }
      fetching = true; networkRead = true; refreshAgain = false; stale = true; fetchVersion = visibilityVersion;
      const version = visibilityVersion, liveAtStart = liveVersion, lastAtStart = log.last;
      clearTimeout(retry); retry = undefined;
      setSyncing(true);
      let failed = false;
      try {
        // A saved cursor is not a request to replay an unattended chat.
        // One tail read serves cold opens, reconnects, and live gaps alike.
        const r = await read();
        if (!visible() || version !== visibilityVersion) return;
        // Live replies may have passed this snapshot while it travelled.
        // Keep them. A lower server cursor from before this request is still
        // a real reset and must replace the old log.
        const liveAhead = liveVersion !== liveAtStart && r.last >= lastAtStart && r.last < log.last;
        const livePending = log.pending;
        const boundary = r.firstSeq ?? r.events[0]?.seq ?? 0;
        const overlap = log.loaded && (r.last >= log.last || liveAhead) && boundary <= log.last + 1;
        // A catch-up read during a reply mostly repeats what is on screen.
        // Rebuilding then made every message a new object and redrew a long
        // chat whole, many times a reply. When no event already here gained
        // anything, only the new ones are applied.
        let fresh: HelmEvent[] | null = null;
        if (!overlap) {
          raw = [...r.events]; first = boundary; windowVersion++;
        } else {
          const bySeq = new Map(raw.map(event => [event.seq, event]));
          const added: HelmEvent[] = [];
          let altered = false;
          for (const event of r.events) {
            const old = bySeq.get(event.seq);
            if (!old) { added.push(event); bySeq.set(event.seq, event); continue; }
            const merged = mergeEvent(old, event);
            if (!altered && JSON.stringify(merged) !== JSON.stringify(old)) altered = true;
            bySeq.set(event.seq, merged);
          }
          raw = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
          if (!altered && added.every(event => event.seq > log.last && event.type !== 'history.reset')) fresh = added.sort((a, b) => a.seq - b.seq);
        }
        if (r.last < log.last && !liveAhead) buffered.clear();
        if (fresh && (r.last >= log.last || liveAhead)) { for (const event of fresh) apply(log, event); }
        else rebuild();
        log.loaded = true;
        if (liveAhead) {
          const resolved = new Set(raw.filter(e => e.type === 'permission.resolved').map(e => e.requestId));
          log.pending = [...new Map([...(r.pending ?? []), ...livePending].map(p => [p.requestId, p])).values()]
            .filter(p => !resolved.has(p.requestId));
        } else log.pending = r.pending ?? [];
        if (r.session?.status && !(liveAhead && raw.some(e => e.seq > r.last && e.type === 'status'))) log.status = r.session.status;
        noteWindow(r.logFirst); publish();
        stale = false; setError(''); setSyncing(false); retryDelay = 1000;
        dirty = true; persist();
        void fill();
      } catch (e: any) {
        failed = true;
        if (visible() && version === visibilityVersion) { setError(errorMessage(e)); scheduleRetry(); }
      } finally {
        fetching = false;
        if (visible()) {
          if (!failed) drain();
          const target = watchTarget; watchTarget = undefined;
          if (target && (target.last > log.last || target.last < lastAtStart
            || (target.last === log.last && target.status && target.status !== log.status))) refreshAgain = true;
          if (refreshAgain) { refreshAgain = false; void refresh(); }
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
        else if (version === visibilityVersion) {
          const changed = !log.loaded || r.last !== log.last || (r.status && r.status !== log.status);
          if (fetching) { if (changed) watchTarget = r; }
          else if (stale || changed) void refresh();
        }
      } catch { if (visible()) scheduleRetry(); }
      finally {
        renewing = false;
        if (visible() && version !== visibilityVersion) void renew();
      }
    };
    const catchUp = () => {
      if (!visible()) return;
      // A route notice is not evidence of missing messages. The small watch
      // reply tells us whether history changed before we download it again.
      if (needsPaint) publish();
      if (log.loaded && !stale) void fill();
      void renew();
      if ((!log.loaded || stale) && !fetching) void refresh();
      else if (fetching && fetchVersion !== visibilityVersion) refreshAgain = true;
    };
    const hide = () => {
      visibilityVersion++; buffered.clear(); persist();
      clearTimeout(paint); paint = undefined; urgentPaint = false;
      clearTimeout(retry); retry = undefined;
      clearTimeout(updateCheck); updateCheck = undefined;
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
      if (machine === env && kind === 'session.update' && payload?.session?.id === sessionId) {
        announced = payload.session;
        // The list notice can beat the same chat's live events. Give them
        // time to arrive before downloading history for an apparent gap.
        if (!updateCheck) updateCheck = setTimeout(() => {
          updateCheck = undefined;
          if (visible() && announced && (announced.lastSeq > log.last
            || (announced.lastSeq === log.last && announced.status && announced.status !== log.status))) void refresh();
        }, 1000);
      }
    });
    client.subscribe(env);
    // Cached text can paint offline. It never controls the network cursor,
    // and a slow cache read cannot replace the fresh tail after it arrives.
    const cacheRead = loadCached(env, sessionId).then(cached => {
      if (stopped || !cached?.events.length) return;
      // The network won the race. The saved copy can still supply the part
      // of the chat in front of the fresh window, so it is not fetched again.
      if (networkRead && log.loaded) {
        const older = cached.events.filter(event => event.seq < first);
        const front = cached.first || cached.events[0].seq;
        if (!older.length || front >= first || cached.last < first - 1 || pagingBack) return;
        raw = [...older, ...raw].sort((a, b) => a.seq - b.seq);
        first = front;
        const { loaded, pending, status } = log;
        rebuild(); Object.assign(log, { loaded, pending, status });
        noteWindow(); publish();
        return;
      }
      if (raw.length) return;
      consume([...cached.events].sort((a, b) => a.seq - b.seq));
      if (!log.turns.length) { raw = []; log = emptyLog(); return; }
      log.loaded = true; first = cached.first || cached.events[0].seq; publish();
    }).catch(() => {});
    catchUp();

    const loadEarlier = async (quiet = false) => {
      if (!visible() || pagingBack || !first) return false;
      pagingBack = true; setLoadingEarlier(true);
      const version = windowVersion;
      try {
        const r = await client.rpc<History>(env, 'session.events', { id: sessionId, before: first, ...(quiet ? { pageBytes: 1_000_000 } : {}) }, 30_000);
        if (!visible() || version !== windowVersion) return false;
        setError('');
        if (!r.events.length) { more = false; setEarlier(false); return false; }
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
        return true;
      } catch (e: any) { if (visible() && !quiet) setError(errorMessage(e)); return false; }
      finally { pagingBack = false; if (!stopped) setLoadingEarlier(false); }
    };
    // Page back until the machine has nothing older. One page at a time, so
    // live updates never wait behind history; a failed page stops quietly
    // and the next open or return to the chat carries on from there.
    const fill = async () => {
      if (filling || !wholeChat) return;
      filling = true;
      try {
        // The saved copy may already hold the older part; reading 2 MB of it
        // takes a slow phone seconds, and fetching it again would waste them.
        await cacheRead;
        while (visible() && more) {
          const from = first;
          if (!await loadEarlier(true) || first === from) break;
        }
      } finally { filling = false; }
    };
    // A tap that works after a failed background page carries the rest on.
    actions.current = { refresh, earlier: async () => { if (await loadEarlier()) void fill(); } };
    const timer = setInterval(() => { if (visible()) void renew(); }, RENEW_MS);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', catchUp);
    window.addEventListener('pageshow', catchUp);
    window.addEventListener('online', catchUp);
    window.addEventListener('pagehide', hide);
    return () => {
      stopped = true;
      off(); clearInterval(timer); clearTimeout(paint); clearTimeout(retry); clearTimeout(updateCheck);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', catchUp);
      window.removeEventListener('pageshow', catchUp);
      window.removeEventListener('online', catchUp);
      window.removeEventListener('pagehide', hide);
      persist(); release();
    };
  }, [client, env, sessionId, wholeChat]);

  const refresh = useCallback(() => actions.current.refresh(), []);
  const loadEarlier = useCallback(() => actions.current.earlier(), []);
  return { log: state, error, syncing, earlier, loadingEarlier, loadEarlier, refresh };
}
