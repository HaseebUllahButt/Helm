import { errorMessage } from '../errors';
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Client, Environment, Session } from '../client';
import { Icon } from '../Icon';
import { Markdown } from '../Markdown';
import { ago } from '../screens/common';
import { FileView } from './CodeView';
import { SideDock, readLocal, writeLocal } from './SideDock';
import { liveUrl, saveVisual, useVisualHtml, VisualFrame, type VisualReader } from './VisualReply';
import type { Visual } from './types';

// The page editor is large; it loads the first time a note is edited.
const PageEditor = lazy(() => import('./PageEditor'));

/**
 * The canvas: a column beside the chat for the project's notes and docs. It
 * opens on the markdown files, shows one as a page, and edits it in place.
 * The agent and the owner can both change a file: the canvas follows the
 * agent's edits while the owner has none, and a save never overwrites a
 * change it did not see. Edits save themselves a moment after typing stops
 * and when the file closes; the canvas speaks up only when a save fails.
 * It also shows pages: a visual the owner moves here, or one the agent sends
 * with `helm canvas`, saved or live. Its first screen lists the chat's pages
 * above the notes, so Back from a page always lands somewhere useful.
 */

interface Tree { root: string; absoluteRoot?: string; start: string; files: string[]; secret: string[]; truncated: boolean }
interface FileText { path: string; size?: number; text?: string; hash?: string; truncated?: boolean; binary?: boolean; hidden?: boolean; same?: boolean }
type Saved = { path: string; hash?: string; size?: number; conflict?: boolean; gone?: boolean; exists?: boolean };
/** A page the agent showed in this chat, and when. */
export type CanvasPageItem = { visual: Visual; at: number };
/** The chat's pages, newest first, each once. */
export function chatPages(found: (CanvasPageItem | null | undefined)[]): CanvasPageItem[] {
  const seen = new Set<string>();
  return found.filter((p): p is CanvasPageItem => !!p).reverse().filter((p) => !seen.has(p.visual.ref) && !!seen.add(p.visual.ref));
}

const WIDTH_KEY = 'helm.canvas-width';
const openKey = (env: string, session: string) => `helm.canvas.${env}:${session}`;
const OPEN_EVENT = 'helm:canvas';
/** How often an open file is checked for the agent's edits. Only a hash travels when nothing changed. */
const WATCH_MS = 2000;
/** How long typing must pause before the canvas saves. */
const AUTOSAVE_MS = 700;

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const isMarkdown = (p: string) => /\.(md|mdx|markdown)$/i.test(p);
/** Unsaved edits, by machine, folder and file, for as long as the app is open. */
const drafts = new Map<string, { text: string; base: FileText }>();
const draftKey = (env: string, cwd: string, path: string) => `${env}\0${cwd}\0${path}`;

/** Ctrl/Cmd+Shift+D: D for document. */
export function isCanvasKey(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'> & { isComposing?: boolean }) {
  return (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && !e.isComposing && e.key.toLowerCase() === 'd';
}

/** Ask the chat on screen to show a file in its canvas: a file name in the chat does this. */
export const openInCanvas = (path: string) => window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { path } }));

/**
 * What the canvas shows: one file or one page, never both. `seen` is the
 * agent's last canvas request already acted on, so a canvas the owner closed
 * stays closed until the agent asks again. Closing also tells the chat, so
 * other devices and browsers do not open that ask either.
 */
type CanvasState = { open: boolean; path: string | null; visual: Visual | null; seen?: string };
const isVisual = (v: any): v is Visual => !!v && typeof v.ref === 'string' && typeof v.title === 'string';
function loadCanvas(key: string): CanvasState {
  try {
    const v = JSON.parse(readLocal(key) || '');
    return { open: !!v.open, path: typeof v.path === 'string' ? v.path : null, visual: isVisual(v.visual) ? v.visual : null, seen: typeof v.seen === 'string' ? v.seen : undefined };
  } catch { return { open: false, path: null, visual: null }; }
}

/** Whether the canvas is open and on what, remembered per chat on this device. */
export function useCanvas(client: Client, env: Environment, session: Session, enabled = true) {
  const key = openKey(env.id, session.id);
  const [held, setStateRaw] = useState(() => ({ key, ...loadCanvas(key) }));
  // Another chat in the same screen starts from its own canvas, never this one's.
  let state: CanvasState = held;
  if (held.key !== key) { state = loadCanvas(key); setStateRaw({ key, ...state }); }
  const now = useRef(state); now.current = state;
  const request = enabled ? session.canvas : undefined;
  const ask = useRef(request); ask.current = request;
  const set = useCallback((next: CanvasState) => {
    const was = now.current;
    now.current = next; setStateRaw({ key, ...next }); writeLocal(key, JSON.stringify(next));
    const r = ask.current;
    if (was.open && !next.open && r?.requestId && !r.closed) {
      client.rpc(env.id, 'session.canvas-closed', { id: session.id, requestId: r.requestId }, 15_000).catch(() => {});
    }
  }, [key, client, env.id, session.id]);
  // The agent asked to show something: it opens, closed or not, once per ask,
  // unless the owner already closed that ask on another device.
  useEffect(() => {
    if (!request?.requestId || request.requestId === now.current.seen) return;
    const seen = request.requestId;
    if (request.closed) set({ ...now.current, seen });
    else if (isVisual(request.visual)) set({ open: true, path: null, visual: request.visual, seen });
    else if (typeof request.path === 'string' && request.path) set({ open: true, path: request.path, visual: null, seen });
    else set({ ...now.current, seen });
  }, [request?.requestId, set]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isCanvasKey(e) || (e.target as HTMLElement | null)?.closest?.('.xterm')) return;
      // Stops Chrome's "bookmark all tabs".
      e.preventDefault();
      if (e.repeat) return;
      const modal = [...document.querySelectorAll('[aria-modal="true"]')].at(-1);
      if (modal && !modal.matches('.side-dock')) return;
      set({ ...now.current, open: !now.current.open });
    };
    const onOpen = (e: Event) => { const path = (e as CustomEvent).detail?.path; if (typeof path === 'string' && path) set({ ...now.current, open: true, path, visual: null }); };
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener(OPEN_EVENT, onOpen); };
  }, [enabled, set]);
  const showVisual = useCallback((visual: Visual) => set({ ...now.current, open: true, path: null, visual }), [set]);
  return {
    open: state.open, path: state.path, visual: state.visual,
    setOpen: (open: boolean) => set({ ...now.current, open }),
    toggle: () => set({ ...now.current, open: !now.current.open }),
    setPath: (path: string | null) => set({ ...now.current, path, visual: null }),
    showVisual,
    setVisual: (visual: Visual | null) => set({ ...now.current, path: null, visual }),
  };
}

export function Canvas({ client, env, cwd, changed, path, onPath, visual, onVisual, read, pages = [], onClose }: {
  client: Client; env: Environment;
  /** The chat's folder; '' for a quick chat that has none. */
  cwd: string;
  /** Files git says are changed, relative to the project's top folder. */
  changed: string[];
  path: string | null; onPath: (path: string | null) => void;
  /** A page shown instead of a file; it reads saved pages through `read`. */
  visual?: Visual | null; onVisual?: (visual: Visual | null) => void; read?: VisualReader;
  /** The chat's pages, listed on the first screen. */
  pages?: CanvasPageItem[];
  onClose: () => void;
}) {
  const [tree, setTree] = useState<Tree | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    setTree(null);
    if (!cwd) { setError(NO_FOLDER); return; }
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    setError('');
    client.rpc<Tree>(env.id, 'git.files', { cwd }, 30_000)
      .then((t) => {
        if (!live) return;
        if (!Array.isArray(t?.files)) { setError('Update Helm on this machine to show files.'); return; }
        setTree(t);
      })
      .catch((e: any) => {
        if (!live) return;
        if (/not connected|disconnected/i.test(e?.message ?? '')) {
          setError('Waiting for this machine…');
          retry = setTimeout(() => setReload((n) => n + 1), WATCH_MS);
        } else setError(/not a git/i.test(e?.message ?? '') ? NOT_GIT : errorMessage(e, { machine: env.name, fallback: 'Helm cannot list the files.' }));
      });
    return () => { live = false; clearTimeout(retry); };
  }, [client, env.id, cwd, reload]);

  // A file named in the chat may be a full path: find it in the project.
  const shown = useMemo(() => {
    if (!path || !/^[/~]/.test(path)) return path;
    if (!tree) return null;
    const root = path.startsWith('~/') ? tree.root : tree.absoluteRoot ?? tree.root;
    const prefix = `${root.replace(/\/+$/, '')}/`;
    if (!path.startsWith(prefix)) return undefined;
    const rel = path.slice(prefix.length);
    return tree.files.includes(rel) ? rel : undefined;
  }, [path, tree]);
  useEffect(() => { if (shown && shown !== path) onPath(shown); }, [shown, path, onPath]);

  return <SideDock label="Canvas" widthKey={WIDTH_KEY} className="canvas" share={0.5} onClose={onClose}>
    {visual ? <CanvasPage key={visual.ref} visual={visual} read={read} onBack={() => onVisual?.(null)} onClose={onClose} />
      : shown === undefined
      ? <div className="canvas-pad"><CanvasHead title="Not in this project" sub={path ?? ''} onBack={() => onPath(null)} onClose={onClose} /><div className="git-state">The canvas cannot open files outside this chat’s project.</div></div>
      : shown
        ? <CanvasFile key={shown} client={client} env={env} cwd={cwd} path={shown} hidden={!!tree?.secret.includes(shown)} onBack={() => { onPath(null); setReload((n) => n + 1); }} onClose={onClose} />
        : <CanvasPicker env={env} cwd={cwd} tree={tree} error={error} changed={changed} client={client} pages={pages} onPage={(v) => onVisual?.(v)}
            onOpen={onPath} onCreated={(p) => { setReload((n) => n + 1); onPath(p); }} onClose={onClose} />}
  </SideDock>;
}

/**
 * A page in the canvas. A saved one runs in the same sealed frame as in the
 * chat. A live one is the site itself in its own sandbox, with no access to
 * Helm; sites that refuse to be framed still open in a new tab.
 */
function CanvasPage({ visual, read, onBack, onClose }: { visual: Visual; read?: VisualReader; onBack: () => void; onClose: () => void }) {
  const live = visual.url !== undefined, url = liveUrl(visual);
  // Live apps need their own storage and module origin, never Helm's origin.
  const separateOrigin = url && new URL(url).origin !== location.origin;
  const { html, error, retry } = useVisualHtml(read, visual.ref, !live);
  return <div className="canvas-file canvas-page">
    <div className="canvas-pad canvas-top">
      <CanvasHead title={visual.title} sub={live ? url ?? visual.url ?? '' : 'Page from the agent'} onBack={onBack} onClose={onClose}>
        {url && <a className="files-chip" href={url} target="_blank" rel="noopener noreferrer">Open in new tab</a>}
        {html && <button className="files-chip" onClick={() => saveVisual(html, visual.title)}>Save</button>}
      </CanvasHead>
    </div>
    {live
      ? url && separateOrigin ? <iframe key={url} className="visual-frame canvas-live" title={visual.title} src={url} sandbox="allow-scripts allow-forms allow-popups allow-same-origin" referrerPolicy="no-referrer" />
        : <div className="git-state bad" role="alert">{url ? 'Open this Helm address in a new tab.' : 'This page address is not allowed.'}</div>
      : html ? <VisualFrame html={html} title={visual.title} expanded onEscape={onClose} />
      : <div className={`git-state${error ? ' bad' : ''}`} role={error ? 'alert' : 'status'}>
        {error ? <>{error} <button className="files-chip" onClick={retry}>Retry</button></> : 'Loading visual…'}
      </div>}
  </div>;
}

function CanvasHead({ title, sub, onBack, onClose, children }: { title: string; sub: string; onBack?: () => void; onClose: () => void; children?: ReactNode }) {
  return <div className="canvas-head">
    {onBack && <button className="iconbtn" aria-label="Back to the canvas list" title="Back" onClick={onBack}><Icon name="back" size={17} /></button>}
    <div className="canvas-titles"><b>{title}</b><small>{sub}</small></div>
    {children}
    <button className="iconbtn" aria-label="Close canvas" title="Close canvas (Ctrl/⌘ Shift D)" onClick={onClose}><Icon name="close" size={17} /></button>
  </div>;
}

/** Not problems, just what this chat's canvas holds: said quietly, never in red. */
const NO_FOLDER = 'This quick chat has no folder, so there are no notes to show.';
const NOT_GIT = 'Notes and docs show here when the chat’s folder is a Git project.';

function CanvasPicker({ client, env, cwd, tree, error, changed, pages, onPage, onOpen, onCreated, onClose }: {
  client: Client; env: Environment; cwd: string; tree: Tree | null; error: string; changed: string[];
  pages: CanvasPageItem[]; onPage: (visual: Visual) => void;
  onOpen: (path: string) => void; onCreated: (path: string) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [naming, setNaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const changedSet = useMemo(() => new Set(changed), [changed]);
  const unsaved = (p: string) => drafts.has(draftKey(env.id, cwd, p));
  // Markdown first: the agent's changes and unsaved edits on top, then the chat's own folder, then the rest.
  const docs = useMemo(() => {
    if (!tree) return [];
    const near = tree.start ? `${tree.start}/` : '';
    const rank = (p: string) => (changedSet.has(p) || unsaved(p) ? 0 : near && p.startsWith(near) ? 1 : 2);
    return tree.files.filter(isMarkdown).sort((a, b) => rank(a) - rank(b) || a.split('/').length - b.split('/').length || a.localeCompare(b));
  }, [tree, changedSet]);
  const found = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!tree || !q) return null;
    const byName = tree.files.filter((p) => base(p).toLowerCase().includes(q));
    const byPath = tree.files.filter((p) => !base(p).toLowerCase().includes(q) && p.toLowerCase().includes(q));
    return [...byName, ...byPath].slice(0, 100);
  }, [tree, query]);

  const create = async (name: string) => {
    let rel = name.trim().replace(/^\.?\/+/, '');
    if (!rel) return;
    if (!/\.[^./]+$/.test(rel)) rel += '.md';
    setBusy(true); setProblem('');
    try {
      const r = await client.rpc<Saved>(env.id, 'git.write', { cwd, path: rel, text: '', base: null }, 30_000);
      if (r.exists) { setNaming(null); onOpen(rel); return; }
      setNaming(null); onCreated(rel);
    } catch (e: any) { setProblem(/unknown|not supported/i.test(e?.message ?? '') ? 'Update Helm on this machine to create files here.' : errorMessage(e, { machine: env.name, fallback: 'Helm cannot create the file.' })); }
    finally { setBusy(false); }
  };

  const row = (p: string) => {
    const slash = p.lastIndexOf('/');
    return <button key={p} className="files-row" onClick={() => onOpen(p)} title={p}>
      <span className="files-ic"><Icon name={tree?.secret.includes(p) ? 'lock' : isMarkdown(p) ? 'read' : 'raw'} size={15} /></span>
      <span className="files-name">{base(p)}{slash > 0 && <small>{p.slice(0, slash)}</small>}</span>
      {unsaved(p) ? <span className="files-meta canvas-unsaved">unsaved</span> : changedSet.has(p) && <span className="files-dot" aria-label="changed" />}
    </button>;
  };
  const LIMIT = 300;
  const quiet = error === NO_FOLDER || error === NOT_GIT;
  const pageList = !found && pages.length > 0 && <>
    <div className="canvas-label">Pictures and pages</div>
    <div className="files-list">
      {pages.map(({ visual, at }) => <button key={visual.ref} className="files-row" onClick={() => onPage(visual)} title={visual.url ?? visual.title}>
        <span className="files-ic"><Icon name={visual.url ? 'web' : 'image'} size={15} /></span>
        <span className="files-name">{visual.title}{visual.url && <small>{visual.url}</small>}</span>
        <span className="files-meta">{ago(at)}</span>
      </button>)}
    </div>
  </>;

  return <div className="canvas-pad">
    <CanvasHead title="Canvas" sub={tree ? `${env.name} · ${tree.root}` : env.name} onClose={onClose}>
      {tree && <button className="files-chip" onClick={() => setNaming(naming === null ? (tree.start ? `${tree.start}/` : '') : null)}><Icon name="plus" size={13} />Create file</button>}
    </CanvasHead>
    {error ? <>{pageList}<div className={`git-state${quiet ? '' : ' bad'}`} role="status">{error}</div></>
      : !tree ? <div className="git-state" role="status">Listing files…</div>
      : <>
        {naming !== null && <form className="canvas-new" onSubmit={(e) => { e.preventDefault(); void create(naming); }}>
          <input autoFocus aria-label="New file name" placeholder="notes/plan.md" value={naming} disabled={busy}
            onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setNaming(null); } }} />
          <button type="submit" className="files-chip" disabled={busy || !naming.trim()}>{busy ? 'Creating…' : 'Create'}</button>
        </form>}
        {problem && <div className="git-state bad" role="alert">{problem}</div>}
        <label className="files-search">
          <Icon name="search" size={15} />
          <input type="search" placeholder="Find any file" aria-label="Find any file" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        {pageList}
        {found ? <div className="files-list">
          {found.length ? found.map(row) : <div className="git-state">No file matches “{query.trim()}”.</div>}
        </div> : <>
          <div className="canvas-label">Notes and documents</div>
          <div className="files-list">
            {docs.length ? docs.slice(0, LIMIT).map(row) : <div className="git-state">This folder has no Markdown text files. Select New to create one.</div>}
          </div>
          {docs.length > LIMIT && <div className="note git-tail">{(docs.length - LIMIT).toLocaleString()} more. Search to find them.</div>}
        </>}
      </>}
  </div>;
}

function CanvasFile({ client, env, cwd, path, hidden, onBack, onClose }: {
  client: Client; env: Environment; cwd: string; path: string; hidden: boolean; onBack: () => void; onClose: () => void;
}) {
  const dkey = draftKey(env.id, cwd, path);
  const [file, setFile] = useState<FileText | 'loading' | { error: string }>(() => drafts.get(dkey)?.base ?? 'loading');
  const [draft, setDraftRaw] = useState<string | null>(() => drafts.get(dkey)?.text ?? null);
  const [editing, setEditing] = useState(() => drafts.has(dkey));
  // The file as it now is on disk, when that moved on under unsaved edits.
  const [theirs, setTheirs] = useState<FileText | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  const savingNow = useRef(false);
  const revision = useRef(0);

  const loaded = typeof file === 'object' && 'text' in file && file.text != null ? file : null;
  const dirty = draft != null && loaded != null && draft !== loaded.text;
  const setDraft = (text: string | null) => {
    if (text != null && loaded?.text?.includes('\r\n')) text = text.replace(/\r?\n/g, '\r\n');
    setDraftRaw(text);
    if (text == null || (loaded && text === loaded.text)) drafts.delete(dkey);
    else if (loaded) drafts.set(dkey, { text, base: loaded });
  };
  const live = useRef({ file, dirty, theirs }); live.current = { file, dirty, theirs };

  useEffect(() => {
    let alive = true;
    if (hidden) { setFile({ path, hidden: true }); return; }
    const at = revision.current;
    client.rpc<FileText>(env.id, 'git.file', { cwd, path }, 30_000)
      .then((f) => {
        if (!alive || at !== revision.current) return;
        revision.current++;
        const kept = drafts.get(dkey);
        if (kept && kept.base.hash !== f.hash) setTheirs(f);
        else setFile(f);
      })
      .catch((e: any) => {
        if (!alive || at !== revision.current) return;
        if (drafts.has(dkey)) setProblem(errorMessage(e, { fallback: 'Helm cannot open this file.' }));
        else setFile({ error: errorMessage(e, { fallback: 'Helm cannot open this file.' }) });
      });
    return () => { alive = false; };
  }, [client, env.id, cwd, path, hidden]);

  // Follow the agent's edits. With none of the owner's pending, the page just
  // updates; under unsaved edits the canvas says so and lets the owner choose.
  useEffect(() => {
    if (hidden) return;
    let alive = true, busy = false;
    const tick = async () => {
      const f = live.current.file;
      if (busy || savingNow.current || document.visibilityState !== 'visible' || typeof f !== 'object') return;
      busy = true;
      try {
        const at = revision.current;
        const since = live.current.theirs?.hash ?? ('hash' in f ? f.hash : undefined);
        const next = await client.rpc<FileText>(env.id, 'git.file', { cwd, path, since }, 15_000);
        if (!alive || at !== revision.current || savingNow.current) return;
        setProblem('');
        if (next.same) return;
        revision.current++;
        if (live.current.dirty) setTheirs(next);
        else { setFile(next); setDraftRaw((d) => (d == null ? d : next.text ?? '')); }
      } catch (e: any) {
        if (alive && /no such file|not a file/i.test(e?.message ?? '')) setProblem('This file was deleted or moved. Your text stays here until you leave.');
      }
      finally { busy = false; }
    };
    const timer = setInterval(() => void tick(), WATCH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [client, env.id, cwd, path, hidden]);

  const save = async (over?: FileText) => {
    if (!loaded || draft == null || savingNow.current) return;
    savingNow.current = true; revision.current++;
    setSaving(true); setProblem('');
    try {
      const baseHash = over?.hash ?? loaded.hash ?? '';
      const r = await client.rpc<Saved>(env.id, 'git.write', { cwd, path, text: draft, base: baseHash }, 30_000);
      if (r.conflict) {
        if (r.gone) { setProblem('This file was deleted or moved. Copy your text before you leave.'); return; }
        const now = await client.rpc<FileText>(env.id, 'git.file', { cwd, path }, 30_000);
        setTheirs(now);
        return;
      }
      const saved = { ...loaded, text: draft, hash: r.hash, size: r.size };
      setFile(saved);
      const kept = drafts.get(dkey);
      if (kept && kept.text !== draft) drafts.set(dkey, { text: kept.text, base: saved });
      else drafts.delete(dkey);
      setTheirs(null);
    } catch (e: any) {
      setProblem(/unknown|not supported/i.test(e?.message ?? '') ? 'Update Helm on this machine to save files here.' : errorMessage(e, { machine: env.name, fallback: 'Helm cannot save the file.' }));
    } finally { savingNow.current = false; revision.current++; setSaving(false); }
  };
  // Save once typing pauses. A clash or a failed save waits for the owner.
  useEffect(() => {
    if (!dirty || theirs || saving || problem) return;
    const t = setTimeout(() => void save(), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [draft, dirty, theirs, saving, problem]); // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving the file (Back, Close, another file) saves what is left.
  const leave = useRef({ dirty, theirs, save }); leave.current = { dirty, theirs, save };
  useEffect(() => () => { const l = leave.current; if (l.dirty && !l.theirs) void l.save(); }, []);

  // A tab closed with unsaved edits asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const startEdit = () => {
    if (!loaded || loaded.truncated || !loaded.hash) return;
    if (draft == null) setDraftRaw(loaded.text ?? '');
    setEditing(true);
    requestAnimationFrame(() => area.current?.focus());
  };
  // An empty file (a new note) has nothing to read: it opens ready to type.
  const empty = loaded?.text === '' && !!loaded.hash;
  useEffect(() => { if (empty && !editing) startEdit(); }, [empty]); // eslint-disable-line react-hooks/exhaustive-deps
  const md = isMarkdown(path);
  const slash = path.lastIndexOf('/');
  const canEdit = !!loaded && !loaded.truncated && !!loaded.hash;
  const text = draft ?? loaded?.text ?? '';

  useEffect(() => {
    const onSave = (e: KeyboardEvent) => {
      if (e.isComposing || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 's') return;
      const modal = [...document.querySelectorAll('[aria-modal="true"]')].at(-1);
      if (modal && !modal.matches('.canvas')) return;
      e.preventDefault();
      if (dirty) void save();
    };
    window.addEventListener('keydown', onSave);
    return () => window.removeEventListener('keydown', onSave);
  });

  return <div className="canvas-file">
    <div className="canvas-pad canvas-top">
      <CanvasHead title={base(path)} sub={slash > 0 ? path.slice(0, slash) : './'} onBack={onBack} onClose={onClose}>
        {canEdit && !md && <div className="segmented canvas-mode" role="group" aria-label="Show">
          <button className={!editing ? 'on' : ''} aria-pressed={!editing} onClick={() => setEditing(false)}>View</button>
          <button className={editing ? 'on' : ''} aria-pressed={editing} onClick={startEdit}>Edit</button>
        </div>}
      </CanvasHead>
      {problem && <div className="canvas-save" role="status">
        <span className="bad">{problem}</span>
        {dirty && <button className="files-chip canvas-save-btn" disabled={saving} onClick={() => void save()}>Try again</button>}
      </div>}
      {theirs && dirty && <div className="canvas-clash" role="alert">
        <span>The file changed on the machine after you started editing.</span>
        <button className="files-chip" onClick={() => { setFile(theirs); setDraft(null); setTheirs(null); }}>Use the new file</button>
        <button className="files-chip" disabled={saving} onClick={() => void save(theirs)}>Save mine over it</button>
      </div>}
    </div>
    {file === 'loading' ? <div className="git-state" role="status">Opening…</div>
      : 'error' in file ? <div className="git-state bad" role="status">{file.error}</div>
      : file.hidden ? <div className="git-state">Helm hides files that can contain passwords or keys.</div>
      : file.binary ? <div className="git-state">This is not a text file.</div>
      // A note is one page: read it and type into it, with no mode to switch.
      : canEdit && md
        ? <Suspense fallback={<div className="canvas-body"><Markdown text={text} className="canvas-md" /></div>}>
            <PageEditor text={text} label={base(path)} focus={empty} onChange={setDraft} />
          </Suspense>
      : editing && canEdit
        ? <textarea ref={area} className="canvas-edit" spellCheck={md} value={text} placeholder="Start writing…" aria-label={`Edit ${base(path)}`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Tab indents here instead of leaving the box; Escape goes back to reading.
              if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                const el = e.currentTarget, at = el.selectionStart;
                el.setRangeText('  ', at, el.selectionEnd, 'end');
                setDraft(el.value);
              } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(false); }
            }} />
        : <div className="canvas-body">
            {md ? <Markdown text={text} className="canvas-md" /> : <FileView text={text} path={path} wrap />}
            {loaded?.truncated && <div className="git-state">This file is too large to edit in the canvas. Helm shows only part of it.</div>}
          </div>}
  </div>;
}
