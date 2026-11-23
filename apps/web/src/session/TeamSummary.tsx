import { errorMessage } from '../errors';
import { useEffect, useRef, useState } from 'react';
import { Client, type Session } from '../client';
import { EngineMark } from '../EngineMark';
import { useNow } from '../useNow';

/** `envId`: a helper that runs on another machine (helm delegate --machine). */
export type TeamMember = { session: Session; depth: number; envId?: string };

type TeamRead = { sessions: Session[]; offline: boolean };

/** Read the tree by chat ID and machine. Account names and titles are not keys. */
export function useThreadTeam(client: Client, envId: string, parentId: string, remote: NonNullable<Session['remoteHelpers']> = []) {
  const remoteKey = JSON.stringify(remote);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const remembered = useRef<TeamMember[]>([]);
  const offlineMachines = useRef(new Set<string>()).current;
  useEffect(() => {
    let stale = false;
    let loading = false;
    let again = false;
    let version = 0;
    let published = false;
    const updates = new Map<string, { version: number; session: Session }>();
    const known = new Set([`${envId}/${parentId}`]);
    const knownMachines = new Set([envId]);
    const keyOf = (member: TeamMember) => `${member.envId}/${member.session.id}`;
    const markOffline = (member: TeamMember) => member.envId && offlineMachines.has(member.envId) && !member.session.offline
      ? { ...member, session: { ...member.session, offline: true } } : member;
    const publish = (members: TeamMember[]) => {
      remembered.current = members;
      setTeam(members.map(markOffline));
    };
    const load = async () => {
      if (loading) { again = true; return; }
      loading = true;
      const loadVersion = version;
      const reads = new Map<string, Promise<TeamRead>>();
      const read = (machine: string, id: string) => {
        knownMachines.add(machine);
        const key = `${machine}/${id}`;
        if (!reads.has(key)) {
          const fetchList = async (): Promise<TeamRead> => {
            try {
              client.subscribe?.(machine);
              const { sessions } = await client.rpc<{ sessions: Session[] }>(machine, 'session.list', { parentId: id, nested: true });
              return { sessions: sessions ?? [], offline: false };
            } catch {
              return { sessions: remembered.current.filter(m => m.envId === machine).map(m => m.session), offline: true };
            }
          };
          reads.set(key, fetchList());
        }
        return reads.get(key)!;
      };
      const visited = new Set([`${envId}/${parentId}`]);
      const walk = async (host: string, owner: string, depth: number, list: TeamRead, links: NonNullable<Session['remoteHelpers']>): Promise<TeamMember[]> => {
        const add = async (session: Session, machine: string, source: TeamRead): Promise<TeamMember[]> => {
          const key = `${machine}/${session.id}`;
          if (visited.has(key) || session.archived) return [];
          visited.add(key); known.add(key);
          const row = source.offline && !session.removed ? { ...session, offline: true } : session;
          // Walk saved rows too. A helper farther down can still answer on its own machine.
          const nested = session.removed ? [] : await walk(machine, session.id, depth + 1, source, session.remoteHelpers ?? []);
          return [{ session: row, depth, envId: machine }, ...nested];
        };
        const children = list.sessions.filter(s => s.delegation?.parentId === owner
          && (!s.delegation.parentMachine || s.delegation.parentMachine === host));
        const branches = await Promise.all([
          ...children.map(child => add(child, host, list)),
          ...links.filter(link => !link.archived).map(async link => {
            const source = await read(link.machine, owner);
            const child = source.sessions.find(s => s.id === link.id && s.delegation?.parentMachine === host);
            if (child && !(source.offline && link.removed)) return add(child, link.machine, source);
            const removed = !source.offline || !!link.removed;
            const status = removed ? 'interrupted' : link.status || 'idle';
            return add({ ...link.result?.session, id: link.id, title: link.title || 'Helper', status,
              engine: link.result?.session?.engine || '', cwd: link.result?.session?.cwd || '', profileId: link.result?.session?.profileId || '',
              offline: !removed && source.offline, removed, team: removed ? undefined : link.team,
              delegation: { parentId: owner, parentMachine: host, status, task: '', depth: depth + 1 },
            } as Session, link.machine, source);
          }),
        ]);
        return branches.flat();
      };
      try {
        const rows = await walk(envId, parentId, 0, await read(envId, parentId), JSON.parse(remoteKey));
        if (stale) return;
        const next = new Map(rows.map(row => [keyOf(row), row]));
        for (const [key, update] of updates) {
          if (update.version <= loadVersion) continue;
          const row = next.get(key);
          if (row) next.set(key, { ...row, session: update.session });
          else next.set(key, { session: update.session, envId: key.split('/')[0], depth: Math.max(0, (update.session.delegation?.depth ?? 1) - 1) });
        }
        published = true;
        publish([...next.values()].filter(m => !m.session.archived));
      } finally {
        loading = false;
        if (again && !stale) { again = false; void load(); }
      }
    };
    void load();
    const off = client.on((machine, kind, payload: any) => {
      if (kind === 'presence' && machine) {
        if (payload?.online === false) {
          offlineMachines.add(machine);
          if (knownMachines.has(machine)) setTeam(remembered.current.map(markOffline));
        } else if (payload?.online === true) {
          offlineMachines.delete(machine);
          if (knownMachines.has(machine)) void load();
        }
      }
      if ((kind === 'connection' && payload?.online) || kind === 'session.exit') void load();
      const session = kind === 'session.update' ? payload?.session as Session | undefined : undefined;
      if (!session) return;
      const key = `${machine}/${session.id}`;
      const owner = `${session.delegation?.parentMachine || machine}/${session.delegation?.parentId}`;
      if (key === `${envId}/${parentId}`) void load();
      else if (known.has(key) || known.has(owner)) {
        known.add(key);
        updates.set(key, { version: ++version, session });
        // Wait for the first list before showing changes to individual helpers.
        if (!published) return;
        const previous = remembered.current.find(m => keyOf(m) === key);
        const parent = remembered.current.find(m => keyOf(m) === owner);
        const member = { session, envId: machine, depth: previous?.depth ?? (parent ? parent.depth + 1 : 0) };
        publish([...remembered.current.filter(m => keyOf(m) !== key), ...(!session.archived ? [member] : [])]);
        if (session.remoteHelpers?.length) void load();
      }
    });
    // Older machines and lost broadcasts must also converge to the CLI state.
    const timer = setInterval(() => void load(), 5000);
    return () => { stale = true; clearInterval(timer); off(); };
  }, [client, envId, parentId, remoteKey, offlineMachines]);
  return team;
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
