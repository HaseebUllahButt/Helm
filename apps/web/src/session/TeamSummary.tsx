import { errorMessage } from '../errors';
import { useEffect, useState } from 'react';
import { Client, type Session } from '../client';
import { EngineMark } from '../EngineMark';
import { useNow } from '../useNow';

type TeamMember = { session: Session; depth: number };

/** The helpers under `parentId`, nested, as the team card lists them. */
function teamOf(sessions: Iterable<Session>, parentId: string): TeamMember[] {
  const list = [...sessions];
  const team: TeamMember[] = [];
  const visited = new Set([parentId]);
  const collect = (id: string, depth: number) => {
    for (const session of list.filter((candidate) => !candidate.archived && candidate.delegation?.parentId === id)) {
      if (visited.has(session.id)) continue;
      visited.add(session.id);
      team.push({ session, depth });
      collect(session.id, depth + 1);
    }
  };
  collect(parentId, 0);
  return team;
}

/**
 * Every chat on the machine reports here, so the whole inventory is kept
 * outside React: only a change to this chat's own helpers draws the screen
 * again. An unrelated chat's status used to redraw the open chat each time.
 */
export function useThreadTeam(client: Client, envId: string, parentId: string) {
  const [team, setTeam] = useState<TeamMember[]>([]);
  useEffect(() => {
    let stale = false;
    const updates = new Map<string, { version: number; session: Session }>();
    let version = 0;
    let request = 0;
    let all = new Map<string, Session>();
    let shown = '[]';
    setTeam([]);
    const publish = () => {
      const next = teamOf(all.values(), parentId);
      const key = JSON.stringify(next);
      if (key === shown) return;
      shown = key;
      setTeam(next);
    };
    const load = () => {
      const requestedVersion = version;
      const requested = ++request;
      return client.rpc<{ sessions: Session[] }>(envId, 'session.list', { includeDelegations: true })
      .then((result) => {
        if (!stale && requested === request) {
          const merged = new Map((result.sessions ?? []).map((session) => [session.id, session]));
          for (const [id, update] of updates) if (update.version > requestedVersion) merged.set(id, update.session);
          all = new Map([...merged].filter(([, session]) => session.status !== 'exited'));
          publish();
        }
      }).catch(() => {});
    };
    void load();
    const off = client.on((machine, kind, payload: any) => {
      if (kind === 'connection' && payload?.online) void load();
      if (machine === envId && kind === 'session.update' && payload?.session) {
        updates.set(payload.session.id, { version: ++version, session: payload.session });
        all.delete(payload.session.id);
        if (payload.session.status !== 'exited') all.set(payload.session.id, payload.session);
        publish();
      }
      if (machine === envId && kind === 'session.exit') void load();
    });
    return () => { stale = true; off(); };
  }, [client, envId, parentId]);
  return team;
}

const stateOf = (session: Session) => session.delegation?.status ?? session.status;
const names: Record<string, string> = { working: 'Working', starting: 'Starting', blocked: 'Needs approval', done: 'Finished', error: 'Failed', interrupted: 'Stopped', idle: 'Ready' };

export function TeamSummary({ team, onManage, onOpen, onReview, onStop }: {
  team: { session: Session; depth: number }[]; onManage: () => void; onOpen?: (session: Session) => void;
  onReview?: () => void; onStop: () => void;
}) {
  const now = useNow();
  if (!team.length) return null;
  const working = team.filter(({ session }) => ['working', 'starting'].includes(stateOf(session))).length;
  const blocked = team.filter(({ session }) => stateOf(session) === 'blocked').length;
  const failed = team.filter(({ session }) => stateOf(session) === 'error').length;
  const summary = [working && `${working} working`, blocked && `${blocked} need approval`, failed && `${failed} failed`, !working && !blocked && !failed && `${team.length} finished`].filter(Boolean).join(' · ');
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
          <span className={`team-state state-${state}`}>{names[state] || state}</span>
        </button>
        {result && <p className="team-result">{result}</p>}
      </li>;
    })}</ul>
  </details>;
}
