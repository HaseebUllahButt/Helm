import { useDialog } from './useDialog';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { EngineMark } from './EngineMark';
import { Icon } from './Icon';
import type { Client, DirEntry, Environment, Session } from './client';
import { accountsFrom, loadPrefs, rememberFolder, savePrefs, type Account, type PickerPrefs } from './accounts';

/**
 * A new chat without the mouse: machine, then folder, then CLI, in one box.
 *
 * Each step is a list you type into to narrow, move through with the arrows
 * and pick from with Enter. Backspace in an empty box steps back. The folder
 * step is the machine's folders as a tree, starting at home, and nothing else
 * - a new chat never continues an old one. Enter picks a folder, → opens it
 * in place to show the folders inside, ← closes it again. Typing searches
 * every folder on that machine; a result opens with → the same way.
 */

type Step = 'machine' | 'folder' | 'cli';

interface Row {
  id: string;
  title: string;
  sub?: string;
  group?: string;
  engine?: string;
  icon?: 'machine' | 'folder' | 'repo';
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

export function NewChat({ client, envs, envId, initialFolder, near, onFolder, onClose, onStarted, engineOf }: {
  client: Client;
  envs: Environment[];
  /** Start on this machine's folder step instead of asking which machine. */
  envId?: string | null;
  /** A known directory skips the folder step and asks which agent to start. */
  initialFolder?: string;
  /** The machine on screen: asked about first, with the cursor already on it. */
  near?: string | null;
  onFolder?: (envId: string, folder: string) => void;
  onClose: () => void;
  onStarted: (envId: string, s: Session) => void;
  engineOf: (id?: string) => { label: string; cls: string };
}) {
  const dialog = useDialog(onClose);
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const startEnv = envId ? envs.find((e) => e.id === envId && e.online) : undefined;
  const [step, setStep] = useState<Step>(startEnv ? initialFolder ? 'cli' : 'folder' : 'machine');
  const [machine, setMachine] = useState<Environment | null>(startEnv ?? null);
  const [folder, setFolder] = useState(startEnv ? initialFolder ?? '' : '');
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Folder step.
  const [home, setHome] = useState<DirEntry[] | null>(null);
  /** The folders opened with →, by row id; what is inside each, once asked. */
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [inside, setInside] = useState<Record<string, DirEntry[] | null>>({});
  const [hits, setHits] = useState<{ name: string; path: string; repo: boolean }[] | null>(null);

  // CLI step.
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [picker, setPicker] = useState<(PickerPrefs & { onMachine: boolean }) | null>(null);

  const go = (next: Step) => { setStep(next); setQ(''); setAt(0); setError(''); input.current?.focus(); };

  // What a machine offers is asked for the moment it is chosen, so the
  // folder list and the CLI list are usually there before they are needed.
  useEffect(() => {
    if (!machine) return;
    let stale = false;
    setHome(null); setAccounts(null); setPicker(null); setOpened(new Set()); setInside({});
    client.rpc<{ entries: DirEntry[] }>(machine.id, 'fs.list', { path: '~' })
      .then((r) => { if (!stale) setHome(r.entries); }).catch((e) => { if (!stale) { setHome([]); setError(e.message); } });
    client.rpc<any>(machine.id, 'profile.list')
      .then((r) => {
        if (stale) return;
        const local = loadPrefs()[machine.id];
        const prefs: PickerPrefs = r.picker ?? { hidden: local?.hidden ?? [], last: local?.account ?? null };
        setPicker({ ...prefs, onMachine: !!r.picker });
        setAccounts(accountsFrom(r.profiles));
      })
      .catch((e) => { if (!stale) { setAccounts([]); setError(e.message); } });
    return () => { stale = true; };
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

  // Typing in the suggestions searches the whole machine, from its index.
  const query = q.trim();
  const searching = step === 'folder' && !!query;
  useEffect(() => {
    if (!searching || !machine) { setHits(null); return; }
    setHits(null);
    const t = setTimeout(() => {
      client.rpc<any>(machine.id, 'fs.search', { query }, 20_000)
        .then((r) => setHits(r.results ?? []))
        .catch((e) => { setHits([]); setError(e.message); });
    }, 200);
    return () => clearTimeout(t);
  }, [searching, query, client, machine]);

  // Stepping back from the CLIs lands on the same folder in the same list.
  const folderSpot = useRef({ q: '', id: '' });
  const pickFolder = (path: string, id: string) => {
    folderSpot.current = { q, id }; setFolder(path);
    if (machine) onFolder?.(machine.id, path);
    go('cli');
  };

  const start = async (a: Account) => {
    if (!machine || busy) return;
    setBusy(true); setError('');
    rememberFolder(machine.id, folder);
    if (picker?.onMachine) client.rpc(machine.id, 'picker.prefs', { last: a.key }, 15_000).catch(() => { /* only a default */ });
    else {
      const prefs = loadPrefs();
      savePrefs({ ...prefs, [machine.id]: { ...prefs[machine.id], account: a.key } });
    }
    try {
      const r = await client.rpc<{ session: Session }>(machine.id, 'session.start', {
        cwd: folder, profileId: a.profile.id,
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
        pick: () => { if (machine?.id !== e.id) setMachine(e); go('folder'); },
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
  }, [step, envs, machine, query, opened, inside, searching, hits, home, accounts, picker, folder, busy]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const move = (by: number) => {
    if (!rows.length) return;
    let i = selected;
    for (let n = 0; n < rows.length; n++) {
      i = (i + by + rows.length) % rows.length;
      if (!rows[i].disabled) break;
    }
    setAt(i);
  };
  const back = () => {
    setError('');
    if (step === 'cli') { go('folder'); setQ(folderSpot.current.q); returning.current = folderSpot.current.id; }
    else if (step === 'folder') go('machine');
  };
  // → opens a folder, or steps into one already open; ← closes it, or steps
  // out to the folder it is in - the way every file tree answers the arrows.
  const right = (row: Row) => {
    const f = row.folder!;
    if (!f.open) { expand(f.path, row.id); return; }
    const next = rows[selected + 1];
    if (next?.folder?.parent === row.id && !next.disabled) setAt(selected + 1);
  };
  const left = (row: Row) => {
    const f = row.folder!;
    if (f.open) { collapse(row.id); return; }
    const up = rows.findIndex((r) => r.id === f.parent);
    if (up >= 0) { collapse(f.parent!); setAt(up); }
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
            <span className={step === 'folder' ? 'on' : ''}>{step === 'cli' ? leaf(folder) : 'Folder'}</span>
            <Icon name="forward" size={12} />
            <span className={step === 'cli' ? 'on' : ''}>CLI</span>
          </span>
          <button className="iconbtn" onClick={onClose} aria-label="Close new chat" title="Close"><Icon name="close" size={16} /></button>
        </div>
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
          {busy && <div className="empty quiet">Starting {rows[selected]?.title} in {leaf(folder)}…</div>}
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
                      onClick={() => { setAt(i); if (row.folder!.open) collapse(row.id); else expand(row.folder!.path, row.id); }}
                    ><Icon name="forward" size={14} /></button>
                  ))}
                  <button
                    role="option" id={`${listId}-${i}`} tabIndex={-1} aria-selected={i === selected}
                    aria-disabled={row.disabled || undefined} disabled={row.disabled}
                    aria-expanded={row.folder && !row.disabled ? row.folder.open : undefined}
                    className={`palette-row${i === selected ? ' on' : ''}`}
                    onMouseMove={() => setAt(i)} onClick={() => row.pick()}
                  >
                    {row.engine ? <EngineMark engine={engineOf(row.engine).cls} />
                      : !row.disabled && <span className="pglyph"><Icon name={row.icon ?? 'folder'} size={15} /></span>}
                    <span className="grow">
                      <span className="palette-title">{row.title}{row.tag && <span className="tag">{row.tag}</span>}</span>
                      {row.sub && <span className="palette-sub">{row.sub}</span>}
                    </span>
                  </button>
                </div>
              </div>
            );
          })}
          {error && <div className="error">{error}</div>}
        </div>
        <div className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>Enter</kbd> {step === 'cli' ? 'start' : 'choose'}</span>
          {step === 'folder' && <span><kbd>→</kbd><kbd>←</kbd> open, close</span>}
          {step !== 'machine' && !busy && <span><kbd>⌫</kbd> back</span>}
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
