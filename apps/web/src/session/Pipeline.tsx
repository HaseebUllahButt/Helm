import { useCallback, useEffect, useRef, useState } from 'react';
import type { Client, Environment } from '../client';
import { Icon } from '../Icon';

export interface PullRequest {
  number: number; title: string; url: string | null; state: string; draft: boolean; review: string | null;
  mergeable: string; mergeState: string; headSha: string; mergedSha: string | null;
}
interface Check { id: string; name: string; state: string; conclusion?: string; url: string | null; summary?: string }
interface Run { id: number; name: string; state: string; conclusion?: string; url: string | null; sha: string; attempt: number; event: string; updatedAt?: string }
interface Deployment { id: number; environment: string; state: string; sha: string; url: string | null; environmentUrl: string | null; description: string }
interface Job { id: number; name: string; state: string; url: string | null; steps: { number: number; name: string; state: string }[] }
export interface PipelineSnapshot {
  supported: boolean; repository?: string; sha?: string; deploymentSha?: string; pr?: PullRequest | null;
  checks?: Check[]; checksState?: string; runs?: Run[]; deployments?: Deployment[]; unpublished?: boolean;
  errors: { section: string; code: string; message: string; retryAt?: number | null }[];
  checkedAt: number; stale?: boolean; retryAt?: number | null; truncated?: boolean; watching?: boolean;
  account?: string;
}

export function usePipeline(client: Client, env: Environment, cwd: string, branch: string | null | undefined, head: string | undefined, sessionId?: string) {
  const [snapshot, setSnapshot] = useState<PipelineSnapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [watchBusy, setWatchBusy] = useState(false);
  const force = useRef(false);
  const refresh = useCallback((clear = false) => { if (clear) setSnapshot(null); force.current = true; setAttempt(n => n + 1); }, []);
  useEffect(() => { setSnapshot(null); setError(''); }, [client, env.id, env.online, cwd, branch, head, sessionId]);
  useEffect(() => {
    let stale = false, busy = false;
    const load = async () => {
      if (stale || busy || !env.online || !cwd) return;
      busy = true; setLoading(true);
      const fresh = force.current; force.current = false;
      try {
        const data = await client.rpc<PipelineSnapshot>(env.id, 'git.monitor', { cwd, force: fresh, sessionId }, 90_000);
        if (!data || typeof data.supported !== 'boolean' || !Array.isArray(data.errors)) throw new Error('This machine does not support CI / CD monitoring yet. Update Helm on it.');
        if (!stale) { setSnapshot(data); setError(''); }
      } catch (e: any) { if (!stale) setError(e.message || 'Could not load GitHub status.'); }
      finally { busy = false; if (!stale) setLoading(false); }
    };
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', visible);
    const off = client.on((id, kind, payload: any) => {
      if (kind === 'connection') { void load(); return; }
      if (id !== env.id) return;
      if (kind === 'git.monitor' && payload.id === sessionId && payload.snapshot?.sha) {
        // A branch switch must not let an older watch overwrite the newly opened checkout.
        if (payload.snapshot.sha.startsWith(head || '') && payload.snapshot.branch === branch) setSnapshot({ ...payload.snapshot, watching: payload.watching });
      }
    });
    return () => { stale = true; clearInterval(timer); document.removeEventListener('visibilitychange', visible); off(); };
  }, [client, env.id, env.online, cwd, branch, head, sessionId, attempt]);
  const watch = async () => {
    if (!sessionId || watchBusy) return;
    setWatchBusy(true);
    try {
      const result = await client.rpc<{ watching: boolean }>(env.id, 'git.watch', { sessionId, on: !snapshot?.watching }, 20_000);
      setSnapshot(s => s ? { ...s, watching: result.watching } : s); setError('');
    } catch (e: any) { setError(e.message || 'Could not change notifications.'); }
    finally { setWatchBusy(false); }
  };
  return { snapshot, error, loading, refresh, watch, watchBusy };
}

const LABELS: Record<string, string> = { success: 'Passed', failure: 'Failed', error: 'Failed', pending: 'Running', queued: 'Queued',
  in_progress: 'Running', cancelled: 'Cancelled', neutral: 'Skipped', inactive: 'Inactive', unknown: 'Unknown', none: 'No checks' };
const label = (state: string) => LABELS[state] || state.replace(/_/g, ' ');
const stateClass = (state: string) => ['failure', 'error'].includes(state) ? 'failure' : ['pending', 'queued', 'in_progress'].includes(state) ? 'pending' : state;
function Status({ state }: { state: string }) { return <span className={`pipeline-state ${stateClass(state)}`}>{label(state)}</span>; }
function External({ url, children }: { url: string | null | undefined; children: React.ReactNode }) {
  return url ? <a href={url} target="_blank" rel="noreferrer">{children}<Icon name="forward" size={12} /></a> : <span>{children}</span>;
}

export function Pipeline({ client, env, cwd, sessionId, data, error, loading, refresh, watch, watchBusy }: {
  client: Client; env: Environment; cwd: string; sessionId?: string; data: PipelineSnapshot | null; error: string;
  loading: boolean; refresh: (clear?: boolean) => void; watch: () => void; watchBusy: boolean;
}) {
  const [jobs, setJobs] = useState<Record<number, { jobs: Job[]; truncated?: boolean } | 'loading' | 'failed'>>({});
  const [open, setOpen] = useState<number | null>(null);
  const identity = useRef(0);
  const [accounts, setAccounts] = useState<{ selected: string; accounts: { login: string; active: boolean; valid: boolean }[] } | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState('');
  useEffect(() => {
    let stale = false; setAccounts(null); setAccountError('');
    if (data?.supported && env.online) client.rpc<typeof accounts>(env.id, 'git.accounts', { cwd }, 20_000)
      .then(value => { if (!stale) setAccounts(value); }).catch(() => {});
    return () => { stale = true; };
  }, [client, env.id, env.online, cwd, data?.supported]);
  const selectAccount = async (login: string) => {
    setAccountBusy(true); setAccountError('');
    try {
      await client.rpc(env.id, 'git.account', { cwd, login }, 20_000);
      setAccounts(value => value ? { ...value, selected: login } : value); refresh(true);
    } catch (e: any) { setAccountError(e.message || 'Could not select that GitHub account.'); }
    finally { setAccountBusy(false); }
  };
  const runVersion = data?.runs?.map(r => `${r.id}:${r.attempt}:${r.state}:${r.updatedAt || ''}`).join('|');
  useEffect(() => { identity.current++; setJobs({}); setOpen(null); }, [client, env.id, cwd, data?.account, data?.sha, data?.deploymentSha, runVersion]);
  const loadJobs = async (runId: number) => {
    const epoch = identity.current;
    setJobs(s => ({ ...s, [runId]: 'loading' }));
    try {
      const result = await client.rpc<{ jobs: Job[]; truncated?: boolean }>(env.id, 'git.jobs', { cwd, runId }, 30_000);
      if (epoch === identity.current) setJobs(s => ({ ...s, [runId]: result }));
    } catch { if (epoch === identity.current) setJobs(s => ({ ...s, [runId]: 'failed' })); }
  };
  const pr = data?.pr;
  return <div className="pipeline">
    <div className="pipeline-heading"><div><h2>CI / CD</h2><p>{data?.repository || 'GitHub checks and deployments'}{data?.sha && <> · <code>{data.sha.slice(0, 7)}</code></>}</p></div>
      <button className="iconbtn" aria-label="Refresh CI / CD" onClick={() => refresh()} disabled={loading || !env.online}><Icon name="refresh" size={17} /></button>
    </div>
    {accounts && <div className="pipeline-account"><label htmlFor="pipeline-account">GitHub account</label><select id="pipeline-account" value={accounts.selected}
      disabled={accountBusy || !env.online} onChange={event => void selectAccount(event.target.value)}><option value="auto">Machine default / environment</option>
      {accounts.accounts.map(a => <option key={a.login} value={a.login} disabled={!a.valid}>{a.login}{a.active ? ' · active in gh' : ''}{!a.valid ? ' · sign in again' : ''}</option>)}</select>
      <p>Uses this machine’s gh sign-ins. This choice applies to this repository and does not switch your CLI account.</p></div>}
    {accountError && <div className="pipeline-notice failure" role="status">{accountError}</div>}
    {sessionId && data?.supported && <div className="pipeline-watch"><div><b>Notify this thread</b><p>Checks fail, reviews change, PR merges, or deployment finishes. Continues when you close Helm.</p></div>
      <button className={`switch${data.watching ? ' on' : ''}`} role="switch" aria-label="Notify this thread about CI / CD" aria-checked={!!data.watching}
        disabled={watchBusy || !env.online} onClick={watch}><i /></button></div>}
    {!env.online && <div className="pipeline-notice" role="status">This machine is offline. Reconnect to update GitHub status.</div>}
    {error && <div className="pipeline-notice failure" role="status">{error}<button className="linkish" onClick={() => refresh()}>Try again</button></div>}
    {loading && !data && <p className="note" role="status">Reading GitHub status…</p>}
    {data && !data.supported && !data.errors.length && <p className="note">Monitoring is available for GitHub repositories. Configure a GitHub remote for this project.</p>}
    {data?.errors.map((e, i) => <div className="pipeline-notice failure" role="status" key={`${e.section}:${i}`}><b>{e.section}</b> · {e.message}
      {!!e.retryAt && <span> Resumes after {new Date(e.retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</span>}</div>)}
    {data?.stale && <p className="note">Showing the last available results. GitHub could not confirm them on this refresh.</p>}
    {data?.unpublished && <div className="pipeline-notice">The PR is on a different commit. Checks below are for this checkout; push your changes to run CI for them.</div>}
    {data?.truncated && <div className="pipeline-notice">Some results exceed the display limit. Open GitHub for the full list; incomplete checks are never marked passed.</div>}
    {data?.supported && <>
      <section className="pipeline-section"><h3>Pull request</h3>
        {pr ? <><div className="pipeline-row"><External url={pr.url}>#{pr.number} {pr.title}</External><span className={`pipeline-state ${pr.state === 'MERGED' ? 'success' : ''}`}>{pr.draft ? 'Draft' : pr.state.toLowerCase()}</span></div>
          <div className="pipeline-pr-meta"><span>{pr.review === 'APPROVED' ? 'Reviews approved' : pr.review === 'CHANGES_REQUESTED' ? 'Changes requested' : pr.review === 'REVIEW_REQUIRED' ? 'Review required' : 'Review status unavailable'}</span>
            {pr.state === 'OPEN' && <span>{data.stale ? 'Merge readiness not confirmed' : pr.draft ? 'Draft needs to be marked ready' : pr.mergeable === 'CONFLICTING' ? 'Merge conflicts' : pr.mergeState === 'CLEAN' ? 'GitHub reports ready to merge' : pr.mergeState === 'BLOCKED' ? 'Merge blocked' : pr.mergeState === 'BEHIND' ? 'Branch behind base' : 'Merge readiness not confirmed'}</span>}</div></>
          : <p className="note">{data.errors.some(e => ['Pull request', 'GitHub'].includes(e.section)) ? 'PR status could not be confirmed.' : 'No pull request for this branch.'}</p>}
      </section>
      <section className="pipeline-section"><div className="pipeline-section-head"><h3>Checks</h3><Status state={data.checksState || 'unknown'} /></div>
        {data.checks?.map(c => <div className="pipeline-row" key={c.id}><div><External url={c.url}>{c.name}</External>{c.summary && <p>{c.summary}</p>}</div><Status state={c.state} /></div>)}
        {!data.checks?.length && <p className="note">{data.errors.some(e => ['Checks', 'GitHub'].includes(e.section)) ? 'Checks could not be confirmed.' : 'No checks reported for this commit yet.'}</p>}
      </section>
      <section className="pipeline-section"><h3>Workflows{data.deploymentSha && data.deploymentSha !== data.sha && <> · merged commit <code>{data.deploymentSha.slice(0, 7)}</code></>}</h3>
        {data.runs?.map(r => <div className="pipeline-run" key={r.id}>
          <div className="pipeline-row"><button className="pipeline-run-toggle" aria-expanded={open === r.id} onClick={() => { setOpen(n => n === r.id ? null : r.id); if (!jobs[r.id] || jobs[r.id] === 'failed') void loadJobs(r.id); }}>
            <Icon name={open === r.id ? "down" : "forward"} size={14} /><span>{r.name}<small>{r.event} · attempt {r.attempt}</small></span></button><Status state={r.state} /></div>
          {open === r.id && <div className="pipeline-jobs"><External url={r.url}>Open workflow and logs</External>
            {jobs[r.id] === 'loading' && <p role="status">Reading workflow jobs…</p>}
            {jobs[r.id] === 'failed' && <p role="status">Could not read jobs. <button className="linkish" onClick={() => void loadJobs(r.id)}>Try again</button></p>}
            {typeof jobs[r.id] === 'object' && <JobList value={jobs[r.id] as { jobs: Job[]; truncated?: boolean }} />}
          </div>}
        </div>)}
        {!data.runs?.length && <p className="note">{data.errors.some(e => ['Workflows', 'GitHub'].includes(e.section)) ? 'Workflow status could not be confirmed.' : 'No GitHub Actions runs reported for this commit.'}</p>}
      </section>
      <section className="pipeline-section"><h3>Deployments{data.deploymentSha && data.deploymentSha !== data.sha && <> · <code>{data.deploymentSha.slice(0, 7)}</code></>}</h3>
        {data.deployments?.map(d => <div className="pipeline-deployment" key={d.id}><div className="pipeline-row"><External url={d.url}>{d.environment}</External><Status state={d.state} /></div>
          {d.description && <p>{d.description}</p>}{d.environmentUrl && <External url={d.environmentUrl}>Open deployed app</External>}</div>)}
        {!data.deployments?.length && <p className="note">{data.errors.some(e => ['Deployments', 'GitHub'].includes(e.section)) ? 'Deployment status could not be confirmed.' : 'No deployments reported to GitHub for this commit. A successful workflow alone does not confirm deployment.'}</p>}
        <p className="pipeline-footnote">Deployment results come from GitHub. App health is not verified here.</p>
      </section>
    </>}
    {data?.checkedAt && <p className="pipeline-footnote">Last checked {new Date(data.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{loading ? ' · refreshing…' : ''}</p>}
  </div>;
}
function JobList({ value }: { value: { jobs: Job[]; truncated?: boolean } }) {
  return <>{value.jobs.map(j => <div key={j.id} className="pipeline-job"><div className="pipeline-row"><External url={j.url}>{j.name} · logs</External><Status state={j.state} /></div>
    {j.steps.filter(s => s.state === 'failure').map(s => <p className="pipeline-failed-step" key={s.number}>Failed step: {s.name}</p>)}</div>)}
    {!value.jobs.length && <p>No jobs reported yet.</p>}{value.truncated && <p>More jobs are available in GitHub.</p>}</>;
}
