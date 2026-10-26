import { errorMessage } from './errors';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Client, Environment, Session } from './client';
import { loadWorkspace, loadWorkspaceDurable, saveWorkspace, updateWorkspaceSession, workspaceScope } from './workspaceCache';
import { useLiveInterval } from './useLiveInterval';

/**
 * Keep the old objects when a fresh list holds the same data. Chat lists
 * and machine checks mostly bring back what is here, and new objects
 * redraw the whole app.
 */
function keepUnchanged<T extends { id: string }>(old: T[] | undefined, fresh: T[]) {
  if (!old?.length) return fresh;
  const before = new Map(old.map((item) => [item.id, item]));
  let same = old.length === fresh.length;
  const next = fresh.map((item, index) => {
    const was = before.get(item.id);
    const kept = was && JSON.stringify(was) === JSON.stringify(item) ? was : item;
    if (kept !== old[index]) same = false;
    return kept;
  });
  return same ? old : next;
}

function sameSession(known: Session, update: Session) {
  if (JSON.stringify(known.recovery) !== JSON.stringify(update.recovery)) return false;
  for (const [key, value] of Object.entries(update)) {
    const was = (known as unknown as Record<string, unknown>)[key];
    if (was === value) continue;
    if (value && typeof value === 'object' && JSON.stringify(was) === JSON.stringify(value)) continue;
    return false;
  }
  return true;
}

export function useWorkspaceData(client: Client, connected: boolean) {
  const scope = workspaceScope(client.token);
  const active = useRef(true);
  const [cached] = useState(() => loadWorkspace(scope));
  const [envs, setEnvs] = useState<Environment[]>(() => cached.environments.map((env) => ({ ...env, online: false })));
  const [sessions, setSessions] = useState<Record<string, Session[]>>(cached.sessions);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const [envError, setEnvError] = useState('');
  const liveEnvsSeen = useRef(false);
  const liveListsSeen = useRef(new Set<string>());
  const sessionRequests = useRef(new Set<string>());
  const envRequest = useRef(false);
  const envAgain = useRef(false);
  const relist = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const listRetries = useRef<Record<string, number>>({});
  const pushedDuringList = useRef<Record<string, Map<string, Session>>>({});
  const listAgain = useRef(new Set<string>());
  const [restoredView, setRestoredView] = useState<typeof cached.view>();

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      for (const timer of Object.values(relist.current)) clearTimeout(timer);
    };
  }, [client]);

  useEffect(() => {
    let stale = false;
    void loadWorkspaceDurable(scope).then((value) => {
      if (stale) return;
      if (!liveEnvsSeen.current) setEnvs(value.environments.map((env) => ({ ...env, online: false })));
      setSessions((current) => ({
        ...Object.fromEntries(Object.entries(value.sessions).filter(([id]) => !liveListsSeen.current.has(id))),
        ...current,
      }));
      setRestoredView(value.view);
    });
    return () => { stale = true; };
  }, [scope]);

  const loadEnvs = useCallback((): void => {
    if (!active.current) return;
    if (envRequest.current) { envAgain.current = true; return; }
    envRequest.current = true;
    client.environments()
      .then((result) => {
        if (!active.current) return;
        liveEnvsSeen.current = true;
        setEnvs((current) => keepUnchanged(current, result.environments));
        setEnvError('');
        saveWorkspace(scope, { environments: result.environments });
      })
      .catch((error) => { if (active.current) setEnvError(errorMessage(error)); })
      .finally(() => {
        envRequest.current = false;
        const again = envAgain.current;
        envAgain.current = false;
        if (again && active.current) loadEnvs();
      });
  }, [client, scope]);

  const recordSession = useCallback((envId: string, update: Session) => {
    const during = pushedDuringList.current[envId];
    if (during) during.set(update.id, { ...during.get(update.id), ...update, recovery: update.recovery });
    setSessions((all) => {
      const list = all[envId];
      const known = list?.find((session) => session.id === update.id);
      if (!known || sameSession(known, update)) return all;
      return { ...all, [envId]: list!.map((session) => session === known
        ? { ...session, ...update, recovery: update.recovery } : session) };
    });
    updateWorkspaceSession(scope, envId, update);
  }, [scope]);

  const loadSessions = useCallback((envId: string) => {
    if (!active.current) return;
    if (sessionRequests.current.has(envId)) { listAgain.current.add(envId); return; }
    sessionRequests.current.add(envId);
    const pushed = new Map<string, Session>();
    pushedDuringList.current[envId] = pushed;
    client.rpc<{ sessions: Session[] }>(envId, 'session.list', { includeDetected: true }, 15_000)
      .then((result) => {
        if (!active.current) return;
        liveListsSeen.current.add(envId);
        delete listRetries.current[envId];
        const list = pushed.size
          ? result.sessions.map((session) => {
            const update = pushed.get(session.id);
            return update ? { ...session, ...update, recovery: update.recovery } : session;
          })
          : result.sessions;
        setSessions((current) => ({ ...current, [envId]: keepUnchanged(current[envId], list) }));
        saveWorkspace(scope, { sessions: { [envId]: list } });
      })
      .catch(() => {
        const tries = listRetries.current[envId] = (listRetries.current[envId] ?? 0) + 1;
        if (!liveListsSeen.current.has(envId) && tries <= 20) {
          clearTimeout(relist.current[envId]);
          relist.current[envId] = setTimeout(() => loadSessions(envId), 3000);
        }
      })
      .finally(() => {
        sessionRequests.current.delete(envId);
        if (pushedDuringList.current[envId] === pushed) delete pushedDuringList.current[envId];
        if (listAgain.current.delete(envId) && active.current) loadSessions(envId);
      });
  }, [client, scope]);

  const scheduleSessionReload = useCallback((envId: string, delay: number) => {
    clearTimeout(relist.current[envId]);
    relist.current[envId] = setTimeout(() => loadSessions(envId), delay);
  }, [loadSessions]);

  const setPresence = useCallback((envId: string, online: boolean, name?: string) => {
    setEnvs((list) => list.map((env) => env.id === envId
      ? { ...env, online, name: name ?? env.name } : env));
  }, []);
  const removeSession = useCallback((envId: string, sessionId: string) => {
    setSessions((all) => ({
      ...all,
      [envId]: (all[envId] ?? []).filter((session) => session.id !== sessionId),
    }));
  }, []);
  const markVoice = useCallback((envIds: string[]) => {
    setEnvs((list) => list.map((env) => envIds.includes(env.id)
      ? { ...env, info: { ...env.info, voice: true } } : env));
  }, []);

  useEffect(() => {
    loadEnvs();
    return client.on((envId, kind, payload) => {
      if (kind === 'presence') {
        if (envId && payload?.env) setPresence(envId, !!payload.online, payload.name);
        else loadEnvs();
      }
      if (kind === 'connection' && (payload.online || payload.reachable)) loadEnvs();
      if (kind !== 'session.update' || !envId) return;
      const update = payload?.session as Session | undefined;
      if (update?.id) {
        recordSession(envId, update);
        const known = sessionsRef.current[envId]?.find((session) => session.id === update.id);
        const helper = !!update.delegation?.parentId && !update.unhomed;
        const changesList = !liveListsSeen.current.has(envId) || !update.id || !!update.movedTo
          || update.status === 'exited'
          || (known ? !!known.archived !== !!update.archived : !helper);
        if (changesList) scheduleSessionReload(envId, 400);
      } else scheduleSessionReload(envId, 400);
    });
  }, [client, loadEnvs, loadSessions, recordSession, scheduleSessionReload, setPresence]);
  useEffect(() => {
    const catchUp = () => { if (!document.hidden) loadEnvs(); };
    window.addEventListener('focus', catchUp);
    window.addEventListener('online', catchUp);
    window.addEventListener('pageshow', catchUp);
    document.addEventListener('visibilitychange', catchUp);
    return () => {
      window.removeEventListener('focus', catchUp);
      window.removeEventListener('online', catchUp);
      window.removeEventListener('pageshow', catchUp);
      document.removeEventListener('visibilitychange', catchUp);
    };
  }, [loadEnvs]);

  const liveIds = envs.filter((env) => env.online).map((env) => env.id).join(',');
  useEffect(() => {
    let stopped = false, checking = false;
    const check = async () => {
      if (checking || document.hidden || !connected) return;
      checking = true;
      try {
        await Promise.all((liveIds ? liveIds.split(',') : []).map(async (id) => {
          try {
            const info = await client.rpc<Environment['info']>(id, 'env.info', {}, 8000);
            if (!stopped && info.version) setEnvs((list) => keepUnchanged(list, list.map((env) => env.id === id
              ? { ...env, info: { ...env.info, ...info } } : env)));
          } catch { /* keep the last known version through a reconnect */ }
        }));
      } finally { checking = false; }
    };
    void check();
    const timer = setInterval(() => { void check(); }, 60_000);
    window.addEventListener('online', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      stopped = true; clearInterval(timer);
      window.removeEventListener('online', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [client, liveIds, connected]);

  useEffect(() => {
    const live = liveIds ? liveIds.split(',') : [];
    for (const id of live) { client.subscribe(id); loadSessions(id); }
  }, [liveIds, client, loadSessions, connected]);
  useLiveInterval(30_000, () => {
    const live = liveIds ? liveIds.split(',') : [];
    for (const id of live) loadSessions(id);
  }, [liveIds, loadSessions]);

  return {
    cached, envs, sessions, loadEnvs, loadSessions, recordSession, envError,
    liveEnvsSeen, liveListsSeen, restoredView, removeSession, markVoice,
  };
}
