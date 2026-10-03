import { useCallback, useEffect, useState } from 'react';
import type { Client, Environment, Session } from '../client';
import { Diff } from './Transcript';
import { GitGraph } from './GitGraph';
import { BackIcon, Icon } from '../Icon';
import { Route } from '../Route';

/**
 * What the agent has done to the folder, as git sees it: which files, how much,
 * and each one's diff on tap, with a way to tick off the ones you have read.
 *
 * It is asked of the machine (`git.status`), not reconstructed from the
 * transcript, so it also covers what a shell command changed and what happened
 * before this device was looking.
 */

export interface GitFile { path: string; status: 'M' | 'A' | 'D' | 'R' | '?'; staged: boolean; add: number; del: number }
export interface GitStatus {
  repo: boolean; root?: string; branch?: string | null; upstream?: string | null;
  ahead?: number; behind?: number; worktree?: boolean;
  head?: { commit: string; subject: string } | null;
  files?: GitFile[]; more?: number;
}
interface PullRequest { number: number; title: string; url: string; state: string; draft: boolean; review: string | null }

/** The folder's git state, refreshed when `key` changes - a turn ending is the usual reason. */
export function useGitStatus(client: Client, env: Environment, cwd: string, key: string) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const load = useCallback(() => {
    if (!env.online || !cwd) return;
    client.rpc<GitStatus>(env.id, 'git.status', { cwd }, 20_000).then(setStatus).catch(() => {});
  }, [client, env.id, env.online, cwd]);
  useEffect(load, [load, key]);
  return { status, reload: load };
}

const viewedKey = (envId: string, root: string) => `helm.viewed:${envId}:${root}`;
const signature = (f: GitFile) => `${f.status}:${f.add}:${f.del}`;
const readViewed = (k: string): Record<string, string> => { try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch { return {}; } };

/** A diff without its file headers - the path is already on the row above it. */
const hunksOnly = (text: string) => {
  const at = text.search(/^@@/m);
  return at > 0 ? text.slice(at) : text;
};

const splitPath = (p: string) => {
  const i = p.lastIndexOf('/');
  return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i + 1), name: p.slice(i + 1) };
};

export function ChangesPanel({ client, env, cwd, status, reload, onClose, onOpen }: {
  client: Client; env: Environment; cwd: string; status: GitStatus; reload: () => void; onClose: () => void;
  onOpen?: (s: Session) => void;
}) {
  // The badge that opened this counted changed files, so that is where it
  // lands; with nothing changed the graph is the news. Either is one tab away.
  const [tab, setTab] = useState<'graph' | 'changes'>(() => ((status.files?.length ?? 0) + (status.more ?? 0) > 0 ? 'changes' : 'graph'));
  const [refresh, setRefresh] = useState(0);
  const files = status.files ?? [];
  const key = viewedKey(env.id, status.root ?? cwd);
  const [viewed, setViewed] = useState<Record<string, string>>(() => readViewed(key));
  const [open, setOpen] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, { text: string; truncated: boolean } | 'loading' | 'failed'>>({});
  const [pr, setPr] = useState<PullRequest | null>(null);

  useEffect(() => {
    let stale = false;
    client.rpc<{ pr: PullRequest | null }>(env.id, 'git.pr', { cwd }, 20_000)
      .then((r) => { if (!stale) setPr(r.pr); }).catch(() => {});
    return () => { stale = true; };
  }, [client, env.id, cwd, status.branch]);

  const isViewed = (f: GitFile) => viewed[f.path] === signature(f);
  const toggleViewed = (f: GitFile) => {
    const next = { ...viewed };
    if (isViewed(f)) delete next[f.path]; else next[f.path] = signature(f);
    setViewed(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* full */ }
  };

  const expand = (f: GitFile) => {
    const path = f.path;
    setOpen((o) => (o === path ? null : path));
    const cached = diffs[path];
    if (cached && cached !== 'failed') return;
    setDiffs((d) => ({ ...d, [path]: 'loading' }));
    client.rpc<{ diff: string; truncated: boolean }>(env.id, 'git.diff', { cwd, path }, 20_000)
      .then((r) => setDiffs((d) => ({ ...d, [path]: { text: hunksOnly(r.diff), truncated: r.truncated } })))
      .catch(() => setDiffs((d) => ({ ...d, [path]: 'failed' })));
  };

  const add = files.reduce((n, f) => n + f.add, 0);
  const del = files.reduce((n, f) => n + f.del, 0);
  const seen = files.filter(isViewed).length;

  return (
    <div className="changes">
      <div className="bar">
        <button className="iconbtn back" aria-label="Back to the conversation" onClick={onClose}><BackIcon /></button>
        <div className="titles">
          <h1>Git</h1>
          <span className="sub">
            <Route machine={env.name} folder={cwd} />
            <span className="sep"> · </span>{status.branch ?? 'detached'}
            {status.worktree ? ' · worktree' : ''}
            {status.ahead ? ` · ↑${status.ahead}` : ''}{status.behind ? ` · ↓${status.behind}` : ''}
          </span>
        </div>
        <button className="iconbtn" title="Refresh Git" aria-label="Refresh Git" onClick={() => { reload(); setRefresh((n) => n + 1); }}><Icon name="refresh" size={17} /></button>
      </div>
      <div className="git-tabs" role="tablist" aria-label="Git views" onKeyDown={(e) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const next = e.key === 'Home' ? 'graph' : e.key === 'End' ? 'changes' : tab === 'graph' ? 'changes' : 'graph';
        setTab(next); document.getElementById(`git-${next}-tab`)?.focus();
      }}>
        <button id="git-graph-tab" role="tab" tabIndex={tab === 'graph' ? 0 : -1} aria-selected={tab === 'graph'} aria-controls="git-graph-panel" onClick={() => setTab('graph')}>Graph</button>
        <button id="git-changes-tab" role="tab" tabIndex={tab === 'changes' ? 0 : -1} aria-selected={tab === 'changes'} aria-controls="git-changes-panel" onClick={() => setTab('changes')}>Changes <span>{files.length + (status.more ?? 0)}</span></button>
      </div>
      <div className="scroll"><div className="pad column">
        {tab === 'graph' ? <div id="git-graph-panel" role="tabpanel" aria-labelledby="git-graph-tab">
          <GitGraph client={client} env={env} cwd={cwd} refreshKey={`${status.head?.commit}:${refresh}`} onOpen={onOpen} />
        </div> : <div id="git-changes-panel" role="tabpanel" aria-labelledby="git-changes-tab">
        {pr && (
          <a className="pr" href={pr.url} target="_blank" rel="noreferrer">
            <span className={`pr-state ${pr.draft ? 'draft' : pr.state.toLowerCase()}`}>{pr.draft ? 'draft' : pr.state.toLowerCase()}</span>
            <span className="grow"><b>#{pr.number}</b> {pr.title}</span>
            <span className="chev"><Icon name="forward" size={15} /></span>
          </a>
        )}

        {files.length === 0 ? (
          <div className="empty quiet">
            Nothing changed since the last commit
            {status.head && <div className="note mono">{status.head.commit} · {status.head.subject}</div>}
          </div>
        ) : (
          <>
            <div className="changes-sum">
              {files.length} file{files.length === 1 ? '' : 's'}
              <span className="add">+{add}</span><span className="del">−{del}</span>
              <span className="grow" />
              <span className="quiet">{seen}/{files.length} viewed</span>
            </div>
            <div className="rows plain">
              {files.map((f) => {
                const { dir, name } = splitPath(f.path);
                const d = diffs[f.path];
                return (
                  <div key={f.path} className={`fileRow${isViewed(f) ? ' viewed' : ''}`}>
                    <div className="row tall">
                      <button className="rowmain filemain" onClick={() => expand(f)} aria-expanded={open === f.path}>
                        <span className={`gst s${f.status === '?' ? 'u' : f.status}`}>{f.status === '?' ? 'U' : f.status}</span>
                        <span className="grow">
                          <span className="rt"><span className="rt-text">{name}</span></span>
                          <span className="rm">{dir || './'}</span>
                        </span>
                        <span className="gcount"><i className="add">+{f.add}</i> <i className="del">−{f.del}</i></span>
                      </button>
                      <button
                        className={`viewedbox${isViewed(f) ? ' on' : ''}`} onClick={() => toggleViewed(f)}
                        aria-pressed={isViewed(f)} aria-label={`mark ${f.path} as viewed`} title="viewed"
                      >{isViewed(f) && <Icon name="check" size={15} />}</button>
                    </div>
                    {open === f.path && (
                      <div className="filediff">
                        {d === 'loading' || !d ? <div className="empty quiet">reading…</div>
                          : d === 'failed' ? <div className="empty quiet">could not read this diff</div>
                          : <>
                              <Diff text={d.text || '(no textual changes)'} />
                              {d.truncated && <div className="note">the rest is too long to show here</div>}
                            </>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {!!status.more && <div className="note">and {status.more} more files</div>}
          </>
        )}
        </div>}
      </div></div>
    </div>
  );
}
