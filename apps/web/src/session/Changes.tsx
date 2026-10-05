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

const STATUS_NAME: Record<GitFile['status'], string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', '?': 'Untracked' };
const TABS = ['graph', 'changes'] as const;
type Tab = typeof TABS[number];

export function ChangesPanel({ client, env, cwd, status, reload, onClose, onOpen, embedded = false, view }: {
  client: Client; env: Environment; cwd: string; status: GitStatus; reload: () => void; onClose: () => void;
  onOpen?: (s: Session) => void;
  /** Inside the thread's details sheet, which has its own close and its own tabs. */
  embedded?: boolean; view?: Tab;
}) {
  // The badge that opened this counted changed files, so that is where it
  // lands; with nothing changed the graph is the news. Either is one tab away.
  const [own, setTab] = useState<Tab>(() => ((status.files?.length ?? 0) + (status.more ?? 0) > 0 ? 'changes' : 'graph'));
  const tab = view ?? own;
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

  const fetchDiff = (path: string) => {
    setDiffs((current) => ({ ...current, [path]: 'loading' }));
    client.rpc<{ diff: string; truncated: boolean }>(env.id, 'git.diff', { cwd, path }, 20_000)
      .then((result) => setDiffs((current) => ({ ...current, [path]: { text: hunksOnly(result.diff), truncated: result.truncated } })))
      .catch(() => setDiffs((current) => ({ ...current, [path]: 'failed' })));
  };

  const expand = (f: GitFile) => {
    const path = f.path;
    setOpen((o) => (o === path ? null : path));
    const cached = diffs[path];
    if (cached && cached !== 'failed') return;
    fetchDiff(path);
  };

  const add = files.reduce((n, f) => n + f.add, 0);
  const del = files.reduce((n, f) => n + f.del, 0);
  const seen = files.filter(isViewed).length;
  const total = files.length + (status.more ?? 0);
  const prState = pr ? (pr.draft ? 'draft' : pr.state.toLowerCase()) : '';
  const sync = [status.ahead ? `${status.ahead} ahead` : '', status.behind ? `${status.behind} behind` : ''].filter(Boolean).join(', ');

  const pick = (next: Tab, focus = false) => {
    setTab(next);
    if (focus) document.getElementById(`git-${next}-tab`)?.focus();
  };

  return (
    <div className={`changes${embedded ? ' embedded' : ''}`}>
      {!embedded && <div className="bar">
        <button className="iconbtn back" aria-label="Back to the conversation" onClick={onClose}><BackIcon /></button>
        <div className="titles">
          <h1>Git</h1>
          <span className="sub"><Route machine={env.name} folder={cwd} /></span>
        </div>
        <button className="iconbtn" title="Refresh Git" aria-label="Refresh Git" onClick={() => { reload(); setRefresh((n) => n + 1); }}><Icon name="refresh" size={17} /></button>
      </div>}
      <div className="git-head"><div className="git-toolbar">
        <div className="git-context">
          <span className="git-branch" title={status.branch ? `On ${status.branch}${status.upstream ? `, tracking ${status.upstream}` : ''}` : 'Detached HEAD'}>
            <Icon name="branch" size={14} />
            <b>{status.branch ?? 'detached'}</b>
          </span>
          {sync && (
            <span className="git-sync" title={`${sync}${status.upstream ? ` of ${status.upstream}` : ''}`} aria-label={sync}>
              {!!status.ahead && <span>↑{status.ahead}</span>}
              {!!status.behind && <span>↓{status.behind}</span>}
            </span>
          )}
          {status.worktree && <span className="git-wt">worktree</span>}
          {embedded && <button className="iconbtn git-refresh" title="Refresh" aria-label="Refresh Git" onClick={() => { reload(); setRefresh((n) => n + 1); }}><Icon name="refresh" size={15} /></button>}
          {pr && (
            <a className="git-pr" href={pr.url} target="_blank" rel="noreferrer" title={`#${pr.number} ${pr.title}`}
              aria-label={`Pull request #${pr.number}, ${prState}: ${pr.title}`}>
              <span className={`pr-state ${prState}`}>{prState}</span>
              <span className="git-pr-title"><b>#{pr.number}</b> {pr.title}</span>
              <Icon name="forward" size={13} />
            </a>
          )}
        </div>
        {!view && <div className="git-tabs" role="tablist" aria-label="Git views" onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          pick(event.key === 'Home' ? 'graph' : event.key === 'End' ? 'changes' : tab === 'graph' ? 'changes' : 'graph', true);
        }}>
          {TABS.map((name) => (
            <button key={name} id={`git-${name}-tab`} role="tab" tabIndex={tab === name ? 0 : -1} aria-selected={tab === name}
              aria-controls={`git-${name}-panel`} onClick={() => pick(name)}>
              {name === 'graph' ? 'Graph' : 'Changes'}
              {name === 'changes' && total > 0 && <>{' '}<span className="git-count">{total}</span></>}
            </button>
          ))}
        </div>}
      </div></div>
      <div className="scroll"><div className="pad column">
        {tab === 'graph' ? <div id="git-graph-panel" role={view ? undefined : 'tabpanel'} aria-labelledby={view ? undefined : 'git-graph-tab'}>
          <GitGraph client={client} env={env} cwd={cwd} refreshKey={`${status.head?.commit}:${refresh}`} onOpen={onOpen} />
        </div> : <div id="git-changes-panel" role={view ? undefined : 'tabpanel'} aria-labelledby={view ? undefined : 'git-changes-tab'}>
        {files.length === 0 ? (
          <div className="git-empty">
            <span className="git-empty-icon ok"><Icon name="check" size={18} /></span>
            <b>Working tree clean</b>
            <span>Nothing changed since the last commit.</span>
            {status.head && <code title={status.head.subject}>{status.head.commit} · {status.head.subject}</code>}
          </div>
        ) : (
          <>
            <div className="changes-sum">
              <span className="changes-count">{files.length} changed file{files.length === 1 ? '' : 's'}</span>
              <span className="gcount"><i className="add">+{add}</i> <i className="del">−{del}</i></span>
              <span className="grow" />
              <span className="changes-seen" aria-label={`${seen} of ${files.length} viewed`}>
                <span className="changes-meter" aria-hidden="true"><i style={{ width: `${(seen / files.length) * 100}%` }} /></span>
                {seen}/{files.length} viewed
              </span>
            </div>
            <div className="rows plain changes-files">
              {files.map((f) => {
                const { dir, name } = splitPath(f.path);
                const d = diffs[f.path];
                const shown = open === f.path;
                return (
                  <div key={f.path} className={`fileRow${isViewed(f) ? ' viewed' : ''}${shown ? ' open' : ''}`}>
                    <div className="row tall">
                      <button className="rowmain filemain" onClick={() => expand(f)} aria-expanded={shown} title={f.path}>
                        <span className={`gst s${f.status === '?' ? 'u' : f.status}`} title={STATUS_NAME[f.status]}>{f.status === '?' ? 'U' : f.status}</span>
                        <span className="grow">
                          <span className="rt"><span className="rt-text">{name}</span></span>
                          <span className="rm">{dir || './'}</span>
                        </span>
                        <span className="gcount"><i className="add">+{f.add}</i> <i className="del">−{f.del}</i></span>
                      </button>
                      <button
                        className={`viewedbox${isViewed(f) ? ' on' : ''}`} onClick={() => toggleViewed(f)}
                        aria-pressed={isViewed(f)} aria-label={`mark ${f.path} as viewed`} title={isViewed(f) ? 'Viewed' : 'Mark as viewed'}
                      ><span>{isViewed(f) && <Icon name="check" size={13} />}</span></button>
                    </div>
                    {shown && (
                      <div className="filediff">
                        {d === 'loading' || !d ? <div className="git-state" role="status">Reading the diff…</div>
                          : d === 'failed' ? <div className="git-state bad" role="status">
                              Could not read this diff.
                              <button className="linkish" onClick={() => fetchDiff(f.path)}>Try again</button>
                            </div>
                          : <>
                              <Diff text={d.text || '(no textual changes)'} />
                              {d.truncated && <div className="git-state">The rest is too long to show here.</div>}
                            </>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {!!status.more && <div className="note git-tail">And {status.more} more files</div>}
          </>
        )}
        </div>}
      </div></div>
    </div>
  );
}
