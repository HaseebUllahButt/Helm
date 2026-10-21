import { useEffect, useRef, useState } from 'react';
import type { Client, Environment } from '../client';

interface PR { number: number; title: string; body: string; url: string | null; state: string; draft: boolean; author: string; headSha: string; head: string; base: string; mergeable: string; mergeState: string }
interface Detail { pr: PR; account: string; truncated: boolean; comments: { id: number; kind: string; author: string; body: string; state?: string; at: string; path?: string; line?: number }[];
  files: { path: string; status: string; additions: number; deletions: number; patch: string }[]; checks: { id: number; name: string; state: string }[] }

export function PullRequests({ client, env, cwd, account, onChanged }: { client: Client; env: Environment; cwd: string; account?: string; onChanged: () => void }) {
  const [list, setList] = useState<PR[]>([]), [state, setState] = useState('open'), [page, setPage] = useState(1), [more, setMore] = useState(false);
  const [number, setNumber] = useState<number | null>(null), [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  const [body, setBody] = useState(''), [verdict, setVerdict] = useState('COMMENT'), [mergeMethod, setMergeMethod] = useState('squash'), [confirmMerge, setConfirmMerge] = useState(false);
  const [inlinePath, setInlinePath] = useState(''), [line, setLine] = useState(1), [side, setSide] = useState('RIGHT');
  const [publishing, setPublishing] = useState(false), [publishAction, setPublishAction] = useState('publish');
  const [files, setFiles] = useState<{ path: string; originalPath?: string }[]>([]), [paths, setPaths] = useState<string[]>([]), [message, setMessage] = useState('');
  const [title, setTitle] = useState(''), [description, setDescription] = useState(''), [base, setBase] = useState(''), [draft, setDraft] = useState(false);
  const identity = useRef(0);
  useEffect(() => { identity.current++; setDetail(null); setNumber(null); setPaths([]); setFiles([]); setPublishing(false); setError(''); setNotice(''); setPage(1); }, [client, env.id, cwd, account]);
  useEffect(() => {
    let stale = false;
    if (env.online) client.rpc<{ pullRequests: PR[]; more: boolean }>(env.id, 'git.prs', { cwd, state, page }, 60000)
      .then(value => { if (!stale) { setList(value.pullRequests); setMore(value.more); } }).catch(e => { if (!stale) setError(e.message); });
    return () => { stale = true; };
  }, [client, env.id, env.online, cwd, account, state, page, revision]);
  useEffect(() => {
    let stale = false; setDetail(null); setConfirmMerge(false); setBody(''); setInlinePath('');
    if (number && env.online) client.rpc<Detail>(env.id, 'git.pr-detail', { cwd, number }, 60000)
      .then(value => { if (!stale) setDetail(value); }).catch(e => { if (!stale) setError(e.message); });
    return () => { stale = true; };
  }, [client, env.id, env.online, cwd, account, number, revision]);
  useEffect(() => {
    let stale = false;
    if (publishing && env.online) client.rpc<{ files: { path: string; originalPath?: string }[] }>(env.id, 'git.status', { cwd }, 15000)
      .then(value => { if (!stale) { setFiles(value.files); setPaths([]); } }).catch(e => { if (!stale) setError(e.message); });
    return () => { stale = true; };
  }, [client, env.id, env.online, cwd, publishing, revision]);
  const act = async (method: string, params: object) => {
    const epoch = identity.current; setBusy(true); setError(''); setNotice('');
    try {
      const result = await client.rpc<{ completed?: string[]; pr?: PR }>(env.id, method, { cwd, ...params }, 180000);
      if (epoch !== identity.current) return;
      setNotice(result.completed ? `Completed: ${result.completed.join(', ')}.` : 'GitHub action completed.');
      if (result.pr) setNumber(result.pr.number);
      setRevision(r => r + 1); setConfirmMerge(false); onChanged();
    } catch (e: any) { if (epoch === identity.current) { setError(e.message); setRevision(r => r + 1); onChanged(); } }
    finally { setBusy(false); }
  };
  const needsCommit = ['commit', 'publish'].includes(publishAction), needsPR = ['create', 'publish'].includes(publishAction);
  // Every PR and the publish form are a second look, so they start folded.
  return <details className="fold pipeline-section pull-requests" aria-label="Pull requests">
    <summary>Pull requests{list.length > 0 && <span className="fold-meta">{list.length}{more ? '+' : ''}</span>}</summary>
    <div className="team-actions"><label>State <select aria-label="State" value={state} onChange={e => { setState(e.target.value); setPage(1); }}><option value="open">Open</option><option value="closed">Closed / merged</option><option value="all">All</option></select></label>
      <button disabled={busy || !env.online} onClick={() => setRevision(r => r + 1)}>Refresh</button>
      <button disabled={busy || !env.online} onClick={() => setPublishing(v => !v)}>{publishing ? 'Close publishing' : 'Commit / push / create pull request'}</button></div>
    {publishing && <form className="schedule-form" onSubmit={e => { e.preventDefault(); void act('git.publish', { action: publishAction, paths: [...new Set(paths.flatMap(path => { const file = files.find(f => f.path === path); return file?.originalPath ? [path, file.originalPath] : [path]; }))], message, title, body: description, base: base || undefined, draft }); }}>
      <label>Action<select aria-label="Action" value={publishAction} onChange={e => setPublishAction(e.target.value)}><option value="publish">Commit files, push, create pull request</option><option value="commit">Commit selected files</option><option value="push">Push current branch</option><option value="create">Create pull request for pushed branch</option></select></label>
      {needsCommit && <><label>Commit message<input required maxLength={32000} value={message} onChange={e => setMessage(e.target.value)} /></label>
        <fieldset><legend>Files to commit</legend>{files.map(({ path, originalPath }) => <label className="automation-option" key={path}><input type="checkbox" checked={paths.includes(path)} onChange={e => setPaths(ps => e.target.checked ? [...ps, path] : ps.filter(p => p !== path))} /><code>{originalPath ? `${originalPath} → ${path}` : path}</code></label>)}{!files.length && <p>No files changed.</p>}</fieldset></>}
      {needsPR && <><label>Pull request title<input required maxLength={256} value={title} onChange={e => setTitle(e.target.value)} /></label><label>Description<textarea rows={4} maxLength={32000} value={description} onChange={e => setDescription(e.target.value)} /></label>
        <label>Base branch<input maxLength={200} value={base} placeholder="Project default" onChange={e => setBase(e.target.value)} /></label><label className="automation-option"><input type="checkbox" checked={draft} onChange={e => setDraft(e.target.checked)} /> Draft pull request</label></>}
      <button className="primary" disabled={busy || !env.online || needsCommit && !paths.length}>{busy ? 'Working…' : publishAction === 'publish' ? 'Commit, push and create pull request' : publishAction === 'commit' ? 'Commit selected files' : publishAction === 'push' ? 'Push branch' : 'Create pull request'}</button>
    </form>}
    {list.map(pr => <div className="pipeline-row" key={pr.number}><button className="linkish" onClick={() => setNumber(pr.number)} aria-pressed={number === pr.number}>#{pr.number} {pr.title}</button><span>{pr.draft ? 'Draft' : pr.state.toLowerCase()}</span></div>)}
    {!list.length && <p className="note">None.</p>}
    {(page > 1 || more) && <div className="team-actions"><button disabled={page === 1 || busy} onClick={() => setPage(p => p - 1)}>Previous</button><span>Page {page}</span><button disabled={!more || busy} onClick={() => setPage(p => p + 1)}>Next</button></div>}
    {number && !detail && <p role="status">Reading PR #{number}…</p>}
    {detail && <article className="pr-detail"><h4>#{detail.pr.number} {detail.pr.title}</h4>
      <p>{detail.pr.author} · {detail.pr.head} → {detail.pr.base} · {detail.pr.state.toLowerCase()}</p>
      {detail.pr.url && <a href={detail.pr.url} target="_blank" rel="noreferrer">Open on GitHub</a>}
      <p className="pr-prose">{detail.pr.body}</p>
      {detail.pr.mergeable === 'CONFLICTING' && <p>Conflicts</p>}
      {detail.truncated && <p className="note">Open GitHub to see all details.</p>}
      <details><summary>Checks ({detail.checks.length})</summary>{detail.checks.map(c => <p key={c.id}>{c.name} · {c.state}</p>)}</details>
      <details><summary>Changed files ({detail.files.length})</summary>{detail.files.map(f => <details key={f.path}><summary>{f.path} · +{f.additions} −{f.deletions}</summary><pre className="pr-patch">{f.patch || 'Open GitHub to see changes to this file.'}</pre></details>)}</details>
      <details open><summary>Comments and reviews ({detail.comments.length})</summary>{detail.comments.map(c => <article className="pr-comment" key={`${c.kind}:${c.id}`}><strong>{c.author}</strong> · {c.state || c.kind} · {new Date(c.at).toLocaleString()}{c.path && <small>{c.path}:{c.line}</small>}<p className="pr-prose">{c.body}</p></article>)}</details>
      <form className="schedule-form" onSubmit={e => { e.preventDefault(); void act('git.pr-action', { number: detail.pr.number, action: 'comment', body }); }}>
        <label>Comment / review<textarea required={verdict !== 'APPROVE'} rows={4} maxLength={32000} value={body} onChange={e => setBody(e.target.value)} /></label>
        <div className="team-actions"><button disabled={busy || !env.online || !body.trim()}>Post comment</button><label>Review<select aria-label="Review" value={verdict} onChange={e => setVerdict(e.target.value)}><option value="COMMENT">Comment</option><option value="APPROVE">Approve</option><option value="REQUEST_CHANGES">Request changes</option></select></label></div>
        <details><summary>Add a comment on a line (optional)</summary><label>File<select aria-label="File" value={inlinePath} onChange={e => setInlinePath(e.target.value)}><option value="">None</option>{detail.files.map(f => <option key={f.path}>{f.path}</option>)}</select></label><label>Line<input type="number" min={1} value={line} onChange={e => setLine(Number(e.target.value))} /></label><label>Side<select aria-label="Side" value={side} onChange={e => setSide(e.target.value)}><option value="RIGHT">New version</option><option value="LEFT">Old version</option></select></label></details>
        <button type="button" disabled={busy || !env.online || detail.pr.state !== 'OPEN' || verdict !== 'APPROVE' && !body.trim() || !!inlinePath && !body.trim()} onClick={() => void act('git.pr-action', { number: detail.pr.number, action: 'review', event: verdict, body, headSha: detail.pr.headSha,
          comments: inlinePath ? [{ path: inlinePath, line, side, body }] : [] })}>Submit review</button>
      </form>
      {detail.pr.state === 'OPEN' && <form className="schedule-form" onSubmit={e => { e.preventDefault(); void act('git.pr-action', { number: detail.pr.number, action: 'merge', headSha: detail.pr.headSha, mergeMethod }); }}>
        <label>Merge method<select aria-label="Merge method" value={mergeMethod} onChange={e => setMergeMethod(e.target.value)}><option value="squash">Combine commits</option><option value="merge">Merge commit</option><option value="rebase">Rebase (replay commits)</option></select></label>
        <label className="automation-option"><input type="checkbox" checked={confirmMerge} onChange={e => setConfirmMerge(e.target.checked)} /> Merge PR #{detail.pr.number} at {detail.pr.headSha.slice(0, 8)} into {detail.pr.base}</label>
        <button className="destructive" disabled={busy || !env.online || !confirmMerge || detail.pr.draft || detail.pr.mergeable === 'CONFLICTING'}>Merge pull request</button>
      </form>}
    </article>}
    {error && <p className="error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </details>;
}
