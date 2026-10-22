import { useEffect, useMemo, useState } from 'react';
import type { Client, Environment } from '../client';
import { Icon } from '../Icon';
import { FileView } from './CodeView';

/**
 * The repo's files, to look at and never change: a folder list, a search
 * box, and a file opened read only with its lines numbered and coloured.
 * Files the agent changed carry a dot; secrets are listed but not opened.
 */

interface Tree { root: string; start: string; files: string[]; secret: string[]; truncated: boolean }
interface FileText { path: string; size?: number; text?: string; truncated?: boolean; binary?: boolean; hidden?: boolean }

const size = (n = 0) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);

export function FilesPanel({ client, env, cwd, refreshKey, changed, wrap, open, onOpen, onChanges }: {
  client: Client; env: Environment; cwd: string; refreshKey: string;
  changed: Set<string>; wrap: boolean;
  open: string | null; onOpen: (path: string | null) => void; onChanges: (path: string) => void;
}) {
  const [tree, setTree] = useState<Tree | null>(null);
  const [error, setError] = useState('');
  const [dir, setDir] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let live = true;
    setError('');
    client.rpc<Tree>(env.id, 'git.files', { cwd }, 30_000)
      .then((t) => {
        if (!live) return;
        // An older Helm on that machine answers without a file list.
        if (!Array.isArray(t?.files)) { setError('Update Helm on this machine to show files.'); return; }
        setTree(t); setDir((d) => d ?? t.start);
      })
      .catch((e: any) => { if (live) setError(e?.message || 'Helm cannot list the files.'); });
    return () => { live = false; };
  }, [client, env.id, cwd, refreshKey]);

  const secret = useMemo(() => new Set(tree?.secret ?? []), [tree]);
  // A changed folder gets a dot too, so the agent's work can be found from the top.
  const changedDirs = useMemo(() => {
    const out = new Set<string>();
    for (const p of changed) { let at = p.lastIndexOf('/'); while (at > 0) { out.add(p.slice(0, at)); at = p.lastIndexOf('/', at - 1); } }
    return out;
  }, [changed]);

  const here = dir ?? '';
  const listing = useMemo(() => {
    if (!tree) return { dirs: [] as { name: string; count: number }[], files: [] as string[] };
    const prefix = here ? `${here}/` : '';
    const dirs = new Map<string, number>();
    const files: string[] = [];
    for (const p of tree.files) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) files.push(p);
      else { const name = rest.slice(0, slash); dirs.set(name, (dirs.get(name) ?? 0) + 1); }
    }
    return { dirs: [...dirs].map(([name, count]) => ({ name, count })), files };
  }, [tree, here]);

  const found = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!tree || !q) return null;
    // Names that match beat paths that match; both stop at 100.
    const byName = tree.files.filter((p) => base(p).toLowerCase().includes(q));
    const byPath = tree.files.filter((p) => !base(p).toLowerCase().includes(q) && p.toLowerCase().includes(q));
    return [...byName, ...byPath].slice(0, 100);
  }, [tree, query]);

  if (open) return <FileScreen client={client} env={env} cwd={cwd} path={open} wrap={wrap} changed={changed.has(open)}
    onBack={() => onOpen(null)} onChanges={() => onChanges(open)} />;

  if (error) return <div className="git-state bad" role="status">{error}</div>;
  if (!tree) return <div className="git-state" role="status">Listing files…</div>;

  const crumbs = here ? here.split('/') : [];
  const fileRow = (p: string, showDir = false) => {
    const hidden = secret.has(p);
    const slash = p.lastIndexOf('/');
    return (
      <button key={p} className="files-row" onClick={() => onOpen(p)} title={p}>
        <span className="files-ic"><Icon name={hidden ? 'lock' : 'read'} size={15} /></span>
        <span className="files-name">{base(p)}{showDir && slash > 0 && <small>{p.slice(0, slash)}</small>}</span>
        {hidden ? <span className="files-meta">hidden</span> : changed.has(p) && <span className="files-dot" aria-label="changed" />}
      </button>
    );
  };

  return (
    <div className="files">
      <label className="files-search">
        <Icon name="search" size={15} />
        <input type="search" placeholder="Find a file" aria-label="Find a file" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {found ? (
        <div className="files-list">
          {found.length ? found.map((p) => fileRow(p, true)) : <div className="git-state">No file matches “{query.trim()}”.</div>}
        </div>
      ) : <>
        <nav className="files-crumbs" aria-label="Folder">
          <button onClick={() => setDir('')}>{base(tree.root) || tree.root}</button>
          {crumbs.map((c, i) => <span key={i}><i>/</i><button onClick={() => setDir(crumbs.slice(0, i + 1).join('/'))} aria-current={i === crumbs.length - 1 ? 'location' : undefined}>{c}</button></span>)}
        </nav>
        <div className="files-list">
          {here && <button className="files-row up" onClick={() => setDir(here.includes('/') ? here.slice(0, here.lastIndexOf('/')) : '')}>
            <span className="files-ic"><Icon name="back" size={15} /></span><span className="files-name">..</span>
          </button>}
          {listing.dirs.map(({ name, count }) => {
            const path = here ? `${here}/${name}` : name;
            return (
              <button key={name} className="files-row dir" onClick={() => setDir(path)}>
                <span className="files-ic"><Icon name="folder" size={15} /></span>
                <span className="files-name">{name}</span>
                {changedDirs.has(path) && <span className="files-dot" aria-label="has changes" />}
                <span className="files-meta">{count}</span>
              </button>
            );
          })}
          {listing.files.map((p) => fileRow(p))}
          {!listing.dirs.length && !listing.files.length && <div className="git-state">This folder is empty.</div>}
        </div>
      </>}
      {tree.truncated && <div className="note git-tail">Only the first {tree.files.length.toLocaleString()} files are listed.</div>}
    </div>
  );
}

function FileScreen({ client, env, cwd, path, wrap, changed, onBack, onChanges }: {
  client: Client; env: Environment; cwd: string; path: string; wrap: boolean; changed: boolean;
  onBack: () => void; onChanges: () => void;
}) {
  const [file, setFile] = useState<FileText | 'loading' | { error: string }>('loading');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    setFile('loading');
    client.rpc<FileText>(env.id, 'git.file', { cwd, path }, 30_000)
      .then((f) => { if (live) setFile(f); })
      .catch((e: any) => { if (live) setFile({ error: e?.message || 'Helm cannot open this file.' }); });
    return () => { live = false; };
  }, [client, env.id, cwd, path]);
  const copy = () => {
    void navigator.clipboard?.writeText(path).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }, () => {});
  };
  const slash = path.lastIndexOf('/');
  const lines = typeof file === 'object' && 'text' in file && file.text != null ? file.text.replace(/\n$/, '').split('\n').length : 0;
  return (
    <div className="files-open">
      <div className="files-head">
        <button className="iconbtn" aria-label="Back to the files" onClick={onBack}><Icon name="back" size={17} /></button>
        <div className="files-title">
          <b>{base(path)}</b>
          <small>{slash > 0 ? path.slice(0, slash) : './'}{lines > 0 && ` · ${lines} line${lines === 1 ? '' : 's'}`}{typeof file === 'object' && 'size' in file && file.size != null && ` · ${size(file.size)}`}</small>
        </div>
      </div>
      <div className="files-tools">
        <button className="files-chip" onClick={copy}><Icon name={copied ? 'check' : 'copy'} size={13} />{copied ? 'Copied' : 'Copy path'}</button>
        {changed && <button className="files-chip" onClick={onChanges}><Icon name="git" size={13} />See changes</button>}
        <span className="files-ro"><Icon name="read" size={13} />View only</span>
      </div>
      {file === 'loading' ? <div className="git-state" role="status">Opening…</div>
        : 'error' in file ? <div className="git-state bad" role="status">{file.error}</div>
        : file.hidden ? <div className="git-state">Helm hides files that can contain passwords or keys.</div>
        : file.binary ? <div className="git-state">This is not a text file ({size(file.size)}).</div>
        : <>
            <FileView text={file.text ?? ''} path={path} wrap={wrap} />
            {file.truncated && <div className="git-state">The rest is too long to show here.</div>}
          </>}
    </div>
  );
}
