import { useEffect, useMemo, useState } from 'react';
import type { Client, Environment, Session } from '../client';
import { EngineMark } from '../EngineMark';
import { Icon } from '../Icon';
import { agentLabel } from '@helm/protocol/notifications';

export interface GitCommit {
  hash: string; parents: string[]; subject: string; author: string; date: string; refs: string[];
}
interface GitAgent {
  id: string; title: string; engine: string; profileId: string | null; status: Session['status']; cwd: string;
}
interface Checkout {
  path: string; head: string | null; branch: string | null; current: boolean; agents: GitAgent[];
}
export interface GitGraphData {
  repo: boolean; commits: GitCommit[]; worktrees: Checkout[]; truncated?: boolean;
}

/** Each lane is a commit we are still following. Merge parents keep separate lanes until they meet. */
export function graphRows(commits: GitCommit[]) {
  let lanes: string[] = [];
  return commits.map((commit) => {
    if (!lanes.includes(commit.hash)) lanes.push(commit.hash);
    const before = [...lanes];
    const lane = before.indexOf(commit.hash);
    lanes.splice(lane, 1);
    commit.parents.forEach((parent, i) => {
      if (!lanes.includes(parent)) lanes.splice(Math.min(lane + i, lanes.length), 0, parent);
    });
    const edges = before.flatMap((hash, from) => hash === commit.hash
      ? commit.parents.map((parent) => ({ from, to: lanes.indexOf(parent) }))
      : [{ from, to: lanes.indexOf(hash) }]);
    return { commit, lane, before, after: [...lanes], edges };
  });
}

const stateLabel = (s: Session['status']) => s === 'working' ? 'Working' : s === 'blocked' ? 'Needs you' : s === 'idle' ? 'Ready' : s;
const folderName = (path: string) => path.split('/').filter(Boolean).pop() || path;

export function GitGraph({ client, env, cwd, refreshKey, onOpen }: {
  client: Client; env: Environment; cwd: string; refreshKey: string; onOpen?: (s: Session) => void;
}) {
  const [data, setData] = useState<GitGraphData | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let stale = false, inFlight = false;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    setData(null); setError('');
    const load = async () => {
      if (stale || inFlight || !env.online) return;
      inFlight = true;
      try {
        const r = await client.rpc<GitGraphData>(env.id, 'git.graph', { cwd }, 25_000);
        if (!stale) { setData(r); setError(''); }
      } catch (e: any) { if (!stale) setError(e.message || 'Could not load Git history'); }
      finally { inFlight = false; }
    };
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 15_000);
    const off = client.on((id, kind) => {
      if ((id === env.id && ['session.update', 'session.exit'].includes(kind)) || kind === 'connection') {
        clearTimeout(debounce);
        debounce = setTimeout(() => void load(), 600);
      }
    });
    return () => { stale = true; clearInterval(timer); clearTimeout(debounce); off(); };
  }, [client, env.id, env.online, cwd, refreshKey]);
  const rows = useMemo(() => graphRows(data?.commits ?? []), [data]);
  const width = Math.max(1, ...rows.map((r) => Math.max(r.before.length, r.after.length))) * 18 + 12;
  const open = async (agent: GitAgent) => {
    if (!onOpen) return;
    try {
      const r = await client.rpc<{ sessions: Session[] }>(env.id, 'session.list');
      const session = r.sessions.find((s) => s.id === agent.id);
      if (session) onOpen(session); else setError('This agent has closed. Refresh to update the graph.');
    } catch (e: any) { setError(e.message); }
  };
  const agentMarker = (agent: GitAgent, compact = false) => (
    <button key={agent.id} className={`git-agent ${agent.status}${compact ? ' compact' : ''}`}
      disabled={!onOpen} onClick={() => void open(agent)}
      title={[agent.title, agent.profileId, stateLabel(agent.status)].filter(Boolean).join(' · ')}
      aria-label={`Open ${agent.title}, ${stateLabel(agent.status)}`}>
      <EngineMark engine={agent.engine} />
      <span className="git-agent-title"><span className="git-agent-name">{agentLabel(agent.engine)}</span> · {agent.title || 'Untitled chat'}</span>
      <span className="git-agent-state"><i />{stateLabel(agent.status)}</span>
    </button>
  );
  return (
    <div className="git-graph">
      {!env.online && <div className="note">Connect this machine to see its Git history.</div>}
      {error && <div className="error" role="status">{error}</div>}
      {!data && !error && env.online && <div className="empty quiet">Loading Git history…</div>}
      {data && <>
        <div className="git-presence">
          <div className="section">Agents in this repository <span>{data.worktrees.reduce((n, w) => n + w.agents.length, 0)}</span></div>
          {data.worktrees.filter((w) => w.current || w.agents.length).map((w) => (
            <div key={w.path} className={`git-checkout${w.current ? ' current' : ''}`}>
              <div className="git-checkout-head"><span className="git-branch-symbol" aria-hidden="true"><Icon name="branch" size={16} /></span>
                <b>{w.branch || (w.head ? `Detached · ${w.head.slice(0, 7)}` : 'No commits yet')}</b>
                {w.current && <span className="tag">This chat</span>}
                <small title={w.path}>{folderName(w.path)}</small>
              </div>
              <div className="git-agents">{w.agents.length ? w.agents.map((a) => agentMarker(a)) : <span className="note">No live agents here</span>}</div>
              {w.agents.length > 1 && <div className="git-shared">{w.agents.length} agents share this checkout</div>}
            </div>
          ))}
        </div>
        <div className="section">Commit graph</div>
        {!rows.length && <div className="empty quiet">Your first commit will appear here.</div>}
        {!!rows.length && <div className="git-history" tabIndex={0} aria-label="Commit graph, newest first">
          {rows.map(({ commit, lane, before, edges }) => {
            const agents = data.worktrees.filter((w) => w.head === commit.hash).flatMap((w) => w.agents);
            const x = (n: number) => 12 + n * 18;
            return <div className="git-commit" key={commit.hash}>
              <svg width={width} height="72" viewBox={`0 0 ${width} 72`} className="git-lanes" aria-hidden="true">
                {before.map((_, i) => <path key={`top-${i}`} d={`M${x(i)} 0V26`} className={`git-lane lane-${i % 4}`} />)}
                {edges.map((edge, i) => <path key={`edge-${i}`} d={`M${x(edge.from)} 26C${x(edge.from)} 48 ${x(edge.to)} 50 ${x(edge.to)} 72`}
                  className={`git-lane lane-${edge.to % 4}`} />)}
                <circle cx={x(lane)} cy="26" r="4" className={`git-node lane-${lane % 4}`} />
              </svg>
              <div className="git-commit-copy">
                <div className="git-commit-subject" title={commit.subject}>{commit.subject}</div>
                <div className="git-commit-meta"><code>{commit.hash.slice(0, 7)}</code><span>{commit.author}</span>
                  {commit.refs.map((ref) => <span className="git-ref" key={ref}>{ref}</span>)}
                </div>
                {!!agents.length && <div className="git-commit-agents">{agents.map((a) => agentMarker(a, true))}</div>}
              </div>
            </div>;
          })}
        </div>}
        {data.truncated && <div className="note">Showing the latest 80 commits. Lines continuing below lead to older history.</div>}
      </>}
    </div>
  );
}
