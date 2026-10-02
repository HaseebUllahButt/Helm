import { useEffect, useMemo, useRef, useState } from 'react';
import type { Client, Environment, Session } from '../client';
import { EngineMark } from '../EngineMark';
import { Icon } from '../Icon';
import { agentLabel } from '@helm/protocol/notifications';
import { Diff } from './Transcript';

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
  /** Remote names (`origin`), so `origin/main` reads as a remote and `feature/x` as a branch. */
  remotes?: string[];
}
interface CommitDetail {
  hash: string; parents: string[]; author: string; date: string; subject: string; body: string;
  files: { path: string; add: number; del: number }[];
  diff?: string; truncated?: boolean;
}

/** How many colours the lanes cycle through; each has a `.lc-N` class. */
const COLOURS = 8;
const ROW = 44;
const MID = ROW / 2;
const GAP = 14;
const lx = (n: number) => 9 + n * GAP;

export interface GraphEdge { from: number; to: number; colour: number; pass: boolean }
export interface GraphRow {
  commit: GitCommit;
  /** The column this commit's dot sits in, and that column's colour. */
  lane: number; colour: number;
  /** Whether a newer commit's line comes down into this one. */
  incoming: boolean;
  /** The commits each column is waiting for, above and below this row. */
  before: string[]; after: string[];
  edges: GraphEdge[];
}

/**
 * Lay commits (newest first, topological) out in columns.
 *
 * Each column follows one line of history and keeps its colour for as long as
 * it lives: a commit hands its column to its first parent, so a branch stays
 * one straight line of one colour. A merge's other parents open new columns
 * beside it; a line whose next commit is already followed elsewhere joins
 * that column and ends.
 */
export function graphRows(commits: GitCommit[]): GraphRow[] {
  let lanes: { hash: string; colour: number }[] = [];
  let next = 0;
  return commits.map((commit) => {
    let lane = lanes.findIndex((l) => l.hash === commit.hash);
    const incoming = lane !== -1;
    if (!incoming) {
      lanes.push({ hash: commit.hash, colour: next++ % COLOURS });
      lane = lanes.length - 1;
    }
    const before = lanes;
    const colour = before[lane].colour;
    const after = [...before];
    const [first, ...others] = commit.parents;
    const taken = first ? after.findIndex((l, i) => i !== lane && l.hash === first) : -1;
    if (!first || (taken !== -1 && taken < lane)) {
      // The parent is already followed further left: this line joins it.
      after.splice(lane, 1);
    } else {
      // Ours, or followed by a side line to the right - the line on the left
      // wins, so the mainline stays straight and one colour, and the side
      // line bends into it.
      after[lane] = { hash: first, colour };
      if (taken !== -1) after.splice(taken, 1);
    }
    let at = Math.min(after[lane]?.hash === first ? lane + 1 : lane, after.length);
    for (const p of others) {
      if (!after.some((l) => l.hash === p)) after.splice(at++, 0, { hash: p, colour: next++ % COLOURS });
    }
    const edges: GraphEdge[] = [];
    before.forEach((l, i) => {
      if (i === lane) return;
      edges.push({ from: i, to: after.findIndex((a) => a.hash === l.hash), colour: l.colour, pass: true });
    });
    for (const p of commit.parents) {
      const to = after.findIndex((a) => a.hash === p);
      if (to >= 0) edges.push({ from: lane, to, colour: p === first && to === lane ? colour : after[to].colour, pass: false });
    }
    lanes = after;
    return {
      commit, lane, colour, incoming,
      before: before.map((l) => l.hash), after: after.map((l) => l.hash), edges,
    };
  });
}

type Ref = { name: string; kind: 'head' | 'branch' | 'remote' | 'tag' | 'detached'; synced?: boolean };

/** `HEAD -> main`, `origin/main`, `tag: v1` into labelled pills, a branch and its remote copy folded together. */
export function parseRefs(refs: string[], remotes: string[] = ['origin']): Ref[] {
  const out: Ref[] = [];
  for (const raw of refs) {
    if (raw === 'HEAD') out.push({ name: 'HEAD', kind: 'detached' });
    else if (raw.startsWith('HEAD -> ')) out.push({ name: raw.slice(8), kind: 'head' });
    else if (raw.startsWith('tag: ')) out.push({ name: raw.slice(5), kind: 'tag' });
    else if (remotes.some((r) => raw.startsWith(`${r}/`))) {
      if (!raw.endsWith('/HEAD')) out.push({ name: raw, kind: 'remote' });
    } else out.push({ name: raw, kind: 'branch' });
  }
  // `main` and `origin/main` on one commit are one fact: up to date.
  return out.filter((r) => {
    if (r.kind !== 'remote') return true;
    const local = out.find((l) => (l.kind === 'branch' || l.kind === 'head') && r.name.endsWith(`/${l.name}`));
    if (local) { local.synced = true; return false; }
    return true;
  }).sort((a, b) => ['head', 'detached', 'branch', 'tag', 'remote'].indexOf(a.kind) - ['head', 'detached', 'branch', 'tag', 'remote'].indexOf(b.kind));
}

/** "now", "5m", "3h", "4d", then a date. */
export function shortAge(iso: string, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d`;
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: '2-digit' } : {}) });
}

const stateLabel = (s: Session['status']) => s === 'working' ? 'Working' : s === 'blocked' ? 'Needs you' : s === 'idle' ? 'Ready' : s;
const folderName = (path: string) => path.split('/').filter(Boolean).pop() || path;

/** One row's slice of the picture: lines from the row above, the dot, lines on to the row below. */
function Lanes({ row, width, head }: { row: GraphRow; width: number; head: boolean }) {
  const { lane, colour, incoming, edges } = row;
  const x = lx(lane);
  const merge = row.commit.parents.length > 1;
  return (
    <svg width={width} height={ROW} viewBox={`0 0 ${width} ${ROW}`} className="git-lanes" aria-hidden="true">
      {edges.filter((e) => e.pass).map((e, i) => {
        const a = lx(e.from), b = lx(e.to);
        return <path key={`p${i}`} className={`lc-${e.colour}`}
          d={a === b ? `M${a} 0V${ROW}` : `M${a} 0V${MID - 8}C${a} ${MID + 4} ${b} ${MID - 4} ${b} ${MID + 8}V${ROW}`} />;
      })}
      {incoming && <path className={`lc-${colour}`} d={`M${x} 0V${MID}`} />}
      {edges.filter((e) => !e.pass).map((e, i) => {
        const b = lx(e.to);
        return <path key={`c${i}`} className={`lc-${e.colour}`}
          d={b === x ? `M${x} ${MID}V${ROW}` : `M${x} ${MID}C${x} ${MID + 14} ${b} ${MID + 6} ${b} ${ROW}`} />;
      })}
      {head && <circle cx={x} cy={MID} r={8} className={`git-halo lc-${colour}`} />}
      <circle cx={x} cy={MID} r={merge ? 3.5 : 4.5} className={`git-dot lc-${colour}${merge ? ' merge' : ''}`} />
    </svg>
  );
}

/** The lines that carry on past an opened commit, stretched to the height of its details. */
function Through({ row, width }: { row: GraphRow; width: number }) {
  const colours = new Map<string, number>();
  row.edges.forEach((e) => { if (e.to >= 0) colours.set(row.after[e.to], e.colour); });
  return (
    <svg className="git-through" width={width} height="100%" viewBox={`0 0 ${width} 10`} preserveAspectRatio="none" aria-hidden="true">
      {row.after.map((hash, i) => <path key={hash} className={`lc-${colours.get(hash) ?? 0}`} d={`M${lx(i)} 0V10`} />)}
    </svg>
  );
}

export function GitGraph({ client, env, cwd, refreshKey, onOpen }: {
  client: Client; env: Environment; cwd: string; refreshKey: string; onOpen?: (s: Session) => void;
}) {
  const [data, setData] = useState<GitGraphData | null>(null);
  const [error, setError] = useState('');
  const [openHash, setOpenHash] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, CommitDetail | 'loading' | { error: string }>>({});
  const [fileDiff, setFileDiff] = useState<{ hash: string; path: string; diff: string | null; truncated?: boolean; error?: string } | null>(null);
  const [copied, setCopied] = useState('');
  const list = useRef<HTMLDivElement>(null);

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
  const lanes = Math.min(10, Math.max(1, ...rows.map((r) => Math.max(r.before.length, r.after.length))));
  const width = lx(lanes - 1) + 10;
  const current = data?.worktrees.find((w) => w.current);
  const liveAgents = data?.worktrees.reduce((n, w) => n + w.agents.length, 0) ?? 0;

  const open = async (agent: GitAgent) => {
    if (!onOpen) return;
    try {
      const r = await client.rpc<{ sessions: Session[] }>(env.id, 'session.list');
      const session = r.sessions.find((s) => s.id === agent.id);
      if (session) onOpen(session); else setError('This agent has closed. Refresh to update the graph.');
    } catch (e: any) { setError(e.message); }
  };

  const toggle = (hash: string) => {
    setFileDiff(null);
    if (openHash === hash) { setOpenHash(null); return; }
    setOpenHash(hash);
    const have = details[hash];
    if (have && have !== 'loading' && !('error' in have)) return;
    setDetails((d) => ({ ...d, [hash]: 'loading' }));
    client.rpc<CommitDetail>(env.id, 'git.commit', { cwd, hash }, 20_000)
      .then((r) => setDetails((d) => ({ ...d, [hash]: r })))
      .catch((e: any) => setDetails((d) => ({
        ...d,
        [hash]: { error: /unknown|not supported|no handler/i.test(e.message ?? '') ? 'Update helm on this machine to see what a commit changed.' : (e.message || 'Could not read this commit') },
      })));
  };

  const showFile = (hash: string, path: string) => {
    if (fileDiff?.hash === hash && fileDiff.path === path) { setFileDiff(null); return; }
    setFileDiff({ hash, path, diff: null });
    client.rpc<CommitDetail>(env.id, 'git.commit', { cwd, hash, path }, 20_000)
      .then((r) => setFileDiff((f) => f && f.hash === hash && f.path === path
        ? { hash, path, diff: (r.diff ?? '').replace(/^[\s\S]*?(?=^@@)/m, ''), truncated: r.truncated } : f))
      .catch((e: any) => setFileDiff((f) => f && f.hash === hash && f.path === path ? { hash, path, diff: '', error: e.message } : f));
  };

  const jump = (hash: string) => {
    const el = list.current?.querySelector(`[data-hash="${hash}"]`);
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); toggle(hash); }
  };

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(() => { setCopied(text); setTimeout(() => setCopied(''), 1200); }).catch(() => {});
  };

  const agentChip = (agent: GitAgent) => (
    <button key={agent.id} className={`git-agent ${agent.status}`}
      disabled={!onOpen} onClick={(e) => { e.stopPropagation(); void open(agent); }}
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
      {!data && !error && env.online && <div className="git-skeleton" aria-label="Loading Git history">{[0, 1, 2, 3, 4, 5].map((i) => <i key={i} />)}</div>}
      {data && !data.repo && <div className="empty quiet">This folder is not a Git repository.</div>}
      {data?.repo && <>
        {/* Where things are checked out, and who is working in each. */}
        <div className="git-checkouts">
          {data.worktrees.filter((w) => w.current || w.agents.length).map((w) => (
            <div key={w.path} className={`git-checkout${w.current ? ' current' : ''}`}>
              <div className="git-checkout-head">
                <Icon name="branch" size={15} />
                <b>{w.branch || (w.head ? `detached at ${w.head.slice(0, 7)}` : 'no commits yet')}</b>
                {w.current && <span className="tag">this chat</span>}
                <small title={w.path}>{folderName(w.path)}</small>
              </div>
              {w.agents.length > 0 && <div className="git-agents">{w.agents.map(agentChip)}</div>}
              {w.agents.length > 1 && <div className="git-shared">{w.agents.length} agents share this folder, so their edits can collide.</div>}
            </div>
          ))}
          {liveAgents === 0 && <div className="git-none">No agents are working in this repository right now.</div>}
        </div>

        {!rows.length && <div className="empty quiet">Your first commit will appear here.</div>}
        {!!rows.length && <div className="git-history" ref={list} aria-label="Commit history, newest first">
          {rows.map((row) => {
            const { commit } = row;
            const refs = parseRefs(commit.refs, data.remotes);
            const agents = data.worktrees.filter((w) => w.head === commit.hash).flatMap((w) => w.agents);
            const isHead = current?.head === commit.hash;
            const expanded = openHash === commit.hash;
            const d = details[commit.hash];
            return <div key={commit.hash} className={`git-row${expanded ? ' open' : ''}${isHead ? ' head' : ''}`} data-hash={commit.hash}>
              <button className="git-line" onClick={() => toggle(commit.hash)} aria-expanded={expanded}
                aria-label={`${commit.subject}, ${commit.author}, ${shortAge(commit.date)}`}>
                <Lanes row={row} width={width} head={isHead} />
                <span className="git-text">
                  <span className="git-subject">
                    {refs.map((r) => (
                      <span key={r.kind + r.name} className={`git-ref ${r.kind} lc-${row.colour}`} title={r.synced ? `${r.name}, same as the remote` : r.name}>
                        {r.kind === 'tag' ? <Icon name="tag" size={11} /> : r.kind === 'remote' ? <Icon name="cloud" size={11} /> : null}
                        {r.name}{r.synced && <Icon name="cloud" size={11} />}
                      </span>
                    ))}
                    <span className="git-subject-text">{commit.subject}</span>
                  </span>
                  <span className="git-meta">
                    <code>{commit.hash.slice(0, 7)}</code>
                    <span className="git-author">{commit.author}</span>
                    <span>{shortAge(commit.date)}</span>
                  </span>
                </span>
                {agents.length > 0 && (
                  <span className="git-row-agents">
                    {agents.slice(0, 3).map((a) => <span key={a.id} className={`git-mini ${a.status}`} title={`${agentLabel(a.engine)} · ${a.title} · ${stateLabel(a.status)}`}><EngineMark engine={a.engine} /><i /></span>)}
                    {agents.length > 3 && <span className="git-more">+{agents.length - 3}</span>}
                  </span>
                )}
              </button>
              {expanded && (
                <div className="git-detail" style={{ paddingLeft: width + 8 }}>
                  <Through row={row} width={width} />
                  {d === 'loading' || !d ? <div className="note">Reading the commit…</div>
                    : 'error' in d ? <div className="note">{d.error}</div>
                    : <>
                      <div className="git-detail-subject">{d.subject}</div>
                      {d.body && <div className="git-detail-body">{d.body}</div>}
                      <div className="git-detail-meta">
                        <button className="git-hash" onClick={() => copy(d.hash)} title="Copy the full hash">
                          <code>{d.hash.slice(0, 12)}</code>{copied === d.hash ? <span>copied</span> : <Icon name="copy" size={12} />}
                        </button>
                        <span>{d.author}</span>
                        <span>{new Date(d.date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                        {d.parents.length > 1 && <span>merge of {d.parents.map((p, i) => <button key={p} className="git-parent" onClick={() => jump(p)}>{i ? ' + ' : ''}{p.slice(0, 7)}</button>)}</span>}
                      </div>
                      {agents.length > 0 && <div className="git-agents">{agents.map(agentChip)}</div>}
                      {d.files.length === 0
                        ? <div className="note">No file changes.</div>
                        : <div className="git-files">
                          <div className="git-files-head">
                            {d.files.length} file{d.files.length === 1 ? '' : 's'}
                            <span className="add">+{d.files.reduce((n, f) => n + f.add, 0)}</span>
                            <span className="del">−{d.files.reduce((n, f) => n + f.del, 0)}</span>
                            {d.parents.length > 1 && <span className="quiet">against the first parent</span>}
                          </div>
                          {d.files.map((f) => {
                            const shown = fileDiff?.hash === d.hash && fileDiff.path === f.path;
                            return <div key={f.path} className="git-file">
                              <button className="git-file-row" onClick={() => showFile(d.hash, f.path)} aria-expanded={shown}>
                                <span className="git-file-path" title={f.path}>
                                  <span className="dir">{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : ''}</span>{f.path.split('/').pop()}
                                </span>
                                <span className="gcount"><i className="add">+{f.add}</i> <i className="del">−{f.del}</i></span>
                              </button>
                              {shown && <div className="filediff">
                                {fileDiff!.error ? <div className="note">{fileDiff!.error}</div>
                                  : fileDiff!.diff === null ? <div className="note">Reading…</div>
                                  : <><Diff text={fileDiff!.diff || '(no text changes)'} />{fileDiff!.truncated && <div className="note">The rest is too long to show here.</div>}</>}
                              </div>}
                            </div>;
                          })}
                        </div>}
                    </>}
                </div>
              )}
            </div>;
          })}
        </div>}
        {data.truncated && <div className="note git-tail">Showing the latest 80 commits.</div>}
      </>}
    </div>
  );
}
