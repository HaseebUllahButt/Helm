import { errorMessage } from '../errors';
import { useEffect, useReducer, useRef, useState } from 'react';
import { Client, type Session } from '../client';
import { EngineMark } from '../EngineMark';
import { useNow } from '../useNow';

/** `envId`: a helper that runs on another machine (helm delegate --machine). */
export type TeamMember = { session: Session; depth: number; envId?: string };

/** Read the tree by chat ID and machine. Account names and titles are not keys. */
export function useThreadTeam(client: Client, envId: string, parentId: string, remote: NonNullable<Session['remoteHelpers']> = []) {
  const remoteKey = JSON.stringify(remote);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [, refreshRoutes] = useReducer(revision => revision + 1, 0);
  const offlineMachines = useRef(new Set<string>()).current;
  useEffect(() => {
    let stale = false;
    let loading = false;
    let again = false;
    let version = 0;
    const updates = new Map<string, { version: number; session: Session }>();
    const known = new Set([`${envId}/${parentId}`]);
    const knownMachines = new Set([envId]);
    const markOffline = (member: TeamMember) => member.envId && offlineMachines.has(member.envId) && !member.session.offline
      ? { ...member, session: { ...member.session, offline: true } } : member;
    // Until the first full read, an update is kept for it and not shown alone:
    // a list with one helper looks complete and hides the one that failed.
    let published = false;
    const load = async () => {
      if (loading) { again = true; return; }
      loading = true;
      const loadVersion = version;
      const next: TeamMember[] = [];
      const offlineFallbacks = new Set<string>();
      const publish = () => {
        if (stale) return;
        const extra = [...updates].filter(([key, update]) => update.version > loadVersion
          && !next.some((m) => `${m.envId}/${m.session.id}` === key))
          .map(([key, update]) => ({ session: update.session, envId: key.split('/')[0], depth: Math.max(0, (update.session.delegation?.depth ?? 1) - 1) }));
        const rows = [...next, ...extra].map((m) => {
          const key = `${m.envId}/${m.session.id}`;
          const update = updates.get(key);
          if (!update || update.version <= loadVersion) return m;
          offlineFallbacks.delete(key);
          return { ...m, session: update.session };
        }).filter((m) => !m.session.archived).map(markOffline);
        const ordered: TeamMember[] = [];
        const used = new Set<string>();
        const visit = (host: string, id: string) => {
          for (const member of rows) {
            const key = `${member.envId}/${member.session.id}`;
            if (used.has(key) || member.session.delegation?.parentId !== id
              || (member.session.delegation.parentMachine || member.envId) !== host) continue;
            used.add(key); ordered.push(member);
            visit(member.envId ?? envId, member.session.id);
          }
        };
        visit(envId, parentId);
        published = true;
        setTeam(previous => {
          if (!offlineFallbacks.size) return ordered;
          const knownRows = new Map(previous.map(m => [`${m.envId}/${m.session.id}`, m.session]));
          return ordered.map(member => {
            const key = `${member.envId}/${member.session.id}`;
            const last = offlineFallbacks.has(key) && knownRows.get(key);
            return last ? { ...member, session: { ...last, offline: true } } : member;
          });
        });
      };
      const reads = new Map<string, Promise<Session[]>>();
      const read = (machine: string, id: string) => {
        knownMachines.add(machine);
        const key = `${machine}/${id}`;
        if (!reads.has(key)) reads.set(key, client.rpc<{ sessions: Session[] }>(machine, 'session.list', { parentId: id, nested: true }).then((r) => r.sessions ?? []));
        return reads.get(key)!;
      };
      const visited = new Set([`${envId}/${parentId}`]);
      const collect = async (machine: string, id: string, depth: number, hints: NonNullable<Session['remoteHelpers']> = []) => {
        client.subscribe?.(machine);
        let rows: Session[] = [];
        try { rows = await read(machine, id); }
        catch { /* Keep the last known cards when a machine cannot answer. */ }
        const walk = async (host: string, owner: string, level: number, list: Session[], links: NonNullable<Session['remoteHelpers']>) => {
          const children = list.filter((s) => !s.archived && s.delegation?.parentId === owner
            && (!s.delegation.parentMachine || s.delegation.parentMachine === host));
          const add = async (session: Session, where: string, available: Session[]) => {
            const key = `${where}/${session.id}`;
            if (visited.has(key)) return;
            visited.add(key); known.add(key);
            next.push({ session, depth: level, envId: where });
            await walk(where, session.id, level + 1, available, session.remoteHelpers ?? []);
          };
          await Promise.all([
            ...children.map((child) => add(child, host, list)),
            ...links.filter((h) => !h.archived).map(async (link) => {
            client.subscribe?.(link.machine);
            let found: Session[] = [];
            let answered = false;
            try { found = await read(link.machine, owner); answered = true; }
            catch { /* The saved state remains visible offline. */ }
            const child = found.find((s) => s.id === link.id && s.delegation?.parentMachine === host);
            const offline = !link.removed && (!answered || offlineMachines.has(link.machine));
            const removed = !offline && (answered || link.removed);
            if (!child && offline) offlineFallbacks.add(`${link.machine}/${link.id}`);
            await add(child ?? { ...link.result?.session, id: link.id, title: link.title || 'Helper', status: removed ? 'interrupted' : link.status || 'idle', engine: link.result?.session?.engine || '', cwd: link.result?.session?.cwd || '', profileId: link.result?.session?.profileId || '', offline, removed,
              team: removed ? undefined : link.team, delegation: { parentId: owner, parentMachine: host, status: removed ? 'interrupted' : link.status, task: '', depth: level + 1 } } as unknown as Session, link.machine, found);
          })]);
        };
        await walk(machine, id, depth, rows, hints);
      };
      try {
        await collect(envId, parentId, 0, JSON.parse(remoteKey));
        publish();
      } finally {
        loading = false;
        if (again && !stale) { again = false; void load(); }
      }
    };
    void load();
    const off = client.on((machine, kind, payload: any) => {
      const session = payload?.session as Session | undefined;
      if (kind === 'connection' || (kind === 'transport' && knownMachines.has(machine))) refreshRoutes();
      if (kind === 'presence' && machine) {
        if (payload?.online === false) {
          offlineMachines.add(machine);
          if (knownMachines.has(machine)) setTeam(now => now.map(markOffline));
        } else if (payload?.online === true) {
          offlineMachines.delete(machine);
          if (knownMachines.has(machine)) void load();
        }
      }
      if (kind === 'connection' && payload?.online || kind === 'session.exit') void load();
      if (kind === 'session.update' && session) {
        const key = `${machine}/${session.id}`;
        updates.set(key, { version: ++version, session });
        const owner = `${session.delegation?.parentMachine || machine}/${session.delegation?.parentId}`;
        if (key === `${envId}/${parentId}`) void load();
        else if (known.has(key) || known.has(owner)) {
          known.add(key);
          if (!published) return;
          setTeam((now) => {
            const previous = now.find((m) => m.envId === machine && m.session.id === session.id);
            const parent = now.find((m) => `${m.envId}/${m.session.id}` === owner);
            return [...now.filter((m) => !(m.envId === machine && m.session.id === session.id)),
              ...(!session.archived ? [markOffline({ session, envId: machine, depth: previous?.depth ?? (parent ? parent.depth + 1 : 0) })] : [])];
          });
          if (session.remoteHelpers?.length) void load();
        }
      }
    });
    // Older machines and lost broadcasts must also converge to the CLI state.
    const timer = setInterval(() => void load(), 5000);
    return () => { stale = true; clearInterval(timer); off(); };
  }, [client, envId, parentId, remoteKey, offlineMachines]);
  if (client.connected !== false) return team;
  return team.map(member => member.session.offline || client.directTo?.(member.envId ?? envId)
    ? member : { ...member, session: { ...member.session, offline: true } });
}

export const helperState = (session: Session) => {
  const state = session.delegation?.status ?? session.status;
  return ['done', 'idle'].includes(state) && !!(session.team?.working || session.team?.blocked)
    ? 'waiting' : state;
};

const stateOf = helperState;
const names: Record<string, string> = { working: 'Working', starting: 'Starting', blocked: 'Needs approval', waiting: 'Waiting for its helpers', done: 'Done', error: 'Failed', interrupted: 'Stopped', idle: 'Ready' };

export function TeamSummary({ team, onManage, onOpen, onReview, onStop }: {
  team: { session: Session; depth: number }[]; onManage: () => void; onOpen?: (session: Session) => void;
  onReview?: () => void; onStop: () => void;
}) {
  const now = useNow();
  if (!team.length) return null;
  const online = team.filter(({ session }) => !session.offline);
  const offline = team.length - online.length;
  const working = online.filter(({ session }) => ['working', 'starting', 'waiting'].includes(stateOf(session))).length;
  const blocked = online.filter(({ session }) => stateOf(session) === 'blocked').length;
  const failed = online.filter(({ session }) => stateOf(session) === 'error').length;
  const finished = online.length - working - blocked - failed;
  const summary = [working && `${working} working`, blocked && `${blocked} need approval`, failed && `${failed} failed`,
    offline && `${offline} offline`, finished && `${finished} finished`].filter(Boolean).join(' · ');
  return <details className={`team-summary${blocked || failed ? ' needs-attention' : ''}`}>
    <summary><strong>Team</strong><span>{summary}</span></summary>
    <div className="team-actions">
      <button onClick={onManage}>Manage tasks</button>
      {onReview && <button onClick={onReview}>Review changes</button>}
      {!!(working || blocked) && <button className="destructive" onClick={onStop}>Stop all</button>}
    </div>
    <ul>{team.map(({ session, depth }) => {
      const state = stateOf(session);
      const finished = session.delegation?.finishedAt;
      const elapsed = Math.max(0, Math.floor(((finished || now) - (session.createdAt || now)) / 60000));
      const result = session.delegation?.summary || (session.recovery?.message ? errorMessage(session.recovery.message) : undefined);
      return <li key={session.id} style={{ marginLeft: Math.min(depth, 3) * 14 }}>
        <button className="team-task" onClick={() => onOpen ? onOpen(session) : onManage()}>
          <EngineMark engine={session.engine} /><span className="team-task-copy"><b>{session.title}</b><small>{session.model || session.engineModel || session.engine} · {elapsed < 1 ? '<1m' : `${elapsed}m`}</small></span>
          <span className={`team-state state-${session.offline ? 'idle' : state}`}>{session.offline ? 'Last seen: ' : ''}{names[state] || state}</span>
        </button>
        {result && <p className="team-result">{result}</p>}
      </li>;
    })}</ul>
  </details>;
}
