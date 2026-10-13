import { useDialog } from './useDialog';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { EngineMark } from './EngineMark';
import { Icon } from './Icon';
import type { Client, DirEntry, Environment, Session } from './client';
import { watchAccounts } from './accountsCache';
import { accountsFrom, loadPrefs, rememberFolder, savePrefs, type Account, type PickerPrefs } from './accounts';
import { fetchFolders, loadFolders, rememberFolderMade, searchFolders, type FolderIndex } from './folderIndex';

/**
 * A new chat without the mouse: machine, then folder, then CLI, in one box.
 *
 * Each step is a list you type into to narrow, move through with the arrows
 * and pick from with Enter. Backspace in an empty box steps back. The folder
 * step is the machine's folders as a tree, starting at home, and nothing else
 * - a new chat never continues an old one. Enter picks a folder, → opens it
 * in place to show the folders inside, ← closes it again. Typing searches
 * every folder on that machine; a result opens with → the same way.
 *
 * Two rows are not folders. "No folder · quick chat" sits first: a chat for
 * a small question that belongs to no project (Ctrl/Cmd+Enter). And when the
 * typed text is not a folder there already, the last row makes it, inside
 * the folder the cursor was last on (Ctrl/Cmd+Shift+Enter), and picks it.
 * The same is always a tap away below the list - "New folder in …", aimed
 * at the folder the cursor is in - and on each folder row as a +.
 *
 * Search runs on the device, over the machine's folder list fetched when the
 * machine is chosen (see folderIndex.ts); a machine too old to send one is
 * asked per search instead.
 */

type Step = 'machine' | 'folder' | 'cli';

const QUICK_ROW = ':quick';
const NEW_ROW = ':new-folder';
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

interface Row {
  id: string;
  title: string;
  sub?: string;
  group?: string;
  engine?: string;
  icon?: 'machine' | 'folder' | 'repo' | 'bolt' | 'plus';
  tag?: string;
  disabled?: boolean;
  /** A folder: how deep in the tree, and whether it is opened. */
  folder?: { path: string; depth: number; open: boolean; parent?: string };
  pick: () => void;
}

/** Every typed word has to be found somewhere in the row. */
const matches = (row: Row, q: string) => {
  const hay = `${row.title} ${row.sub ?? ''}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
};

const leaf = (p: string) => p.replace(/\/$/, '').split('/').pop() || p;
/** The folder a path is in: "~/dev/helm" -> "~/dev", "~/dev" -> "~". */
const up = (p: string) => p.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || (p.startsWith('/') ? '/' : '~');
const join = (dir: string, name: string) => `${dir.replace(/\/+$/, '')}/${name}`;
const where = (p: string) => (p === '~' ? 'home' : leaf(p));
const checked = (at: number, now: number) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 10 ? 'just now' : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

export function NewChat({ client, envs, envId, initialFolder, quick: startQuick = false, near, onFolder, onClose, onStarted, engineOf }: {
  client: Client;
  envs: Environment[];
  /** Start on this machine's folder step instead of asking which machine. */
  envId?: string | null;
  /** A known directory skips the folder step and asks which agent to start. */
  initialFolder?: string;
  /** A chat with no folder: the folder step is skipped once there is a machine. */
  quick?: boolean;
  /** The machine on screen: asked about first, with the cursor already on it. */
  near?: string | null;
  onFolder?: (envId: string, folder: string) => void;
  onClose: () => void;
  onStarted: (envId: string, s: Session) => void;
  engineOf: (id?: string) => { label: string; cls: string };
}) {
  // Esc puts away the "New folder" box first, the picker after.
  const dialog = useDialog(() => {
    if (creatingNow.current) { setCreating(null); input.current?.focus(); } else onClose();
  });
  const creatingNow = useRef(false);
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const startEnv = envId ? envs.find((e) => e.id === envId && e.online) : undefined;
  const [step, setStep] = useState<Step>(startEnv ? initialFolder || startQuick ? 'cli' : 'folder' : 'machine');
  const [machine, setMachine] = useState<Environment | null>(startEnv ?? null);
  const [folder, setFolder] = useState(startEnv && !startQuick ? initialFolder ?? '' : '');
  /** No folder: the CLI step starts a quick chat. */
  const [quick, setQuick] = useState(startQuick);
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Folder step.
  const [home, setHome] = useState<DirEntry[] | null>(null);
  /** The folders opened with →, by row id; what is inside each, once asked. */
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [inside, setInside] = useState<Record<string, DirEntry[] | null>>({});
  const [remoteHits, setRemoteHits] = useState<{ name: string; path: string; repo: boolean }[] | null>(null);
  /** The machine's folders, searched here; null until known, 'remote' on a machine that cannot send them. */
  const [index, setIndex] = useState<FolderIndex | null | 'remote'>(null);
  const [indexing, setIndexing] = useState(false);
  /** The "New folder" box below the list: where it goes, and the name typed. */
  const [creating, setCreating] = useState<{ parent: string; name: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  creatingNow.current = !!creating;
  /**
   * The folder row the cursor was last moved to, which says where a new
   * folder goes. Typing resets the cursor to the first search hit, so only a
   * move made on purpose (arrows, mouse) changes it.
   */
  const [anchor, setAnchor] = useState<{ id: string; path: string } | null>(null);

  // CLI step.
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [picker, setPicker] = useState<(PickerPrefs & { onMachine: boolean }) | null>(null);

  const go = (next: Step) => { setStep(next); setQ(''); setAt(0); setError(''); input.current?.focus(); };

  // What a machine offers is asked for the moment it is chosen, so the
  // folder list and the CLI list are usually there before they are needed.
  useEffect(() => {
    if (!machine) return;
    let stale = false;
    setHome(null); setAccounts(null); setPicker(null); setOpened(new Set()); setInside({}); setAnchor(null);
    setIndex(null); setCreating(null);
    client.rpc<{ entries: DirEntry[] }>(machine.id, 'fs.list', { path: '~' })
      .then((r) => { if (!stale) setHome(r.entries); }).catch((e) => { if (!stale) { setHome([]); setError(e.message); } });
    // The folders this device remembers first, then the machine's own list
    // as it is now: it looks at its disk again when asked.
    void loadFolders(machine.id).then((held) => { if (!stale && held) setIndex((now) => now ?? held); });
    setIndexing(true);
    fetchFolders(client, machine.id)
      .then((fresh) => { if (!stale) { setIndex(fresh); setNow(Date.now()); } })
      .catch(() => { if (!stale) setIndex((now) => now ?? 'remote'); })
      .finally(() => { if (!stale) setIndexing(false); });
    // The remembered list first, so the agent step never waits on a slow
    // machine; the machine's own answer replaces it when it lands.
    const stop = watchAccounts(client, machine.id, (r) => {
      if (stale) return;
      const local = loadPrefs()[machine.id];
      const prefs: PickerPrefs = r.picker ?? { hidden: local?.hidden ?? [], last: local?.account ?? null };
      setPicker({ ...prefs, onMachine: !!r.picker });
      setAccounts(accountsFrom(r.profiles));
    }, (message) => { if (!stale) { setAccounts((now) => now ?? []); setError(message); } });
    return () => { stale = true; stop(); };
  }, [client, machine]);

  const expand = (path: string, id: string) => {
    setOpened((all) => new Set(all).add(id));
    if (!machine || path in inside) return;
    setInside((all) => ({ ...all, [path]: null }));
    client.rpc<{ entries: DirEntry[] }>(machine.id, 'fs.list', { path })
      .then((r) => setInside((all) => ({ ...all, [path]: r.entries })))
      .catch((e) => { setInside((all) => ({ ...all, [path]: [] })); setError(e.message); });
  };
  const collapse = (id: string) => setOpened((all) => {
    // Closing a folder closes everything opened inside it too.
    const next = new Set([...all].filter((o) => o !== id && !o.startsWith(`${id}>`)));
    return next;
  });

  // Typing in the suggestions searches the whole machine: here, from its
  // folder list, or - on a machine that cannot send one - by asking it.
  const query = q.trim();
  const searching = step === 'folder' && !!query;
  const remote = index === 'remote';
  useEffect(() => {
    if (!searching || !machine || !remote) { setRemoteHits(null); return; }
    let stale = false;
    const t = setTimeout(() => {
      client.rpc<any>(machine.id, 'fs.search', { query }, 20_000)
        .then((r) => { if (!stale) setRemoteHits(r.results ?? []); })
        .catch((e) => { if (!stale) { setRemoteHits([]); setError(e.message); } });
    }, 120);
    return () => { stale = true; clearTimeout(t); };
  }, [searching, query, client, machine, remote]);
  const localHits = useMemo(() => (searching && index && index !== 'remote' ? searchFolders(index.folders, query) : null),
    [searching, query, index]);
  const hits = remote ? remoteHits : localHits;

  const refreshFolders = () => {
    if (!machine || indexing) return;
    const id = machine.id;
    setIndexing(true);
    fetchFolders(client, id, { refresh: true })
      .then((fresh) => { if (machine?.id === id) { setIndex(fresh); setNow(Date.now()); } })
      .catch((e) => setError(e.message))
      .finally(() => setIndexing(false));
  };
  // "checked 20s ago" keeps counting while the picker is open.
  useEffect(() => {
    if (step !== 'folder') return;
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, [step]);

  // Stepping back from the CLIs lands on the same folder in the same list.
  const folderSpot = useRef({ q: '', id: '' });
  const pickFolder = (path: string, id: string) => {
    folderSpot.current = { q, id }; setFolder(path); setQuick(false);
    if (machine) onFolder?.(machine.id, path);
    go('cli');
  };
  const pickQuick = () => {
    folderSpot.current = { q, id: QUICK_ROW }; setFolder(''); setQuick(true);
    go('cli');
  };

  // A new folder goes inside the folder the cursor is on when that one is
  // opened, and beside it otherwise - the way a file tree reads. Home when
  // the cursor has not been anywhere yet.
  const newParent = !anchor ? '~' : opened.has(anchor.id) ? anchor.path : up(anchor.path);
  const newPath = join(newParent, query);
  const makeFolder = async (parent = newParent, name = query) => {
    name = name.trim();
    if (!machine || busy || !name) return;
    setBusy(true); setError('');
    try {
      // The machine checks the name (one segment, no "..") and says why not.
      const r = await client.rpc<{ path: string }>(machine.id, 'fs.mkdir', { path: parent, name }, 20_000);
      // The lists already fetched learn it too, so it is there on the way back.
      const entry: DirEntry = { name: leaf(r.path), path: r.path, isRepo: false, skip: false };
      const add = (list: DirEntry[]) => [...list.filter((e) => e.path !== r.path), entry].sort((a, b) => a.name.localeCompare(b.name));
      if (parent === '~') setHome((h) => (h ? add(h) : h));
      setInside((all) => (all[parent] ? { ...all, [parent]: add(all[parent]!) } : all));
      rememberFolderMade(machine.id, { name: entry.name, path: r.path, repo: false });
      setBusy(false); setCreating(null);
      pickFolder(r.path, r.path);
    } catch (e: any) { setError(e.message); setBusy(false); }
  };
  /** Open the "New folder" box, aimed inside `parent`. */
  const createIn = (parent: string) => { setError(''); setCreating({ parent, name: '' }); };

  // The box is disabled while the machine works, which drops the cursor out
  // of it; it goes back once there is something to type again.
  useEffect(() => { if (!busy) input.current?.focus(); }, [busy]);

  const start = async (a: Account) => {
    if (!machine || busy) return;
    setBusy(true); setError('');
    if (!quick) rememberFolder(machine.id, folder);
    if (picker?.onMachine) client.rpc(machine.id, 'picker.prefs', { last: a.key }, 15_000).catch(() => { /* only a default */ });
    else {
      const prefs = loadPrefs();
      savePrefs({ ...prefs, [machine.id]: { ...prefs[machine.id], account: a.key } });
    }
    try {
      const r = await client.rpc<{ session: Session }>(machine.id, 'session.start', {
        ...(quick ? { quick: true } : { cwd: folder }), profileId: a.profile.id,
        model: a.prefs?.default || undefined,
        effort: a.defaults?.effort || undefined,
        mode: a.defaults?.mode && a.defaults.mode !== 'plan' ? a.defaults.mode : undefined,
        speed: a.defaults?.speed || undefined,
      }, 70_000);
      onClose();
      onStarted(machine.id, r.session);
    } catch (e: any) { setError(e.message); setBusy(false); }
  };

  const rows = useMemo((): Row[] => {
    if (step === 'machine') {
      const all = envs.map((e): Row => ({
        id: e.id, title: e.name, icon: 'machine', sub: e.online ? 'online' : 'offline', disabled: !e.online,
        pick: () => { if (machine?.id !== e.id) setMachine(e); go(quick ? 'cli' : 'folder'); },
      }));
      // Online first; offline ones stay visible so a missing machine is explained.
      return all.filter((r) => matches(r, query)).sort((a, b) => Number(!!a.disabled) - Number(!!b.disabled));
    }
    if (step === 'folder') {
      // A row's id is its place in the tree - "~/dev>helm>apps" - which can
      // never equal a top-level folder's own path, "~/dev/helm/apps".
      const out: Row[] = [];
      const add = (path: string, title: string, repo: boolean, depth: number, parent?: string, sub?: string) => {
        const id = parent ? `${parent}>${title}` : path;
        const open = opened.has(id);
        out.push({ id, title, sub, icon: repo ? 'repo' : 'folder', folder: { path, depth, open, parent }, pick: () => pickFolder(path, id) });
        if (!open) return;
        const kids = inside[path];
        if (kids === null || kids === undefined) out.push({ id: `${id}>…`, title: 'looking…', disabled: true, folder: { path, depth: depth + 1, open: false, parent: id }, pick: () => {} });
        else if (!kids.length) out.push({ id: `${id}>…`, title: 'no folders inside', disabled: true, folder: { path, depth: depth + 1, open: false, parent: id }, pick: () => {} });
        else for (const k of kids) add(k.path, k.name, k.isRepo, depth + 1, id);
      };
      if (searching) {
        // A hit inside another hit is one → away from it; listing both is
        // the same folder twice.
        const all = hits ?? [];
        for (const h of all) {
          if (all.some((o) => o !== h && h.path.startsWith(`${o.path.replace(/\/$/, '')}/`))) continue;
          add(h.path, h.name, h.repo, 0, undefined, h.path);
        }
      }
      else for (const e of home ?? []) add(e.path, e.name, e.isRepo, 0);
      const quickRow: Row = { id: QUICK_ROW, title: 'No folder · quick chat', sub: 'a small question, in no folder', icon: 'bolt', pick: pickQuick };
      if (!query || matches(quickRow, query)) out.unshift(quickRow);
      // Offered once the typed name is not a folder that is already there.
      const known = [...(hits ?? []), ...(home ?? []), ...(inside[newParent] ?? [])];
      if (query && (!searching || hits !== null) && !known.some((f) => f.path === newPath)) {
        out.push({ id: NEW_ROW, title: `New folder "${query}" in ${where(newParent)}`, sub: newPath, icon: 'plus', pick: () => void makeFolder() });
      }
      return out;
    }
    const hidden = new Set(picker?.hidden ?? []);
    const shown = (accounts ?? []).filter((a) => !hidden.has(a.key));
    const twins = new Set(shown.map((a) => `${a.engine}|${a.account}`).filter((k, i, all) => all.indexOf(k) !== i));
    // The machine's chosen default first, then the last one used, so Enter
    // straight away starts what you would have picked.
    const first = shown.find((a) => a.key === picker?.agent) ?? shown.find((a) => a.key === picker?.last);
    const ordered = first ? [first, ...shown.filter((a) => a !== first)] : shown;
    return ordered.map((a): Row => ({
      id: a.key, engine: a.engine, title: engineOf(a.engine).label,
      sub: twins.has(`${a.engine}|${a.account}`) ? `${a.account} (${a.profile.id})` : a.account,
      tag: a.key === picker?.agent ? 'default' : a.key === picker?.last ? 'last used' : undefined,
      pick: () => void start(a),
    })).filter((r) => matches(r, query));
  }, [step, envs, machine, query, opened, inside, searching, hits, home, accounts, picker, folder, quick, anchor, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  // Where "New folder" puts it: inside the folder the cursor is on when that
  // one is open, beside it otherwise.
  const cursorRow = rows[Math.max(0, Math.min(at, rows.length - 1))];
  const createTarget = step !== 'folder' ? '~'
    : cursorRow?.folder && !cursorRow.disabled ? (cursorRow.folder.open ? cursorRow.folder.path : up(cursorRow.folder.path))
    : newParent;

  // On the machine step the one you are on is where the cursor starts.
  useEffect(() => {
    if (step !== 'machine' || query) return;
    const i = rows.findIndex((r) => r.id === (machine?.id ?? near) && !r.disabled);
    setAt(i >= 0 ? i : 0);
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back from the CLIs: put the cursor on the folder that was picked, once
  // its list is on screen again.
  const returning = useRef('');
  useEffect(() => {
    if (step !== 'folder' || !returning.current) return;
    const i = rows.findIndex((r) => r.id === returning.current);
    if (i >= 0) { setAt(i); returning.current = ''; }
  }, [step, rows]);

  const selected = Math.max(0, Math.min(at, rows.length - 1));
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, rows]);

  /** Put the cursor on a row on purpose: a folder row there becomes the anchor. */
  const point = (i: number) => {
    setAt(i);
    const f = rows[i]?.folder;
    if (f && !rows[i].disabled) setAnchor({ id: rows[i].id, path: f.path });
  };
  const move = (by: number) => {
    if (!rows.length) return;
    let i = selected;
    for (let n = 0; n < rows.length; n++) {
      i = (i + by + rows.length) % rows.length;
      if (!rows[i].disabled) break;
    }
    point(i);
  };
  const back = () => {
    setError('');
    if (step === 'cli') { go('folder'); setQuick(false); setQ(folderSpot.current.q); returning.current = folderSpot.current.id; }
    else if (step === 'folder') go('machine');
  };
  // → opens a folder, or steps into one already open; ← closes it, or steps
  // out to the folder it is in - the way every file tree answers the arrows.
  const right = (row: Row) => {
    const f = row.folder!;
    if (!f.open) { expand(f.path, row.id); setAnchor({ id: row.id, path: f.path }); return; }
    const next = rows[selected + 1];
    if (next?.folder?.parent === row.id && !next.disabled) point(selected + 1);
  };
  const left = (row: Row) => {
    const f = row.folder!;
    if (f.open) { collapse(row.id); return; }
    const outer = rows.findIndex((r) => r.id === f.parent);
    if (outer >= 0) { collapse(f.parent!); point(outer); }
  };

  const loading = step === 'folder'
    ? (searching ? hits === null : home === null)
    : step === 'cli' ? accounts === null : false;
  const placeholder = step === 'machine' ? 'Which machine?'
    : step === 'folder' ? `Which folder on ${machine?.name}?`
    : 'Which CLI?';

  return (
    <div className="modal-back palette-back" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette-box newchat" role="dialog" aria-modal="true" aria-label="New chat" ref={dialog} tabIndex={-1}>
        <div className="palette-heading">
          <span className="newchat-steps">
            <span className={step === 'machine' ? 'on' : ''}>{machine?.name ?? 'Machine'}</span>
            <Icon name="forward" size={12} />
            <span className={step === 'folder' ? 'on' : ''}>{step === 'cli' ? quick ? 'Quick chat' : leaf(folder) : 'Folder'}</span>
            <Icon name="forward" size={12} />
            <span className={step === 'cli' ? 'on' : ''}>CLI</span>
          </span>
          <button className="iconbtn" onClick={onClose} aria-label="Close new chat" title="Close"><Icon name="close" size={16} /></button>
        </div>
        {/* The same question an empty chat asks, one step at a time. */}
        <h2 className="newchat-greeting">
          {step === 'machine' ? 'Where should we build?'
            : step === 'folder' ? <>What should we build on <b>{machine?.name}</b>?</>
            : quick ? <>Which agent for a <b>quick chat</b>?</>
            : <>Which agent in <b>{leaf(folder)}</b>?</>}
        </h2>
        <input
          ref={input} className="palette-input" value={q} placeholder={placeholder} disabled={busy}
          autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
          role="combobox" aria-label={placeholder}
          aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={rows.length ? `${listId}-${selected}` : undefined}
          onChange={(e) => { setQ(e.target.value); setAt(0); }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            const row = rows[selected];
            // With Ctrl/Cmd, Enter is about the folder step's own two rows:
            // no folder at all, or a new one with the typed name.
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && step !== 'cli') {
              e.preventDefault();
              if (step !== 'folder' || busy) return;
              if (e.shiftKey) void makeFolder(); else pickQuick();
              return;
            }
            if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
            else if (e.key === 'Enter') { e.preventDefault(); if (row && !row.disabled) row.pick(); }
            // In the folder tree the side arrows belong to the tree, even
            // with a search typed: nobody edits a folder name mid-word here.
            else if (e.key === 'ArrowRight' && row?.folder) { e.preventDefault(); right(row); }
            else if (e.key === 'ArrowLeft' && row?.folder) { e.preventDefault(); left(row); }
            else if ((e.key === 'Backspace' || (e.key === 'ArrowLeft' && step !== 'folder')) && !q) { e.preventDefault(); back(); }
          }}
        />
        <div className="palette-list" ref={list} role="listbox" id={listId} aria-label={placeholder}>
          {busy && <div className="empty quiet">{step === 'folder' ? `Making ${newPath}…` : quick ? `Starting ${rows[selected]?.title} as a quick chat…` : `Starting ${rows[selected]?.title} in ${leaf(folder)}…`}</div>}
          {!busy && loading && !rows.length && <div className="empty quiet">{step === 'cli' ? 'looking for CLIs…' : 'looking…'}</div>}
          {!busy && !loading && !rows.length && (
            <div className="empty quiet">
              {step === 'machine' ? 'No machine matches.' : step === 'folder' ? (searching ? 'No folder matches.' : 'No folders here.') : 'No CLI matches.'}
            </div>
          )}
          {!busy && rows.map((row, i) => {
            const head = row.group && (i === 0 || rows[i - 1].group !== row.group);
            return (
              <div key={row.id}>
                {head && <div className="palette-group">{row.group}</div>}
                <div className={`newchat-row${row.folder ? ' tree' : ''}`} style={row.folder ? { paddingLeft: row.folder.depth * 22 } : undefined}>
                  {row.folder && (row.disabled ? <span className="newchat-twisty" /> : (
                    <button
                      className={`newchat-twisty${row.folder.open ? ' open' : ''}`} tabIndex={-1}
                      title={row.folder.open ? `close ${row.title}` : `open ${row.title}`}
                      aria-label={row.folder.open ? `close ${row.title}` : `open ${row.title}`}
                      onClick={() => { point(i); if (row.folder!.open) collapse(row.id); else expand(row.folder!.path, row.id); }}
                    ><Icon name="forward" size={14} /></button>
                  ))}
                  <button
                    role="option" id={`${listId}-${i}`} tabIndex={-1} aria-selected={i === selected}
                    aria-disabled={row.disabled || undefined} disabled={row.disabled}
                    aria-expanded={row.folder && !row.disabled ? row.folder.open : undefined}
                    className={`palette-row${i === selected ? ' on' : ''}`}
                    onMouseMove={() => { if (i !== selected) point(i); }} onClick={() => row.pick()}
                  >
                    {row.engine ? <EngineMark engine={engineOf(row.engine).cls} />
                      : !row.disabled && <span className="pglyph"><Icon name={row.icon ?? 'folder'} size={15} /></span>}
                    <span className="grow">
                      <span className="palette-title">{row.title}{row.tag && <span className="tag">{row.tag}</span>}</span>
                      {row.sub && <span className="palette-sub">{row.sub}</span>}
                    </span>
                  </button>
                  {row.folder && !row.disabled && (
                    <button
                      className="newchat-add" tabIndex={-1} title={`New folder inside ${row.title}`} aria-label={`New folder inside ${row.title}`}
                      onClick={() => { point(i); if (!row.folder!.open) expand(row.folder!.path, row.id); createIn(row.folder!.path); }}
                    ><Icon name="plus" size={14} /></button>
                  )}
                </div>
              </div>
            );
          })}
          {error && <div className="error">{error}</div>}
        </div>
        {step === 'folder' && machine && (creating ? (
          <form className="newchat-bar creating" onSubmit={(e) => { e.preventDefault(); void makeFolder(creating.parent, creating.name); }}>
            <span className="pglyph"><Icon name="plus" size={15} /></span>
            <label className="newchat-create">
              <span className="newchat-where" title={creating.parent}>New folder in <b>{where(creating.parent)}</b></span>
              <input
                autoFocus value={creating.name} placeholder="Folder name" aria-label={`New folder name, in ${creating.parent}`} disabled={busy}
                autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
                onChange={(e) => setCreating({ ...creating, name: e.target.value })}
              />
            </label>
            <button type="submit" className="primary" disabled={busy || !creating.name.trim()}>{busy ? 'Making…' : 'Create'}</button>
            <button type="button" className="ghost" disabled={busy} onClick={() => { setCreating(null); input.current?.focus(); }}>Cancel</button>
          </form>
        ) : (
          <div className="newchat-bar">
            <button type="button" className="newchat-new" onClick={() => createIn(createTarget)} title={`New folder in ${createTarget}`}>
              <Icon name="plus" size={15} />New folder in <b>{where(createTarget)}</b>
            </button>
            <span className="newchat-index" role="status">
              {index && index !== 'remote' ? <>{index.count.toLocaleString()} folders · {indexing ? 'checking…' : `checked ${checked(index.at, now)}`}</>
                : remote ? 'searching on the machine' : 'reading folders…'}
            </span>
            {!remote && <button type="button" className="iconbtn newchat-refresh" onClick={refreshFolders} disabled={indexing}
              title="Look for new folders now" aria-label="Look for new folders now"><Icon name="refresh" size={15} /></button>}
          </div>
        ))}
        <div className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>Enter</kbd> {step === 'cli' ? 'start' : 'choose'}</span>
          {step === 'folder' && <span><kbd>→</kbd><kbd>←</kbd> open, close</span>}
          {step === 'folder' && <span><kbd>{MOD}</kbd><kbd>Enter</kbd> quick chat</span>}
          {step === 'folder' && query && <span><kbd>{MOD}</kbd><kbd>Shift</kbd><kbd>Enter</kbd> new folder</span>}
          {step !== 'machine' && !busy && <span><kbd>⌫</kbd> back</span>}
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
