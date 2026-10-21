import { knownInside, listFolder, loadFolders } from '../folderIndex';
import { useCallback, useEffect, useState } from 'react';
import { rememberFolder, recentFolders } from '../accounts';
import { prefetchAccounts } from '../accountsCache';
import { BackIcon, Icon } from '../Icon';
import { Route } from '../Route';
import { Client, type Environment, type DirEntry } from '../client';
import { shortPath } from './common';

export function Browse({ client, env, path, title = 'Pick a folder', action = 'Start here', onBack, onInto, onPick, onQuick, sendFiles = false, onSend }: {
  client: Client; env: Environment; path?: string; title?: string; action?: string; sendFiles?: boolean; onSend?: (path: string) => void;
  onBack: () => void; onInto: (p: string) => void; onPick: (p: string) => void | Promise<void>;
  /** Offered on the way in: a chat that needs no folder at all. */
  onQuick?: () => void;
}) {
  // What this device already knows is inside shows at once; the machine's
  // own answer replaces it when it lands.
  const [entries, setEntries] = useState<DirEntry[]>(() => knownInside(env.id, path ?? '~') ?? []);
  const [loading, setLoading] = useState(() => !knownInside(env.id, path ?? '~'));
  const [sendPath, setSendPath] = useState('');
  const [here, setHere] = useState(path ?? '~');
  const [error, setError] = useState('');
  const [picking, setPicking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [folder, setFolder] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<{ name: string; path: string; repo: boolean }[] | null>(null);
  const [indexed, setIndexed] = useState(0);

  // The folders a session last started in on this machine: a real project
  // is usually nested a few levels under home, and remembering the last few
  // turns "open it again" into one tap instead of five. Three stay on top:
  // enough to cover "the one I was just in" without becoming a second list.
  const [recent] = useState<string[]>(() => recentFolders(env.id));
  const pick = async (p: string) => {
    rememberFolder(env.id, p);
    setError(''); setPicking(true);
    try { await onPick(p); }
    catch (e: any) { setError(e.message); }
    finally { setPicking(false); }
  };

  const load = useCallback(() => {
    setError('');
    const known = knownInside(env.id, path ?? '~');
    if (known) setEntries(known);
    setLoading(!known);
    let answered = false;
    // The folder list this device keeps may still be on its way from storage.
    if (!known) void loadFolders(env.id).then(() => {
      const held = knownInside(env.id, path ?? '~');
      if (held && !answered) { setEntries(held); setLoading(false); }
    });
    listFolder(client, env.id, path ?? '~')
      .then((r) => { answered = true; setEntries(r.entries); setHere(r.path); })
      .catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [client, env.id, path, sendFiles]);

  useEffect(() => { load(); }, [load]);
  // The agent step comes next; ask for its list while the folder is chosen.
  useEffect(() => { if (!sendFiles) prefetchAccounts(client, env.id); }, [client, env.id, sendFiles]);

  // The machine indexes its folders once, so a query answered from memory
  // costs a debounce and a round trip rather than a disk walk per letter.
  const q = query.trim();
  useEffect(() => {
    if (!q) { setHits(null); return; }
    setHits(null);
    let stale = false;
    const t = setTimeout(() => {
      client.rpc(env.id, 'fs.search', { query: q }, 20_000)
        .then((r: any) => { if (!stale) { setHits(r.results ?? []); setIndexed(r.indexed ?? 0); } })
        .catch((e) => { if (!stale) { setHits([]); setError(e.message); } });
    }, 250);
    return () => { stale = true; clearTimeout(t); };
  }, [q, client, env.id]);

  const makeFolder = async () => {
    const name = folder.trim();
    if (!name) return;
    try {
      await client.rpc(env.id, 'fs.mkdir', { path: here, name });
      setFolder(''); setCreating(false); load();
    } catch (e: any) { setError(e.message); }
  };

  return (
    <>
      <div className="bar">
        <button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button>
        <div className="titles"><h1>{title}</h1><span className="sub"><Route machine={env.name} folder={here} full /></span></div>
      </div>
      <div className="scroll"><div className="pad column">
        <button className="primary big" disabled={picking || loading || !!error} onClick={() => pick(here)}>
          {picking ? 'working…' : loading ? 'Loading folders…' : action}
        </button>

        {sendFiles && <details className="send-details"><summary>Use a file or folder path</summary>
          <div className="inline-form"><input aria-label="File or folder on this machine" placeholder={`${here}/name`} value={sendPath}
            autoCapitalize="off" autoCorrect="off" onChange={event => setSendPath(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && sendPath.trim()) void pick(sendPath.trim()); }} />
            <button className="linkish" disabled={picking || !sendPath.trim()} onClick={() => void pick(sendPath.trim())}>Use this path</button></div>
        </details>}
        {onSend && <button className="linkish" disabled={loading || !!error} onClick={() => onSend(here)}>Send this folder</button>}
        <div className="filterbar">
          <input
            className="sheetfilter grow" value={query}
            placeholder={`Search folders on ${env.name}`}
            autoCapitalize="off" autoCorrect="off" autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {q ? (
          <div className="rows">
            {(hits ?? []).map((h) => (
              <button key={h.path} className="row" onClick={() => pick(h.path)}>
                <span className={`glyph${h.repo ? ' repo' : ''}`}><Icon name={h.repo ? 'repo' : 'folder'} size={16} /></span>
                <span className="grow">
                  <span className="rt"><span className="rt-text">{h.name}</span></span>
                  <span className="rm">{h.path}</span>
                </span>
                <span className="chev"><Icon name="forward" size={15} /></span>
              </button>
            ))}
            {hits === null
              ? <div className="empty quiet">searching…</div>
              : !hits.length && <div className="empty quiet">No folders match.{indexed ? ` · ${indexed} folders searched` : ''}</div>}
          </div>
        ) : (
          <>
            {!path && onQuick && (
              <div className="rows">
                <button className="row" onClick={onQuick}>
                  <span className="glyph"><Icon name="bolt" size={16} /></span>
                  <span className="grow">
                    <span className="rt"><span className="rt-text">Start without a folder</span></span>
                    <span className="rm">Ask a question without a project folder.</span>
                  </span>
                  <span className="chev"><Icon name="forward" size={15} /></span>
                </button>
              </div>
            )}
            {/* Only on the way in: once you are browsing, the list on screen
                already says where you are. */}
            {!path && recent.length > 0 && (
              <>
                <div className="section">recent</div>
                <div className="rows">
                  {recent.slice(0, 3).map((p) => (
                    <button key={p} className="row" onClick={() => pick(p)}>
                      <span className="glyph repo"><Icon name="folder" size={16} /></span>
                      <span className="grow">
                        <span className="rt"><span className="rt-text">{shortPath(p)}</span></span>
                        <span className="rm">{p}</span>
                      </span>
                      <span className="chev"><Icon name="forward" size={15} /></span>
                    </button>
                  ))}
                </div>
              </>
            )}

            <div className="section">
              folders<span className="spacer" />
              {!sendFiles && <button className="linkish" onClick={() => setCreating((v) => !v)}>
                {creating ? 'Cancel' : 'New folder'}
              </button>}
            </div>

            {creating && (
              <div className="inline-form">
                <input
                  autoFocus value={folder} placeholder="folder name"
                  onChange={(e) => setFolder(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') makeFolder(); }}
                />
                <button className="send" onClick={makeFolder} disabled={!folder.trim()} aria-label="create folder" title="create folder"><Icon name="arrow-up" size={16} /></button>
              </div>
            )}

            <div className="rows">
              {entries.map((e) => sendFiles ? (
                <div key={e.path} className="row rowx">
                  <button className="rowmain" onClick={() => pick(e.path)}>
                    <span className={`glyph${e.isRepo ? ' repo' : ''}`}><Icon name={e.isRepo ? 'repo' : 'folder'} size={16} /></span>
                    <span className="grow"><span className="rt"><span className="rt-text">{e.name}</span></span></span>
                  </button>
                  <button className="rowend" aria-label={`Browse ${e.name}`} onClick={() => onInto(e.path)}><Icon name="forward" size={15} /></button>
                </div>
              ) : (
                <button key={e.path} className="row" onClick={() => onInto(e.path)}>
                  <span className={`glyph${e.isRepo ? ' repo' : ''}`}><Icon name={e.isRepo ? 'repo' : 'folder'} size={16} /></span>
                  <span className="grow"><span className="rt"><span className="rt-text">{e.name}</span></span></span>
                  <span className="chev"><Icon name="forward" size={15} /></span>
                </button>
              ))}
              {loading ? <div className="empty quiet" role="status">Loading folders…</div> : !entries.length && !error && <div className="empty quiet">This folder has no subfolders.</div>}
            </div>
          </>
        )}
        {error && <><div className="error">{error}</div><button className="linkish" onClick={load}>Retry</button></>}
      </div></div>
    </>
  );
}
